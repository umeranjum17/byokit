import Foundation
import XCTest
@testable import ByokitSeal

final class ByokitSealTests: XCTestCase {
  private func data(_ hex: String) -> Data {
    Data(stride(from: 0, to: hex.count, by: 2).map { i -> UInt8 in
      let at = hex.index(hex.startIndex, offsetBy: i)
      return UInt8(hex[at..<hex.index(at, offsetBy: 2)], radix: 16)!
    })
  }
  private func canonical(_ value: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys])
  }

  /// Every case in notice-vectors.json, made by the TypeScript opener: same value, or nil where it returns null.
  func testNoticeVectors() throws {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "notice-vectors", withExtension: "json"))
    let file = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    let secret = data(try XCTUnwrap(file["secret"] as? String))
    let cases = try XCTUnwrap(file["cases"] as? [[String: Any]])
    XCTAssertEqual(cases.count, 35)
    for c in cases {
      let name = c["name"] as? String ?? "?"
      let key = (c["secret"] as? String).map(data) ?? secret
      let envelope = c["envelope"] is NSNull ? nil : c["envelope"]
      let opened = ByokitSeal.openNotice(envelope, secret: key)
      if c["expect"] is NSNull {
        XCTAssertNil(opened, name)
      } else {
        XCTAssertEqual(try canonical(XCTUnwrap(opened, name)), try canonical(c["expect"]!), name)
      }
    }
  }

  /// Expo delivers `data` under the APNs payload's `body`; the relay puts the envelope in its `data`.
  func testNoticeFromExpoUserInfo() throws {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "notice-vectors", withExtension: "json"))
    let file = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    let first = try XCTUnwrap((file["cases"] as? [[String: Any]])?.first)
    let userInfo: [AnyHashable: Any] = ["aps": ["alert": ["title": "An agent needs you"], "mutable-content": 1],
                                        "body": ["id": "ask-1", "title": "An agent needs you", "data": first["envelope"]!]]
    let opened = ByokitSeal.openNotice(userInfo: userInfo, secret: data(file["secret"] as! String))
    XCTAssertEqual(try canonical(XCTUnwrap(opened)), try canonical(first["expect"]!))
    XCTAssertNil(ByokitSeal.openNotice(userInfo: ["body": ["id": "ask-1"]], secret: data(file["secret"] as! String)))
  }
}
