import Foundation
import CoreImage
import ImageIO
import ScreenCaptureKit

final class Capture: NSObject, SCStreamOutput {
    let stream: SCStream
    let context = CIContext()
    let jpegQuality: Double

    init(displayID: CGDirectDisplayID, content: SCShareableContent, jpegQuality: Double, maxPixelWidth: Int?) throws {
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
        let start = CFAbsoluteTimeGetCurrent()
        let image = CIImage(cvPixelBuffer: buffer)
        guard let cg = context.createCGImage(image, from: image.extent) else { return }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else { return }
        CGImageDestinationAddImage(destination, cg, [kCGImageDestinationLossyCompressionQuality: jpegQuality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return }
        var length = UInt32(data.length).bigEndian
        FileHandle.standardOutput.write(Data(bytes: &length, count: 4))
        FileHandle.standardOutput.write(data as Data)
        encoded += 1
        encodeMs += (CFAbsoluteTimeGetCurrent() - start) * 1000
        if encoded % 300 == 0 {
            FileHandle.standardError.write(Data(String(format: "MirrorCapture: %d frames, avg encode %.0fms\n", encoded, encodeMs / 300).utf8))
            encodeMs = 0
        }
    }

    private var queued = 0
    private var encoded = 0
    private var encodeMs = 0.0
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
            fail(NSError(domain: "MirrorCapture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Usage: MirrorCapture <displayID> [jpegQuality] [maxPixelWidth]"]))
        }
        let jpegQuality = args.dropFirst().first.flatMap(Double.init) ?? 0.72
        let maxPixelWidth = args.dropFirst(2).first.flatMap(Int.init)

        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
            if let error { fail(error) }
            guard let content else {
                fail(NSError(domain: "MirrorCapture", code: 3, userInfo: [NSLocalizedDescriptionKey: "ScreenCaptureKit returned no shareable content"]))
            }
            do {
                let instance = try Capture(displayID: displayID, content: content, jpegQuality: jpegQuality, maxPixelWidth: maxPixelWidth)
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
