// swift-tools-version: 5.9
import PackageDescription
let package = Package(
  name: "NoticePayload",
  platforms: [.macOS(.v13), .iOS(.v15)],
  products: [.library(name: "NoticePayload", targets: ["NoticePayload"])],
  dependencies: [.package(url: "https://github.com/jedisct1/swift-sodium.git", exact: "0.11.0")],
  targets: [
    .target(name: "NoticePayload", dependencies: [.product(name: "Clibsodium", package: "swift-sodium")], path: "Extension", exclude: ["NotificationService.swift"]),
    .testTarget(name: "NoticePayloadTests", dependencies: ["NoticePayload"], path: "Tests")
  ]
)
