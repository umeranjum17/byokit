import XCTest
import NoticeSession
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif
@testable import NoticeAnswer

final class NoticeAnswerTests: XCTestCase {
  let group = "byokit.push.answer.tests.\(UUID().uuidString)"
  var session: NoticeSession { NoticeSession(group: group) }
  override func tearDown() {
    UserDefaults(suiteName: group)?.removePersistentDomain(forName: group)
    super.tearDown()
  }
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
    XCTAssertEqual(NoticeAnswer.seal(request, reply: .text(text), deviceSecret: bytes("deviceSecret"), hostPublic: bytes("hostPublic"), nonce: nonce), vector["sealed"] as? String)
    XCTAssertNil(NoticeAnswer.seal(request, reply: .text(text), deviceSecret: bytes("deviceSecret"), hostPublic: Data(repeating: 0, count: 32)))
  }

  func testAPressedChoiceSealsTheBytesTheHostOpens() throws {
    let choice = vector["choice"] as! [String: Any]
    let request = try XCTUnwrap(AnswerRequest(userInfo: choice["userInfo"] as! [String: Any], action: "allow"))
    XCTAssertEqual(request.choices, ["allow", "deny"])
    XCTAssertEqual(try XCTUnwrap(AnswerRequest(userInfo: userInfo, action: "answer")).choices, [], "a text-only notice has no choice buttons")
    let nonce = try ChaChaPoly.Nonce(data: bytes("nonce"))
    XCTAssertEqual(NoticeAnswer.seal(request, reply: .choice("allow"), deviceSecret: bytes("deviceSecret"), hostPublic: bytes("hostPublic"), nonce: nonce), choice["sealed"] as? String)
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

  func testFailedSignOutCleanupStillRefusesSubmission() throws {
    enum CleanupFailure: Error { case refused }
    let request = try XCTUnwrap(AnswerRequest(userInfo: userInfo, action: "answer"))
    let target = AnswerTarget(host: "home", relay: "https://relay.example", key: bytes("hostPublic"))
    for failing in ["key", "targets", "both", "neither"] {
      try session.setKey {}
      let clearKey = { if failing == "key" || failing == "both" { throw CleanupFailure.refused } }
      let clearTargets = { if failing == "targets" || failing == "both" { throw CleanupFailure.refused } }
      if failing == "neither" { try session.declareSignedOut(clearKey: clearKey, clearTargets: clearTargets) }
      else { XCTAssertThrowsError(try session.declareSignedOut(clearKey: clearKey, clearTargets: clearTargets)) }
      for reply in [AnswerReply.text("y"), .choice("allow")] {
        var posts = 0
        do {
          _ = try NoticeAnswer.press(request, reply: reply, deviceSecret: bytes("deviceSecret"), target: target, session: NoticeSession(group: group))
          posts += 1 // the native handler posts only after press returns a request
          XCTFail("signed-out press must throw before sealing or posting")
        } catch {
          XCTAssertEqual(error as? NoticeKeyError, .signedOut)
          XCTAssertEqual(error.localizedDescription, "This device is signed out")
        }
        XCTAssertEqual(posts, 0)
      }
      try session.declareSignedOut(clearKey: {}, clearTargets: {})
      XCTAssertThrowsError(try session.setKey { throw CleanupFailure.refused })
      XCTAssertThrowsError(try NoticeAnswer.press(request, reply: .text("y"), deviceSecret: bytes("deviceSecret"), target: target, session: session))
      try session.setKey {}
      XCTAssertNotNil(try NoticeAnswer.press(request, reply: .text("y"), deviceSecret: bytes("deviceSecret"), target: target, session: session))
    }
  }

  func testPressGoesToTheRelayActionRouteAndSaysWhyItFailed() throws {
    let request = try XCTUnwrap(AnswerRequest(userInfo: userInfo, action: "answer"))
    let target = AnswerTarget(host: "home", relay: "https://relay.example", key: bytes("hostPublic"))
    let press = try XCTUnwrap(try NoticeAnswer.press(request, reply: .text("y"), deviceSecret: bytes("deviceSecret"), target: target, session: session))
    XCTAssertEqual(press.url?.absoluteString, "https://relay.example/relay/v1/push/action")
    XCTAssertEqual(press.httpMethod, "POST")
    let sent = try JSONSerialization.jsonObject(with: XCTUnwrap(press.httpBody)) as! [String: String]
    XCTAssertEqual(sent["token"], "tok-1")
    XCTAssertEqual(sent["action"], "answer")
    XCTAssertNotNil(sent["reply"])
    XCTAssertNil(try NoticeAnswer.press(request, reply: .text("y"), deviceSecret: bytes("deviceSecret"), target: AnswerTarget(host: "home", relay: "http://relay.example", key: bytes("hostPublic")), session: session))
    XCTAssertNil(NoticeAnswer.failure(status: 200, body: nil))
    XCTAssertEqual(NoticeAnswer.failure(status: 503, body: Data(#"{"error":"computer offline"}"#.utf8)), "Computer offline")
    XCTAssertEqual(NoticeAnswer.failure(status: 500, body: nil), "The answer was refused")
  }
}
