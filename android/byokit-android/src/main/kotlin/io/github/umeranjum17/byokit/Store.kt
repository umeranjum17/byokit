package io.github.umeranjum17.byokit

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Where one app keeps its own sign-ins. One store per person; nothing falls back to another store. */
interface CredentialStore {
    fun read(id: String): Credential?
    /** Writes (null deletes) under a lock, so a refresh and a sign-in never race. */
    fun write(id: String, credential: Credential?)
}

class MemoryStore : CredentialStore {
    private val all = mutableMapOf<String, Credential>()
    @Synchronized override fun read(id: String) = all[id]
    @Synchronized override fun write(id: String, credential: Credential?) {
        if (credential == null) all.remove(id) else all[id] = credential
    }
}

/**
 * Sign-ins encrypted with an AES-256-GCM key that lives in this app's Android Keystore, in `noBackupFilesDir`, so a copy
 * of the app's files (or a backup) is useless without this phone's Keystore. `name` separates people or profiles.
 */
class KeystoreStore(context: Context, name: String = "default") : CredentialStore {
    private val file = AtomicFile(File(context.noBackupFilesDir, "byokit/$name.sealed").also { it.parentFile!!.mkdirs() })
    private val alias = "byokit.$name"

    @Synchronized override fun read(id: String): Credential? = load().optJSONObject(id)?.let(Credential::fromJson)

    @Synchronized override fun write(id: String, credential: Credential?) {
        val all = load()
        if (credential == null) all.remove(id) else all.put(id, credential.toJson())
        val cipher = Cipher.getInstance(AES).apply { init(Cipher.ENCRYPT_MODE, key()) }
        val sealed = cipher.iv + cipher.doFinal(all.toString().toByteArray())
        val out = file.startWrite()
        try {
            out.write(sealed)
            file.finishWrite(out)
        } catch (e: Exception) {
            file.failWrite(out)
            throw e
        }
    }

    private fun load(): JSONObject {
        if (!file.baseFile.exists()) return JSONObject()
        val sealed = file.readFully()
        val cipher = Cipher.getInstance(AES).apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, 12)) }
        return JSONObject(String(cipher.doFinal(sealed, 12, sealed.size - 12)))
    }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build())
        }.generateKey()
    }

    private companion object { const val AES = "AES/GCM/NoPadding" }
}
