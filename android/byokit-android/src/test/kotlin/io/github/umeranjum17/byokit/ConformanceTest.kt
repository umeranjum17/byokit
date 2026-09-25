package io.github.umeranjum17.byokit

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/** The shared fixtures (fixtures/conformance) that @byokit/accounts passes too. */
class ConformanceTest {
    private val dir = File(System.getProperty("byokit.fixtures")!!)
    private fun fixture(name: String) = JSONObject(File(dir, "conformance/$name").readText())
    private fun JSONArray.each(f: (JSONObject) -> Unit) = (0 until length()).forEach { f(getJSONObject(it)) }
    private fun JSONObject.long(k: String) = if (isNull(k)) 0L else getLong(k)
    private fun JSONObject.str(k: String): String? = if (isNull(k)) null else getString(k)
    private fun JSONObject.flat() = keys().asSequence().associateWith { get(it) }

    @Test fun signInErrors() = fixture("signin-errors.json").getJSONArray("cases").each {
        assertEquals(it.getString("error"), it.getString("words"), signInWords(it.getString("error")))
    }

    @Test fun classifies() {
        val f = fixture("classify.json")
        f.getJSONArray("cases").each {
            val got = classify(it.getString("error"), f.getLong("now"))
            assertEquals(it.getString("error"), it.str("kind"), got?.kind?.name?.lowercase())
            assertEquals(it.getString("error"), it.long("until"), got?.until ?: 0L)
        }
    }

    @Test fun limitResponses() {
        val f = fixture("limit-responses.json")
        f.getJSONArray("cases").each {
            val (limit, message) = ChatGpt.limitFrom(it.getInt("status"), it.getString("body"), f.getLong("now"))
            assertEquals(it.getString("body"), it.str("kind"), limit?.kind?.name?.lowercase())
            assertEquals(it.long("until"), limit?.until ?: 0L)
            assertEquals(it.getString("message"), message)
        }
    }

    @Test fun tokenResponses() {
        val f = fixture("token-responses.json")
        f.getJSONArray("cases").each {
            val got = runCatching { ChatGpt.credentialFrom(it.getJSONObject("response"), f.getLong("now")) }
            if (it.optBoolean("error")) assertTrue(it.toString(), got.isFailure)
            else it.getJSONObject("credential").let { want ->
                assertEquals(want.getString("type"), got.getOrThrow().toJson().getString("type"))
                assertEquals(Credential.fromJson(want), got.getOrThrow())
            }
        }
    }

    @Test fun deviceCode() {
        val f = fixture("device-code.json")
        f.getJSONArray("start").each {
            val got = runCatching { ChatGpt.parseDeviceCode(it.getInt("status"), it.getString("body")) }
            if (it.optBoolean("error")) assertTrue(it.toString(), got.isFailure)
            else it.getJSONObject("result").let { r ->
                assertEquals(DeviceCode(r.getString("deviceAuthId"), r.getString("userCode"), r.getLong("intervalSeconds")), got.getOrThrow())
            }
        }
        f.getJSONArray("poll").each {
            val got = ChatGpt.parsePoll(it.getInt("status"), it.getString("body"))
            val want = when (it.getString("result")) {
                "complete" -> Poll.Complete(it.getString("authorizationCode"), it.getString("codeVerifier"))
                "pending" -> Poll.Pending
                "slow_down" -> Poll.SlowDown
                else -> null
            }
            if (want == null) assertTrue(it.toString(), got is Poll.Failed) else assertEquals(it.toString(), want, got)
        }
    }

    @Test fun paste() = fixture("paste.json").getJSONArray("cases").each {
        assertEquals(it.getString("input"), it.str("code") to it.str("state"), ChatGpt.parsePaste(it.getString("input")))
    }

    @Test fun sse() = fixture("sse.json").getJSONArray("cases").each {
        val got = runCatching { ChatGpt.readSse(it.getString("stream").reader().buffered(), 0) }
        val err = it.optJSONObject("error")
        if (err == null) assertEquals(it.getString("text"), got.getOrThrow())
        else {
            val e = got.exceptionOrNull() as? ChatGptException ?: return@each fail("expected an error: $it")
            assertEquals(err.getString("message"), e.message)
            assertEquals(err.getString("kind"), e.limit?.kind?.name?.lowercase())
        }
    }

    @Test fun revoke() {
        val f = fixture("revoke.json")
        assertEquals(f.getString("url"), ChatGpt().authBase + "/oauth/revoke")
        assertEquals(f.getString("clientId"), ChatGpt.CLIENT_ID)
        assertEquals(f.getString("clientId"), Byokit.provider("chatgpt").getString("clientId"))
        f.getJSONArray("cases").each {
            val server = MockWebServer()
            server.enqueue(if (it.get("answer") == "offline") MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                else MockResponse().setResponseCode(it.getInt("answer")))
            server.start()
            try {
                val account = ChatGptAccount(MemoryStore(), ChatGpt(authBase = server.url("/").toString().trimEnd('/')))
                it.optJSONObject("credential")?.let { c -> account.store.write(account.id, Credential.fromJson(c)) }
                val result = runCatching { account.signOut() }
                assertEquals(it.toString(), it.get("answer") == 200 || it.isNull("request"), result.isSuccess)
                assertEquals(it.toString(), false, account.signedIn) // deleted here whatever ChatGPT answered
                val want = it.optJSONObject("request")
                assertEquals(it.toString(), if (want == null) 0 else 1, server.requestCount)
                if (want != null) {
                    val r = server.takeRequest()
                    assertEquals("/oauth/revoke", r.path)
                    assertTrue(r.getHeader("Content-Type")!!.startsWith("application/json"))
                    assertEquals(want.flat(), JSONObject(r.body.readUtf8()).flat())
                }
            } finally {
                server.shutdown()
            }
        }
    }

    @Test fun wordsArePlain() {
        val banned = Regex(fixture("plain-words.json").getString("pattern"), RegexOption.IGNORE_CASE)
        val words = JSONObject(Byokit::class.java.getResourceAsStream("/byokit/words.json")!!.bufferedReader().readText())
        for (key in words.keys()) assertFalse(key, banned.containsMatchIn(words.getString(key).replace(Regex("\\{\\w+\\}"), "X")))
    }

    @Test fun catalogueHasNoClaude() {
        val ids = Byokit.catalogue.keys().asSequence().map { Byokit.catalogue.getJSONObject(it).getString("pi") }.toList()
        assertFalse(ids.contains("anthropic"))
        assertEquals("gpt-6-sol", ChatGptAccount(MemoryStore()).strongModel)
        assertEquals("Uses your ChatGPT plan. OpenAI may change this at any time.", ChatGptAccount(MemoryStore()).termsLine)
    }
}
