import XCTest
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif
@testable import NoticeAnswer

final class NoticeAnswerTests: XCTestCase {
  // The same vector the TypeScript test seals and opens (test/answer.test.ts).
  let vector = try! JSONSerialization.jsonObject(with: Data(contentsOf: Bundle.module.url(forResource: "answer-vector", withExtension: "json")!)) as! [String: Any]
  func bytes(_ name: String) -> Data { Data((vector[name] as! [Int]).map { UInt8($0) }) }
  var userInfo: [AnyHashable: Any] { vector["userInfo"] as! [String: Any] }

  func testSealsTheBytesTheHostOpens() throws {
    let request = try XCTUnwrap(AnswerRequest(userInfo: userInfo, action: "answer"))
    XCTAssertEqual(request, AnswerRequest(userInfo: ["body": ["id": "ask-42", "action": "tok-1", "actions": ["answer"]], "data": ["answer": ["host": "home"]]], action: "answer"))
    XCTAssertEqual(request.host, "home")
    let nonce = try ChaChaPoly.Nonce(data: bytes("nonce"))
    let text = (vector["reply"] as! [String: Any])["text"] as! String
    XCTAssertEqual(NoticeAnswer.seal(request, text: text, deviceSecret: bytes("deviceSecret"), hostPublic: bytes("hostPublic"), nonce: nonce), vector["sealed"] as? String)
    XCTAssertNil(NoticeAnswer.seal(request, text: text, deviceSecret: bytes("deviceSecret"), hostPublic: Data(repeating: 0, count: 32)))
  }

  func testOnlyAnAnswerableRelayNotificationIsTaken() {
    var body = (userInfo["body"] as! [String: Any])
    XCTAssertNil(AnswerRequest(userInfo: userInfo, action: "open"), "a button the relay did not offer")
    for field in ["id", "action", "actions", "data"] {
      var missing = body
      missing[field] = nil
      XCTAssertNil(AnswerRequest(userInfo: ["body": missing], action: "answer"), field)
    }
    body["data"] = ["answer": ["host": ""]]
    XCTAssertNil(AnswerRequest(userInfo: ["body": body], action: "answer"))
  }

  func testPressGoesToTheRelayActionRouteAndSaysWhyItFailed() throws {
    let request = try XCTUnwrap(AnswerRequest(userInfo: userInfo, action: "answer"))
    let target = AnswerTarget(host: "home", relay: "https://relay.example", key: bytes("hostPublic"))
    let press = try XCTUnwrap(NoticeAnswer.press(request, text: "y", deviceSecret: bytes("deviceSecret"), target: target))
    XCTAssertEqual(press.url?.absoluteString, "https://relay.example/relay/v1/push/action")
    XCTAssertEqual(press.httpMethod, "POST")
    let sent = try JSONSerialization.jsonObject(with: XCTUnwrap(press.httpBody)) as! [String: String]
    XCTAssertEqual(sent["token"], "tok-1")
    XCTAssertEqual(sent["action"], "answer")
    XCTAssertNotNil(sent["reply"])
    XCTAssertNil(NoticeAnswer.press(request, text: "y", deviceSecret: bytes("deviceSecret"), target: AnswerTarget(host: "home", relay: "http://relay.example", key: bytes("hostPublic"))))
    XCTAssertNil(NoticeAnswer.failure(status: 200, body: nil))
    XCTAssertEqual(NoticeAnswer.failure(status: 503, body: Data(#"{"error":"computer offline"}"#.utf8)), "Computer offline")
    XCTAssertEqual(NoticeAnswer.failure(status: 500, body: nil), "The answer was refused")
  }
}
