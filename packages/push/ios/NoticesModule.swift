import Foundation
import ExpoModulesCore

public class NoticesModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ByokitNotices")
    AsyncFunction("setNoticeKey") { (values: [Int]) in
      guard values.count == 32, values.allSatisfy({ (0...255).contains($0) }) else { throw NoticeKeyError.invalid }
      guard let group = Bundle.main.object(forInfoDictionaryKey: "ByokitNoticeAppGroup") as? String else { throw NoticeKeyError.unavailable }
      var key = Data(values.map { UInt8($0) })
      defer { key.resetBytes(in: 0..<key.count) }
      try NoticeKeyStore(group: group).set(key)
    }
    AsyncFunction("declareSignedOut") {
      guard let group = Bundle.main.object(forInfoDictionaryKey: "ByokitNoticeAppGroup") as? String else { throw NoticeKeyError.unavailable }
      try NoticeSession(group: group).declareSignedOut(
        clearKey: { try NoticeKeyStore(group: group).clear() },
        clearTargets: { try NoticeAnswerCenter.setTargets([]) })
    }
    AsyncFunction("clearNoticeKey") {
      guard let group = Bundle.main.object(forInfoDictionaryKey: "ByokitNoticeAppGroup") as? String else { throw NoticeKeyError.unavailable }
      try NoticeKeyStore(group: group).clear()
    }
    AsyncFunction("setAnswerTargets") { (targets: [[String: Any]]) in
      try NoticeAnswerCenter.setTargets(targets.map { target in
        guard let host = target["host"] as? String, let relay = target["relay"] as? String,
              let key = target["key"] as? [Int], key.count == 32, key.allSatisfy({ (0...255).contains($0) })
        else { throw NoticeKeyError.invalid }
        return AnswerTarget(host: host, relay: relay, key: Data(key.map { UInt8($0) }))
      })
    }
  }
}
