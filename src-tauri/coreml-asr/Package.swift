// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "talky-coreml-asr",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "talky-coreml-asr", targets: ["talky-coreml-asr"]),
    ],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.12.4"),
    ],
    targets: [
        .executableTarget(
            name: "talky-coreml-asr",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio"),
            ],
            path: "Sources/talky-coreml-asr"
        ),
    ]
)
