import Foundation
import CoreMedia
import CoreImage
import ImageIO
import VideoToolbox
import ScreenCaptureKit

// 帧协议（stdout）：[payloadLength(4)][captureMs(8)][encodeMs(4)][flags(1)][payload]
// captureMs 为 Unix 毫秒（采集回调入口打点），客户端据此估算端到端延迟；
// flags bit0 = 关键帧（仅 h264 模式使用，jpeg 模式恒为 0）。

private final class FrameWriter: @unchecked Sendable {
    static let shared = FrameWriter()
    private let lock = NSLock()
    private var encoded = 0
    private var encodeMsTotal = 0.0

    func write(captureMs: UInt64, encodeMs: UInt32, flags: UInt8, payload: Data) {
        lock.lock()
        var length = UInt32(payload.count).bigEndian
        var ts = captureMs.bigEndian
        var enc = encodeMs.bigEndian
        var out = Data(capacity: 17 + payload.count)
        out.append(Data(bytes: &length, count: 4))
        out.append(Data(bytes: &ts, count: 8))
        out.append(Data(bytes: &enc, count: 4))
        out.append(flags)
        out.append(payload)
        FileHandle.standardOutput.write(out)
        encoded += 1
        encodeMsTotal += Double(encodeMs)
        if encoded % 300 == 0 {
            FileHandle.standardError.write(Data(String(format: "MirrorCapture: %d frames, avg encode %.0fms\n", encoded, encodeMsTotal / 300).utf8))
            encodeMsTotal = 0
        }
        lock.unlock()
    }
}

// 每帧元数据：通过 sourceFrameRefcon 跟随编码调用传到输出回调，
// 即使编码器丢帧/拒帧也能精确配对采集时间，不依赖先进先出假设。
private final class FrameMeta {
    let captureMs: UInt64
    let submitted: CFAbsoluteTime
    init(captureMs: UInt64, submitted: CFAbsoluteTime) {
        self.captureMs = captureMs
        self.submitted = submitted
    }
}

// VideoToolbox 硬件 H.264 编码：实时模式、无 B 帧（不重排），
// 关键帧前重复 SPS/PPS（Annex B 解码器靠它们完成配置与重配置）。
final class H264Encoder {
    private var session: VTCompressionSession?

    init(width: Int, height: Int, bitrateKbps: Int, fps: Int) throws {
        var created: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: nil,
            width: Int32(width),
            height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: [kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true] as CFDictionary,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: { refcon, sourceFrameRefcon, status, _, sampleBuffer in
                guard let refcon else { return }
                // refcon 生命周期与编码调用绑定：无论成败都必须取回释放
                var meta: FrameMeta?
                if let sourceFrameRefcon { meta = Unmanaged<FrameMeta>.fromOpaque(sourceFrameRefcon).takeRetainedValue() }
                guard status == noErr, let sampleBuffer, let meta else { return }
                Unmanaged<H264Encoder>.fromOpaque(refcon).takeUnretainedValue().handleOutput(sampleBuffer, meta: meta)
            },
            refcon: Unmanaged.passUnretained(self).toOpaque(),
            compressionSessionOut: &created
        )
        guard status == noErr, let created else {
            throw NSError(domain: "MirrorCapture", code: 4, userInfo: [NSLocalizedDescriptionKey: "VTCompressionSessionCreate failed: \(status)"])
        }
        session = created
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        // Baseline 档次不支持 B 帧：解码端不会为重排缓冲而扣住已解码帧，
        // 低帧率/静态画面下也能立即输出（High 档次下 VT 解码器重排缓冲会造成数秒延迟）。
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Baseline_AutoLevel)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_MaxFrameDelayCount, value: NSNumber(value: 0))
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: NSNumber(value: fps * 2))
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: fps))
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: bitrateKbps * 1000))
        VTCompressionSessionPrepareToEncodeFrames(created)
    }

    func encode(_ imageBuffer: CVPixelBuffer, pts: CMTime, duration: CMTime, captureMs: UInt64) {
        guard let session else { return }
        let meta = Unmanaged.passRetained(FrameMeta(captureMs: captureMs, submitted: CFAbsoluteTimeGetCurrent())).toOpaque()
        let status = VTCompressionSessionEncodeFrame(session, imageBuffer: imageBuffer, presentationTimeStamp: pts, duration: duration, frameProperties: nil, sourceFrameRefcon: meta, infoFlagsOut: nil)
        if status != noErr { Unmanaged<FrameMeta>.fromOpaque(meta).release() }
    }

    private func handleOutput(_ sampleBuffer: CMSampleBuffer, meta: FrameMeta) {
        let encodeMs = UInt32((CFAbsoluteTimeGetCurrent() - meta.submitted) * 1000)
        guard let payload = annexBPayload(sampleBuffer) else { return }
        FrameWriter.shared.write(captureMs: meta.captureMs, encodeMs: encodeMs, flags: isKeyframe(sampleBuffer) ? 1 : 0, payload: payload)
    }

    private func isKeyframe(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [NSDictionary], let first = attachments.first else { return true }
        return !(first[kCMSampleAttachmentKey_NotSync as String] as? Bool ?? false)
    }

    private func annexBPayload(_ sampleBuffer: CMSampleBuffer) -> Data? {
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return nil }
        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(blockBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &totalLength, dataPointerOut: &dataPointer) == kCMBlockBufferNoErr, let dataPointer else { return nil }
        let startCode: [UInt8] = [0, 0, 0, 1]
        var out = Data()
        if isKeyframe(sampleBuffer), let desc = CMSampleBufferGetFormatDescription(sampleBuffer) {
            for index in 0..<2 {
                var setLength = 0
                var setPointer: UnsafePointer<UInt8>?
                if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(desc, parameterSetIndex: index, parameterSetPointerOut: &setPointer, parameterSetSizeOut: &setLength, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let setPointer {
                    out.append(contentsOf: startCode)
                    out.append(setPointer, count: setLength)
                }
            }
        }
        var offset = 0
        while offset + 4 <= totalLength {
            var nalLength: UInt32 = 0
            memcpy(&nalLength, dataPointer + offset, 4)
            nalLength = CFSwapInt32BigToHost(nalLength)
            offset += 4
            guard nalLength > 0, offset + Int(nalLength) <= totalLength else { break }
            out.append(contentsOf: startCode)
            out.append(Data(bytes: dataPointer + offset, count: Int(nalLength)))
            offset += Int(nalLength)
        }
        return out.isEmpty ? nil : out
    }
}

final class Capture: NSObject, SCStreamOutput {
    let stream: SCStream
    let context = CIContext()
    let jpegQuality: Double
    let h264: H264Encoder?

    init(displayID: CGDirectDisplayID, content: SCShareableContent, jpegQuality: Double, maxPixelWidth: Int?, codec: String, bitrateKbps: Int) throws {
        self.jpegQuality = jpegQuality
        guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
            throw NSError(domain: "MirrorCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "Display \(displayID) not found in ScreenCaptureKit shareable content"])
        }
        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let config = SCStreamConfiguration()
        // 按帧缓冲物理像素采集，保留 HiDPI（Retina）细节；逻辑分辨率会在客户端放大时发虚。
        // 带宽受限时可用 maxPixelWidth 等比降采样。
        let mode = CGDisplayCopyDisplayMode(display.displayID)
        var pixelWidth = mode?.pixelWidth ?? display.width
        var pixelHeight = mode?.pixelHeight ?? display.height
        if let maxPixelWidth, maxPixelWidth > 0, pixelWidth > maxPixelWidth {
            pixelHeight = pixelHeight * maxPixelWidth / pixelWidth
            pixelWidth = maxPixelWidth
        }
        config.width = pixelWidth
        config.height = pixelHeight
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.queueDepth = 5
        config.pixelFormat = kCVPixelFormatType_32BGRA
        h264 = codec == "h264" ? try H264Encoder(width: pixelWidth, height: pixelHeight, bitrateKbps: bitrateKbps, fps: 30) : nil
        stream = SCStream(filter: filter, configuration: config, delegate: nil)
        super.init()
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "capture.frames"))
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        // 串行队列上的帧计数：编码比采集慢时队列会积压，FIFO 会导致每帧都延迟 queueDepth 帧。
        // 只编码"身后没有更新帧排队"的帧，丢弃过期帧，把延迟收敛到一次编码耗时以内。
        queued += 1
        defer { queued -= 1 }
        guard queued == 1, type == .screen, let buffer = sampleBuffer.imageBuffer else { return }
        let captureMs = UInt64(Date().timeIntervalSince1970 * 1000)
        if let h264 {
            h264.encode(buffer, pts: CMSampleBufferGetPresentationTimeStamp(sampleBuffer), duration: CMSampleBufferGetDuration(sampleBuffer), captureMs: captureMs)
            return
        }
        let start = CFAbsoluteTimeGetCurrent()
        let image = CIImage(cvPixelBuffer: buffer)
        guard let cg = context.createCGImage(image, from: image.extent) else { return }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else { return }
        CGImageDestinationAddImage(destination, cg, [kCGImageDestinationLossyCompressionQuality: jpegQuality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return }
        let encodeMs = UInt32((CFAbsoluteTimeGetCurrent() - start) * 1000)
        FrameWriter.shared.write(captureMs: captureMs, encodeMs: encodeMs, flags: 0, payload: data as Data)
    }

    private var queued = 0
}

private final class CaptureHolder: @unchecked Sendable {
    static let shared = CaptureHolder()
    private let lock = NSLock()
    private var value: Capture?

    func retain(_ capture: Capture) {
        lock.lock()
        value = capture
        lock.unlock()
    }
}

private func fail(_ error: Error) -> Never {
    FileHandle.standardError.write(Data("MirrorCapture: \(error)\n".utf8))
    exit(1)
}

@main
struct MirrorCapture {
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        guard let displayID = args.first.flatMap(UInt32.init) else {
            fail(NSError(domain: "MirrorCapture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Usage: MirrorCapture <displayID> [jpegQuality] [maxPixelWidth] [jpeg|h264] [bitrateKbps]"]))
        }
        let jpegQuality = args.dropFirst().first.flatMap(Double.init) ?? 0.72
        let maxPixelWidth = args.dropFirst(2).first.flatMap(Int.init)
        let codec = args.dropFirst(3).first ?? "jpeg"
        let bitrateKbps = args.dropFirst(4).first.flatMap(Int.init) ?? 8000

        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
            if let error { fail(error) }
            guard let content else {
                fail(NSError(domain: "MirrorCapture", code: 3, userInfo: [NSLocalizedDescriptionKey: "ScreenCaptureKit returned no shareable content"]))
            }
            do {
                let instance = try Capture(displayID: displayID, content: content, jpegQuality: jpegQuality, maxPixelWidth: maxPixelWidth, codec: codec, bitrateKbps: bitrateKbps)
                CaptureHolder.shared.retain(instance)
                instance.stream.startCapture { error in
                    if let error { fail(error) }
                }
            } catch {
                fail(error)
            }
        }
        dispatchMain()
    }
}
