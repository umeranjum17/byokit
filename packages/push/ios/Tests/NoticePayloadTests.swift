import XCTest
@testable import NoticePayload
final class NoticePayloadTests: XCTestCase {
  let envelope = #"{"v":1,"sealed":"RrGICg3Kl64WGNPYwEzFGxD9CMHNiDnBu_S9f-AUAF0pKissLS4vMDEyMzQ1Njc4OTo7PD0-P0Dsgbnm6qATdCXyr-WkXnSwIToizfHg5EoTyJSRFMbE8a9SKPFIOYg5LR4-0yfdc8DtPGA-CJB7aOHq-zym7L8IdphxkgwL7NDp65f8Y6AhiShy3yE8zU2MUCkaepG4UpKQ5aG39JnwylpVJz97v35TjkK-Zf9g7uhZY4Q6a9MGpukQ_FyOuhzDBgDO7bJcHCb-KUjk6hk"}"#
  let key = Data((1...32).map { UInt8($0) })
  func testSealFixtureAndFallback() {
    let opened = NoticePayload.open(envelope, key: key)
    XCTAssertEqual(NoticePayload.openTransport(["body": ["notice": envelope]], key: key)?.title, "Build ready ☀️")
    XCTAssertEqual(NoticePayload.openTransport(["notice": envelope], key: key)?.title, "Build ready ☀️")
    XCTAssertEqual(opened?.title, "Build ready ☀️")
    XCTAssertEqual(opened?.body, "The task finished.")
    XCTAssertEqual(opened?.data?["sessionId"] as? String, "s-1")
    XCTAssertNil(NoticePayload.open(envelope, key: Data(repeating: 0, count: 32)))
    XCTAssertNil(NoticePayload.open("broken", key: key))
    XCTAssertNil(NoticePayload.open(envelope.replacingOccurrences(of: "\"v\":1", with: "\"v\":2"), key: key))
    XCTAssertNil(NoticePayload.open(envelope.replacingOccurrences(of: "sealed\":\"", with: "sealed\":\"A"), key: key))
  }
}
