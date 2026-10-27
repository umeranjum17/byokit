// The native half of the TypeScript `sealAnswer`: reads an answerable notification and seals the typed reply, with no
// JavaScript running. Same bytes: unpadded base64url of nonce (12) | ChaCha20-Poly1305 of the sorted-key JSON `{ action, event, text, v: 1 }`
// (a typed text) or `{ action, choice, event, v: 2 }` (a pressed choice)
// under HKDF-SHA256(X25519(device, host), salt: device public | host public, info: "byokit.push.answer.v1").
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking // URLRequest off Apple platforms
#endif
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto // swift-crypto, for running the vectors off Apple platforms only
#endif

struct AnswerTarget: Codable, Equatable {
  let host: String
  let relay: String
  let key: Data
}

/// One press of an answer button on a relay notification. Expo puts the relay's payload under `userInfo["body"]`:
/// `id` (the event), `action` (this device's one-use token), `actions`, and `data` (the notice the extension opened).
struct AnswerRequest: Equatable {
  let event: String
  let token: String
  let action: String
  let host: String
  let choices: [String] // ids of the buttons that are themselves the answer (`data.answer.choices`)

  init?(userInfo: [AnyHashable: Any], action: String) {
    guard let body = userInfo["body"] as? [String: Any], let event = body["id"] as? String, !event.isEmpty,
          let token = body["action"] as? String, !token.isEmpty,
          let actions = body["actions"] as? [String], actions.contains(action),
          let answer = ((body["data"] ?? userInfo["data"]) as? [String: Any])?["answer"] as? [String: Any],
          let host = answer["host"] as? String, !host.isEmpty else { return nil }
    self.event = event
    self.token = token
    self.action = action
    self.host = host
    self.choices = (answer["choices"] as? [[String: Any]])?.compactMap { $0["id"] as? String } ?? []
  }
}

/// What the person sent: the text they typed, or the choice button they pressed.
enum AnswerReply: Equatable {
  case text(String)
  case choice(String)
}

enum NoticeAnswer {
  static func seal(_ request: AnswerRequest, reply: AnswerReply, deviceSecret: Data, hostPublic: Data,
                   nonce: ChaChaPoly.Nonce = ChaChaPoly.Nonce()) -> String? {
    guard let secret = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: deviceSecret),
          let host = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: hostPublic),
          let shared = try? secret.sharedSecretFromKeyAgreement(with: host),
          !shared.withUnsafeBytes({ $0.allSatisfy { $0 == 0 } }), // a low-order key; noble refuses it too
          let plain = try? JSONSerialization.data(withJSONObject: Self.fields(request, reply),
                                                       options: [.sortedKeys, .withoutEscapingSlashes])
    else { return nil }
    let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: secret.publicKey.rawRepresentation + hostPublic,
                                             sharedInfo: Data("byokit.push.answer.v1".utf8), outputByteCount: 32)
    guard let box = try? ChaChaPoly.seal(plain, using: key, nonce: nonce) else { return nil }
    return box.combined.base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  private static func fields(_ request: AnswerRequest, _ reply: AnswerReply) -> [String: Any] {
    switch reply {
    case .text(let text): return ["v": 1, "event": request.event, "action": request.action, "text": text]
    case .choice(let id): return ["v": 2, "event": request.event, "action": request.action, "choice": id]
    }
  }

  /// The JSON body for `POST <relay>/relay/v1/push/action`.
  static func press(_ request: AnswerRequest, reply: AnswerReply, deviceSecret: Data, target: AnswerTarget) -> URLRequest? {
    guard let sealed = seal(request, reply: reply, deviceSecret: deviceSecret, hostPublic: target.key),
          let url = URL(string: target.relay + "/relay/v1/push/action"), url.scheme == "https",
          let body = try? JSONSerialization.data(withJSONObject: ["token": request.token, "action": request.action, "reply": sealed])
    else { return nil }
    var press = URLRequest(url: url, timeoutInterval: 20) // the relay waits up to 15 s for the host
    press.httpMethod = "POST"
    press.setValue("application/json", forHTTPHeaderField: "content-type")
    press.httpBody = body
    return press
  }

  /// The relay's own reason (`{ error }`), or a plain one when it gave none.
  static func failure(status: Int?, body: Data?) -> String? {
    if status == 200 { return nil }
    let said = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["error"] as? String
    return said.map { $0.prefix(1).uppercased() + $0.dropFirst() } ?? (status == nil ? "No connection" : "The answer was refused")
  }
}
