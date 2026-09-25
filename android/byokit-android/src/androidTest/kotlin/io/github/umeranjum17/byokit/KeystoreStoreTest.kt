package io.github.umeranjum17.byokit

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class KeystoreStoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val cred = Credential(SignInFlowTest.JWT, "rt_secret_refresh", 1_790_003_600_000, "acct_test_123")

    @Test fun sealedAtRestAndSurvivesANewInstance() {
        val name = "test-${System.nanoTime()}"
        KeystoreStore(context, name).write("chatgpt", cred)
        val file = File(context.noBackupFilesDir, "byokit/$name.sealed")
        val raw = String(file.readBytes(), Charsets.ISO_8859_1)
        assertFalse(raw.contains("rt_secret_refresh"))
        assertFalse(raw.contains("acct_test_123"))
        assertEquals(cred, KeystoreStore(context, name).read("chatgpt")) // a fresh instance, same Keystore key
        KeystoreStore(context, name).write("chatgpt", null)
        assertNull(KeystoreStore(context, name).read("chatgpt"))
    }

    @Test fun storesAreSeparate() {
        val a = KeystoreStore(context, "a-${System.nanoTime()}")
        val b = KeystoreStore(context, "b-${System.nanoTime()}")
        a.write("chatgpt", cred)
        assertNull(b.read("chatgpt"))
    }

}
