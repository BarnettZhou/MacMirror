// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "MirrorNative", platforms: [.macOS(.v13)], targets: [.executableTarget(name: "MirrorCapture", path: "Sources/MirrorCapture"), .executableTarget(name: "MirrorDisplayCtl", path: "Sources/MirrorDisplayCtl")])
