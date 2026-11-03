// swift-tools-version: 5.9
import PackageDescription

// whisper.cpp for on-device speech recognition (accurate captions during lectures).
// The framework itself isn't in git: scripts/fetch-whisper.sh downloads the official release.
let package = Package(
    name: "WhisperPkg",
    platforms: [.iOS(.v17)],
    products: [.library(name: "whisper", targets: ["whisper"])],
    targets: [.binaryTarget(name: "whisper", path: "whisper.xcframework")]
)
