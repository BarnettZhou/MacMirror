import Foundation
import CoreGraphics

// MirrorDisplayCtl set <displayID> <宽x高>
// 把指定显示器切换到目标逻辑分辨率（优先 HiDPI 2x 模式），仅作用于当前会话。
// MirrorDisplayCtl probe <displayID>
// 检查指定显示器是否仍在线：在线退出码 0，不在线退出码 3。

private func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write(Data("MirrorDisplayCtl: \(message)\n".utf8))
    exit(code)
}

private func onlineDisplays() -> [CGDirectDisplayID] {
    var count: UInt32 = 0
    CGGetOnlineDisplayList(0, nil, &count)
    var list = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetOnlineDisplayList(count, &list, &count)
    return Array(list.prefix(Int(count)))
}

let command = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""

if command == "probe" {
    guard CommandLine.arguments.count == 3, let displayID = UInt32(CommandLine.arguments[2]) else {
        fail("Usage: MirrorDisplayCtl probe <displayID>", 2)
    }
    exit(onlineDisplays().contains(displayID) ? 0 : 3)
}

guard command == "set", CommandLine.arguments.count == 4,
      let displayID = UInt32(CommandLine.arguments[2]) else {
    fail("Usage: MirrorDisplayCtl set <displayID> <WxH> | probe <displayID>", 2)
}
let parts = CommandLine.arguments[3].split(separator: "x").compactMap { Int($0) }
guard parts.count == 2 else {
    fail("Invalid resolution: \(CommandLine.arguments[3])", 2)
}
let (width, height) = (parts[0], parts[1])

guard onlineDisplays().contains(displayID) else {
    fail("Display \(displayID) is not online", 3)
}

let options = [kCGDisplayShowDuplicateLowResolutionModes: true] as CFDictionary
guard let modes = CGDisplayCopyAllDisplayModes(displayID, options) as? [CGDisplayMode] else {
    fail("Cannot read display modes for \(displayID)", 4)
}
let candidates = modes.filter { $0.width == width && $0.height == height }
guard let mode = candidates.first(where: { $0.pixelWidth == width * 2 && $0.pixelHeight == height * 2 }) ?? candidates.first else {
    fail("No display mode \(width)x\(height) for display \(displayID)", 4)
}

var config: CGDisplayConfigRef?
guard CGBeginDisplayConfiguration(&config) == .success else {
    fail("CGBeginDisplayConfiguration failed", 5)
}
CGConfigureDisplayWithDisplayMode(config, displayID, mode, nil)
guard CGCompleteDisplayConfiguration(config, .forSession) == .success else {
    fail("CGCompleteDisplayConfiguration failed", 5)
}
print("\(width)x\(height) pixel=\(mode.pixelWidth)x\(mode.pixelHeight)")
