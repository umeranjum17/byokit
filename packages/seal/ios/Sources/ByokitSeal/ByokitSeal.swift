// Opens a `sealNotice` envelope natively, for an iOS Notification Service Extension, where no JavaScript runs.
// Same bytes as the TypeScript `openNotice`: `{ v: 1, sealed }`, `sealed` the unpadded base64url of
// ephemeral X25519 public key (32) | nonce (24) | crypto_box_easy ciphertext (16-byte MAC first). X25519 is CryptoKit's;
// HSalsa20, XSalsa20 and Poly1305 are below, so the extension needs no other dependency.
import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto // swift-crypto, for running the tests off Apple platforms only
#endif
#if canImport(Security)
import Security
#endif

public enum ByokitSeal {
  /// The notice's JSON value (`[String: Any]`, `[Any]`, `String`, `NSNumber`), or nil for anything that is not a
  /// notice this secret opens. JSON `null` is nil too, as in TypeScript. Validate the value before showing it.
  public static func openNotice(_ envelope: Any?, secret: Data) -> Any? {
    guard secret.count == 32, let e = envelope as? [String: Any], let v = e["v"] as? NSNumber, !isBool(v),
          v.doubleValue == 1, let sealed = e["sealed"] as? String, let bundle = base64url(sealed) else { return nil }
    guard var plain = openBox(bundle, secret: [UInt8](secret)) else { return nil }
    defer { wipe(&plain) }
    var bytes = plain[...]
    if bytes.starts(with: [0xEF, 0xBB, 0xBF]) { bytes = bytes.dropFirst(3) } // TextDecoder drops a leading BOM
    if bytes.starts(with: [0xEF, 0xBB, 0xBF]) { return nil } // JSON.parse refuses a second; JSONSerialization would skip it
    guard let text = String(bytes: bytes, encoding: .utf8), let json = text.data(using: .utf8),
          let value = try? JSONSerialization.jsonObject(with: json, options: [.fragmentsAllowed]),
          !(value is NSNull) else { return nil }
    return value
  }

  /// The notice in a notification the relay sent through Expo: Expo puts `data` under the APNs payload's `body` key,
  /// and the relay puts the host's `data` (the envelope) under `data`.
  public static func openNotice(userInfo: [AnyHashable: Any], secret: Data) -> Any? {
    openNotice((userInfo["body"] as? [String: Any])?["data"], secret: secret)
  }

  #if canImport(Security)
  /// The 32-byte notice secret the app saved as an unpadded base64url string in a keychain access group it shares
  /// with its extension (for example with expo-secure-store's `accessGroup`). Reads exactly that one item; nil if it
  /// is missing, locked or malformed.
  public static func keychainSecret(service: String, account: String, accessGroup: String) -> Data? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: Data(account.utf8), kSecAttrAccessGroup as String: accessGroup,
      kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data,
          let text = String(data: data, encoding: .utf8), let secret = base64url(text), secret.count == 32 else { return nil }
    return Data(secret)
  }
  #endif

  // MARK: crypto_box_open_easy with the ephemeral public key in front, as `openBox` in TypeScript.

  static func openBox(_ bundle: [UInt8], secret: [UInt8]) -> [UInt8]? {
    guard bundle.count >= 72, secret.count == 32 else { return nil }
    guard let privateKey = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secret),
          let publicKey = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: bundle[0..<32]),
          let shared = try? privateKey.sharedSecretFromKeyAgreement(with: publicKey) else { return nil }
    var point = shared.withUnsafeBytes { [UInt8]($0) }
    defer { wipe(&point) }
    if point.allSatisfy({ $0 == 0 }) { return nil } // a low-order key; noble refuses it too
    var key = hsalsa20(key: point, nonce: [UInt8](repeating: 0, count: 16))
    defer { wipe(&key) }
    return secretboxOpen(Array(bundle[56...]), nonce: Array(bundle[32..<56]), key: key)
  }

  static func secretboxOpen(_ box: [UInt8], nonce: [UInt8], key: [UInt8]) -> [UInt8]? {
    guard box.count >= 16, nonce.count == 24, key.count == 32 else { return nil }
    var subkey = hsalsa20(key: key, nonce: Array(nonce[0..<16]))
    defer { wipe(&subkey) }
    let iv = Array(nonce[16..<24])
    var block = salsa20Block(key: subkey, nonce: iv, counter: 0)
    defer { wipe(&block) }
    let mac = Array(box[0..<16]), cipher = Array(box[16...])
    let tag = poly1305(cipher, key: Array(block[0..<32]))
    var diff: UInt8 = 0
    for i in 0..<16 { diff |= tag[i] ^ mac[i] }
    guard diff == 0 else { return nil }
    var out = [UInt8](repeating: 0, count: cipher.count)
    var stream = Array(block[32...]), counter: UInt64 = 1, at = 0
    for i in 0..<cipher.count {
      if at == stream.count { wipe(&stream); stream = salsa20Block(key: subkey, nonce: iv, counter: counter); counter += 1; at = 0 }
      out[i] = cipher[i] ^ stream[at]
      at += 1
    }
    wipe(&stream)
    return out
  }

  // MARK: Salsa20 family

  private static let sigma: [UInt32] = [0x6170_7865, 0x3320_646e, 0x7962_2d32, 0x6b20_6574] // "expand 32-byte k"

  private static func le32(_ b: [UInt8], _ i: Int) -> UInt32 {
    UInt32(b[i]) | UInt32(b[i + 1]) << 8 | UInt32(b[i + 2]) << 16 | UInt32(b[i + 3]) << 24
  }

  private static func rounds(_ x: inout [UInt32]) {
    func r(_ v: UInt32, _ n: UInt32) -> UInt32 { (v << n) | (v >> (32 - n)) }
    func q(_ a: Int, _ b: Int, _ c: Int, _ d: Int) {
      x[b] ^= r(x[a] &+ x[d], 7); x[c] ^= r(x[b] &+ x[a], 9); x[d] ^= r(x[c] &+ x[b], 13); x[a] ^= r(x[d] &+ x[c], 18)
    }
    for _ in 0..<10 {
      q(0, 4, 8, 12); q(5, 9, 13, 1); q(10, 14, 2, 6); q(15, 3, 7, 11)
      q(0, 1, 2, 3); q(5, 6, 7, 4); q(10, 11, 8, 9); q(15, 12, 13, 14)
    }
  }

  private static func state(key: [UInt8], input: [UInt32]) -> [UInt32] {
    [sigma[0], le32(key, 0), le32(key, 4), le32(key, 8), le32(key, 12), sigma[1], input[0], input[1], input[2], input[3],
     sigma[2], le32(key, 16), le32(key, 20), le32(key, 24), le32(key, 28), sigma[3]]
  }

  private static func bytes(_ words: [UInt32]) -> [UInt8] {
    words.flatMap { w in (0..<4).map { UInt8(truncatingIfNeeded: w >> (8 * $0)) } }
  }

  static func hsalsa20(key: [UInt8], nonce: [UInt8]) -> [UInt8] {
    var x = state(key: key, input: [le32(nonce, 0), le32(nonce, 4), le32(nonce, 8), le32(nonce, 12)])
    rounds(&x)
    defer { for i in x.indices { x[i] = 0 } }
    return bytes([x[0], x[5], x[10], x[15], x[6], x[7], x[8], x[9]])
  }

  static func salsa20Block(key: [UInt8], nonce: [UInt8], counter: UInt64) -> [UInt8] {
    let input = state(key: key, input: [le32(nonce, 0), le32(nonce, 4), UInt32(truncatingIfNeeded: counter), UInt32(truncatingIfNeeded: counter >> 32)])
    var x = input
    rounds(&x)
    defer { for i in x.indices { x[i] = 0 } }
    return bytes(zip(x, input).map { $0 &+ $1 })
  }

  // MARK: Poly1305 (26-bit limbs, as poly1305-donna)

  static func poly1305(_ m: [UInt8], key: [UInt8]) -> [UInt8] {
    let mask: UInt64 = 0x3ff_ffff
    let r0 = UInt64(le32(key, 0) & 0x3ff_ffff), r1 = UInt64((le32(key, 3) >> 2) & 0x3ff_ff03)
    let r2 = UInt64((le32(key, 6) >> 4) & 0x3ff_c0ff), r3 = UInt64((le32(key, 9) >> 6) & 0x3f0_3fff)
    let r4 = UInt64((le32(key, 12) >> 8) & 0x00f_ffff)
    let s1 = r1 * 5, s2 = r2 * 5, s3 = r3 * 5, s4 = r4 * 5
    var h0: UInt64 = 0, h1: UInt64 = 0, h2: UInt64 = 0, h3: UInt64 = 0, h4: UInt64 = 0
    var at = 0
    while at < m.count {
      var block = [UInt8](repeating: 0, count: 17)
      let n = min(16, m.count - at)
      for i in 0..<n { block[i] = m[at + i] }
      block[n] = 1 // full blocks: the 2^128 bit; a final short block: 0x01 after the message, then zeros
      at += n
      h0 += UInt64(le32(block, 0) & 0x3ff_ffff)
      h1 += UInt64((le32(block, 3) >> 2) & 0x3ff_ffff)
      h2 += UInt64((le32(block, 6) >> 4) & 0x3ff_ffff)
      h3 += UInt64((le32(block, 9) >> 6) & 0x3ff_ffff)
      h4 += UInt64(le32(block, 12) >> 8) | (n == 16 ? 1 << 24 : 0)
      let d0 = h0 * r0 + h1 * s4 + h2 * s3 + h3 * s2 + h4 * s1
      var d1 = h0 * r1 + h1 * r0 + h2 * s4 + h3 * s3 + h4 * s2
      var d2 = h0 * r2 + h1 * r1 + h2 * r0 + h3 * s4 + h4 * s3
      var d3 = h0 * r3 + h1 * r2 + h2 * r1 + h3 * r0 + h4 * s4
      var d4 = h0 * r4 + h1 * r3 + h2 * r2 + h3 * r1 + h4 * r0
      var c = d0 >> 26; h0 = d0 & mask
      d1 += c; c = d1 >> 26; h1 = d1 & mask
      d2 += c; c = d2 >> 26; h2 = d2 & mask
      d3 += c; c = d3 >> 26; h3 = d3 & mask
      d4 += c; c = d4 >> 26; h4 = d4 & mask
      h0 += c * 5; c = h0 >> 26; h0 &= mask
      h1 += c
    }
    var c = h1 >> 26; h1 &= mask
    h2 += c; c = h2 >> 26; h2 &= mask
    h3 += c; c = h3 >> 26; h3 &= mask
    h4 += c; c = h4 >> 26; h4 &= mask
    h0 += c * 5; c = h0 >> 26; h0 &= mask
    h1 += c
    // h - p, chosen in constant time when h >= p = 2^130 - 5
    var g0 = h0 + 5; c = g0 >> 26; g0 &= mask
    var g1 = h1 + c; c = g1 >> 26; g1 &= mask
    var g2 = h2 + c; c = g2 >> 26; g2 &= mask
    var g3 = h3 + c; c = g3 >> 26; g3 &= mask
    var g4 = (h4 + c) &- (1 << 26)
    let pick = (g4 >> 63) &- 1 // all ones when h >= p
    g0 &= pick; g1 &= pick; g2 &= pick; g3 &= pick; g4 &= pick
    h0 = (h0 & ~pick) | g0; h1 = (h1 & ~pick) | g1; h2 = (h2 & ~pick) | g2; h3 = (h3 & ~pick) | g3; h4 = (h4 & ~pick) | g4
    let w0 = (h0 | h1 << 26) & 0xffff_ffff, w1 = (h1 >> 6 | h2 << 20) & 0xffff_ffff
    let w2 = (h2 >> 12 | h3 << 14) & 0xffff_ffff, w3 = (h3 >> 18 | h4 << 8) & 0xffff_ffff
    var f = w0 + UInt64(le32(key, 16)); let t0 = f & 0xffff_ffff
    f = w1 + UInt64(le32(key, 20)) + (f >> 32); let t1 = f & 0xffff_ffff
    f = w2 + UInt64(le32(key, 24)) + (f >> 32); let t2 = f & 0xffff_ffff
    f = w3 + UInt64(le32(key, 28)) + (f >> 32); let t3 = f & 0xffff_ffff
    return bytes([UInt32(t0), UInt32(t1), UInt32(t2), UInt32(t3)])
  }

  // MARK: helpers

  private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)

  /// Unpadded base64url, as strict as the TypeScript decoder: no padding or other characters, no stray low bits.
  static func base64url(_ text: String) -> [UInt8]? {
    let chars = Array(text.utf8)
    guard chars.count % 4 != 1 else { return nil }
    var out = [UInt8](), hold: UInt32 = 0, bits = 0
    out.reserveCapacity(chars.count * 6 / 8)
    for ch in chars {
      guard let value = alphabet.firstIndex(of: ch) else { return nil }
      hold = (hold << 6 | UInt32(value)) & 0xfff
      bits += 6
      if bits >= 8 { bits -= 8; out.append(UInt8(truncatingIfNeeded: hold >> UInt32(bits))) }
    }
    return bits > 0 && hold & ((1 << UInt32(bits)) - 1) != 0 ? nil : out
  }

  private static func isBool(_ n: NSNumber) -> Bool {
    #if canImport(Darwin)
    return CFGetTypeID(n) == CFBooleanGetTypeID()
    #else
    return String(cString: n.objCType) == "c" && (n == NSNumber(value: true) || n == NSNumber(value: false))
    #endif
  }

  private static func wipe(_ b: inout [UInt8]) { for i in b.indices { b[i] = 0 } }
}
