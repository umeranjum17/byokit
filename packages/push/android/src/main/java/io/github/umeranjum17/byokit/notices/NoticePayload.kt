package io.github.umeranjum17.byokit.notices

import com.iwebpp.crypto.TweetNaclFast
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

data class NoticeContent(val title: String, val body: String, val data: JSONObject?)

object NoticePayload {
  private fun decode(text: String): ByteArray? {
    val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    val bytes = ByteArray(text.length * 6 / 8)
    var hold = 0; var bits = 0; var at = 0
    for (char in text) {
      hold = (hold shl 6) or alphabet.indexOf(char)
      bits += 6
      if (bits >= 8) { bits -= 8; bytes[at++] = (hold shr bits).toByte() }
    }
    return if (bits > 0 && (hold and ((1 shl bits) - 1)) != 0) null else bytes
  }
  // No Android API: tested on the JVM against a seal 0.2.0 fixture.
  fun open(envelope: String, secret: ByteArray): NoticeContent? {
    var plain: ByteArray? = null
    return try {
      val value = JSONObject(envelope)
      if (value.opt("v") != 1 || secret.size != 32) return null
      val sealed = value.opt("sealed") as? String ?: return null
      if (sealed.length > 8192 || !sealed.matches(Regex("[A-Za-z0-9_-]+")) || sealed.length % 4 == 1) return null
      val bundle = decode(sealed) ?: return null
      if (bundle.size < 72) return null
      // TweetNaCl accepts low-order peer keys: reject an all-zero X25519 shared secret first.
      val shared = ByteArray(32)
      TweetNaclFast.crypto_scalarmult(shared, secret, bundle.copyOfRange(0, 32))
      val lowOrder = shared.all { it == 0.toByte() }
      shared.fill(0)
      if (lowOrder) return null
      plain = TweetNaclFast.Box(bundle.copyOfRange(0, 32), secret).open(bundle.copyOfRange(56, bundle.size), bundle.copyOfRange(32, 56)) ?: return null
      val json = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(plain)).toString()
      val content = JSONObject(json)
      val title = content.opt("title") as? String ?: return null
      val body = content.opt("body") as? String ?: return null
      if (title.isEmpty()) return null
      val data = if (content.has("data")) content.opt("data") as? JSONObject ?: return null else null
      NoticeContent(title, body, data)
    } catch (_: Exception) { null }
    finally { plain?.fill(0) }
  }

  fun display(envelope: String?, key: ByteArray?, fallback: NoticeContent): NoticeContent =
    if (envelope == null || key == null) fallback else open(envelope, key) ?: fallback
}
