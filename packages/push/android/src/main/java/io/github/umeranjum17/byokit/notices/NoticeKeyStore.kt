package io.github.umeranjum17.byokit.notices

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.util.Base64

/** Only the encrypted device secret is in preferences; the wrapping key never leaves Android Keystore. */
class NoticeKeyStore(context: Context) {
  private val prefs = context.getSharedPreferences("byokit.notices", Context.MODE_PRIVATE)
  private val alias = "byokit.notices.wrap"
  private fun wrappingKey(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(alias, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
    return generator.generateKey()
  }
  @Synchronized fun set(key: ByteArray) {
    require(key.size == 32) { "notices: invalid key" }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, wrappingKey())
    check(prefs.edit().putString("key", Base64.encodeToString(cipher.iv + cipher.doFinal(key), Base64.NO_WRAP)).commit()) { "notices: key write failed" }
  }
  @Synchronized fun get(): ByteArray? = try {
    val encoded = prefs.getString("key", null)
    if (encoded == null) null else {
      val bytes = Base64.decode(encoded, Base64.NO_WRAP)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
      cipher.doFinal(bytes.copyOfRange(12, bytes.size)).also { require(it.size == 32) }
    }
  } catch (_: Exception) { null }
  @Synchronized fun clear() {
    check(prefs.edit().remove("key").commit()) { "notices: key clear failed" }
    KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry(alias) }
  }
}
