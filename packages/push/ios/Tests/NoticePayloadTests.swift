import XCTest
import NoticeSession
#if canImport(UserNotifications)
import UserNotifications
#endif
@testable import NoticePayload
final class NoticePayloadTests: XCTestCase {
  let group = "byokit.push.tests.\(UUID().uuidString)"
  var session: NoticeSession { NoticeSession(group: group) }
  override func tearDown() {
    UserDefaults(suiteName: group)?.removePersistentDomain(forName: group)
    super.tearDown()
  }
  let envelope = #"{"v":1,"sealed":"RrGICg3Kl64WGNPYwEzFGxD9CMHNiDnBu_S9f-AUAF0pKissLS4vMDEyMzQ1Njc4OTo7PD0-P0Dsgbnm6qATdCXyr-WkXnSwIToizfHg5EoTyJSRFMbE8a9SKPFIOYg5LR4-0yfdc8DtPGA-CJB7aOHq-zym7L8IdphxkgwL7NDp65f8Y6AhiShy3yE8zU2MUCkaepG4UpKQ5aG39JnwylpVJz97v35TjkK-Zf9g7uhZY4Q6a9MGpukQ_FyOuhzDBgDO7bJcHCb-KUjk6hk"}"#
  let key = Data((1...32).map { UInt8($0) })
  func testFailedSignOutCleanupStillRefusesDecryption() throws {
    enum CleanupFailure: Error { case refused }
    let fields: [AnyHashable: Any] = ["notice": envelope]
    for failing in ["key", "targets", "both", "neither"] {
      try session.setKey {} // the production key setter uses this same successful-write boundary
      XCTAssertNotNil(NoticePayload.openTransport(fields, key: key, session: session))
      var attempts: [String] = []
      let clearKey = {
        XCTAssertTrue(self.session.isSignedOut, "refusal must already be visible before the key clear")
        attempts.append("key")
        if failing == "key" || failing == "both" { throw CleanupFailure.refused }
      }
      let clearTargets = {
        XCTAssertTrue(self.session.isSignedOut, "refusal must already be visible before the targets clear")
        attempts.append("targets")
        if failing == "targets" || failing == "both" { throw CleanupFailure.refused }
      }
      if failing == "neither" { try session.declareSignedOut(clearKey: clearKey, clearTargets: clearTargets) }
      else { XCTAssertThrowsError(try session.declareSignedOut(clearKey: clearKey, clearTargets: clearTargets)) }
      XCTAssertEqual(attempts, ["key", "targets"], "try both removals even when one fails")
      // A newly-created reader, as in the extension, must refuse even with the retained, valid key.
      XCTAssertNil(NoticePayload.openTransport(fields, key: key, session: NoticeSession(group: group)))
      try session.declareSignedOut(clearKey: {}, clearTargets: {})
      XCTAssertNil(NoticePayload.openTransport(fields, key: key, session: session), "later successful cleanup never resumes")
      XCTAssertThrowsError(try session.setKey { throw CleanupFailure.refused })
      XCTAssertTrue(session.isSignedOut, "a failed key write never resumes")
      try session.setKey {}
      XCTAssertEqual(NoticePayload.openTransport(fields, key: key, session: session)?.title, "Build ready ☀️")
    }
  }
  func testSealFixtureAndFallback() {
    let opened = NoticePayload.open(envelope, key: key)
    XCTAssertEqual(NoticePayload.openTransport(["body": ["notice": envelope]], key: key, session: session)?.title, "Build ready ☀️")
    XCTAssertEqual(NoticePayload.openTransport(["notice": envelope], key: key, session: session)?.title, "Build ready ☀️")
    XCTAssertEqual(NoticePayload.openTransport(["body": ["data": envelope]], key: key, session: session)?.title, "Build ready ☀️") // @byokit/relay
    XCTAssertEqual(opened?.title, "Build ready ☀️")
    XCTAssertEqual(opened?.body, "The task finished.")
    XCTAssertEqual(opened?.data?["sessionId"] as? String, "s-1")
    XCTAssertNil(NoticePayload.open(envelope, key: Data(repeating: 0, count: 32)))
    XCTAssertNil(NoticePayload.open("broken", key: key))
    XCTAssertNil(NoticePayload.open(envelope.replacingOccurrences(of: "\"v\":1", with: "\"v\":2"), key: key))
    XCTAssertNil(NoticePayload.open(envelope.replacingOccurrences(of: "sealed\":\"", with: "sealed\":\"A"), key: key))
  }

  #if canImport(UserNotifications)
  func testSignedOutExtensionDeliversTheUntouchedNotificationAndSignInRestoresOpening() throws {
    let service = NotificationService()
    service.group = group
    var reads = 0
    service.readKey = { _ in reads += 1; return self.key }
    let original = UNMutableNotificationContent()
    original.title = "Generic title"
    original.body = "Generic body"
    original.userInfo = ["notice": envelope, "route": "keep me"]
    original.categoryIdentifier = "answer"
    original.badge = 7
    original.sound = .default
    let request = UNNotificationRequest(identifier: "ask-42", content: original, trigger: nil)
    XCTAssertThrowsError(try session.declareSignedOut(clearKey: { throw NoticeKeyError.unavailable }, clearTargets: {}))
    let refused = expectation(description: "untouched notification delivered")
    service.didReceive(request) { content in
      XCTAssertTrue(content === request.content, "return exactly the original content, like the missing-key fallback")
      refused.fulfill()
    }
    wait(for: [refused], timeout: 1)
    XCTAssertEqual(reads, 0, "do not even read the key while signed out")
    try session.setKey {}
    let restored = expectation(description: "sign-in opens the same notification")
    service.didReceive(request) { content in
      XCTAssertEqual(content.title, "Build ready ☀️")
      XCTAssertEqual(content.body, "The task finished.")
      restored.fulfill()
    }
    wait(for: [restored], timeout: 1)
    XCTAssertEqual(reads, 1)
  }
  #endif
}
