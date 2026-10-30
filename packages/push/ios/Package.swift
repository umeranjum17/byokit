// swift-tools-version: 5.9
import PackageDescription
let package = Package(
  name: "NoticePayload",
  platforms: [.macOS(.v13), .iOS(.v15)],
  products: [.library(name: "NoticePayload", targets: ["NoticePayload"]), .library(name: "NoticeAnswer", targets: ["NoticeAnswer"])],
  dependencies: [.package(url: "https://github.com/jedisct1/swift-sodium.git", exact: "0.11.0")],
  targets: [
    .target(name: "NoticeSession", path: ".", exclude: ["Extension", "Tests", "Answer", "AnswerTests", "NoticesModule.swift", "NoticeAnswerCenter.swift", "ByokitNotices.podspec"], sources: ["NoticeKeyStore.swift"]),
    .target(name: "NoticePayload", dependencies: ["NoticeSession", .product(name: "Clibsodium", package: "swift-sodium")], path: "Extension"),
    .testTarget(name: "NoticePayloadTests", dependencies: ["NoticePayload", "NoticeSession"], path: "Tests"),
    .target(name: "NoticeAnswer", dependencies: ["NoticeSession"], path: "Answer"),
    .testTarget(name: "NoticeAnswerTests", dependencies: ["NoticeAnswer", "NoticeSession"], path: "AnswerTests", resources: [.copy("answer-vector.json")])
  ]
)
