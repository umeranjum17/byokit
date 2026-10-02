// swift-tools-version:5.9
// The native notice opener for an iOS Notification Service Extension. CryptoKit on Apple platforms; swift-crypto
// only where CryptoKit is missing, so the vectors can also run in a Linux container.
import PackageDescription

let package = Package(
  name: "ByokitSeal",
  platforms: [.iOS(.v13), .macOS(.v10_15)],
  products: [.library(name: "ByokitSeal", targets: ["ByokitSeal"])],
  dependencies: [.package(url: "https://github.com/apple/swift-crypto.git", exact: "3.15.1")],
  targets: [
    .target(name: "ByokitSeal", dependencies: [.product(name: "Crypto", package: "swift-crypto", condition: .when(platforms: [.linux]))], path: "ios/Sources/ByokitSeal"),
    .testTarget(name: "ByokitSealTests", dependencies: ["ByokitSeal"], path: "ios/Tests/ByokitSealTests", resources: [.copy("notice-vectors.json")]),
  ]
)
