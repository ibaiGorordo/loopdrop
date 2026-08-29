// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "Loopdrop",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "Loopdrop", targets: ["LoopdropNative"])
    ],
    targets: [
        .executableTarget(
            name: "LoopdropNative",
            path: "Sources/LoopdropNative"
        ),
        .testTarget(
            name: "LoopdropNativeTests",
            dependencies: ["LoopdropNative"],
            path: "Tests/LoopdropNativeTests"
        )
    ],
    swiftLanguageVersions: [.v5]
)
