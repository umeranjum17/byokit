package io.github.umeranjum17.byokit

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URI
import java.net.URL
import java.net.URLDecoder
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/** A fake ChatGPT sign-in: device code, token exchange, and the loopback return, driven end to end. Runs on JVM and device. */
class SignInFlowTest {
    private val server = MockWebServer()
    private val polls = AtomicInteger()
    private val tokenBodies = CopyOnWriteArrayList<String>()
    @Volatile private var pendingPolls = 1
    @Volatile private var usercodeStatus = 200
    @Volatile private var droppedPolls = 0
    private lateinit var account: ChatGptAccount
    private val states = CopyOnWriteArrayList<SignIn.State>()

    @Before fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/api/accounts/deviceauth/usercode" -> if (usercodeStatus != 200) MockResponse().setResponseCode(usercodeStatus)
                    else json("""{"device_auth_id":"da_1","user_code":"ABCD-12345","interval":"0"}""")
                "/api/accounts/deviceauth/token" -> if (polls.incrementAndGet() <= droppedPolls) MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                    else if (polls.get() <= droppedPolls + pendingPolls) MockResponse().setResponseCode(403)
                    else json("""{"authorization_code":"ac_device","code_verifier":"cv_device"}""")
                "/oauth/token" -> {
                    tokenBodies += request.body.readUtf8()
                    json("""{"access_token":"$JWT","refresh_token":"rt_1","expires_in":3600}""")
                }
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        val base = server.url("/").toString().trimEnd('/')
        account = ChatGptAccount(MemoryStore(), ChatGpt(authBase = base, apiBase = base), browserSignIn = true)
    }

    @After fun tearDown() = server.shutdown()

    private fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
    private fun start(via: SignIn.Via, timeoutMs: Long = 20_000): Pair<SignIn, Thread> {
        val s = SignIn(account, via, { states += it }, timeoutMs)
        return s to thread { s.run() }
    }
    private fun waiting(): SignIn.State {
        val until = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < until) {
            states.lastOrNull { it.phase == SignIn.Phase.WAITING }?.let { return it }
            Thread.sleep(20)
        }
        throw AssertionError("never waiting: $states")
    }
    private fun query(url: String) = URI(url).rawQuery.split('&').associate { it.substringBefore('=') to URLDecoder.decode(it.substringAfter('='), "UTF-8") }
    private fun get(url: String): Int = (URL(url).openConnection() as HttpURLConnection).run { responseCode.also { disconnect() } }

    @Test fun codeFlowSignsIn() {
        val (s, t) = start(SignIn.Via.CODE)
        val w = waiting()
        assertEquals("ABCD-12345", w.code)
        assertEquals(ChatGpt.DEVICE_VERIFICATION_URI, w.url)
        assertEquals("On the ChatGPT page, type this code: ABCD-12345", w.words)
        t.join(15_000)
        assertEquals(SignIn.Phase.DONE, s.state.phase)
        assertEquals("ChatGPT is connected.", s.state.words)
        assertEquals("acct_test_123", account.store.read("chatgpt")?.accountId)
        assertTrue(tokenBodies.single().contains("code=ac_device"))
        assertTrue(tokenBodies.single().contains("code_verifier=cv_device"))
        assertEquals(listOf(SignIn.Phase.OPENING, SignIn.Phase.WAITING, SignIn.Phase.DONE), states.map { it.phase })
    }

    @Test fun browserFlowCatchesTheLoopbackReturn() {
        val (s, t) = start(SignIn.Via.BROWSER)
        val w = waiting()
        assertNull(w.code)
        val q = query(w.url!!)
        assertEquals(ChatGpt.REDIRECT_URI, q["redirect_uri"])
        assertEquals(ChatGpt.CLIENT_ID, q["client_id"])
        assertEquals(400, get("http://127.0.0.1:1455/auth/callback?code=forged&state=wrong")) // someone else's return
        assertEquals(200, get("http://127.0.0.1:1455/auth/callback?code=ac_browser&state=${q["state"]}"))
        t.join(10_000)
        assertEquals(SignIn.Phase.DONE, s.state.phase)
        val body = tokenBodies.single()
        assertTrue(body.contains("code=ac_browser"))
        val verifier = URLDecoder.decode(body.substringAfter("code_verifier=").substringBefore('&'), "UTF-8")
        assertEquals(q["code_challenge"], ChatGpt.challengeOf(verifier)) // PKCE holds together
        assertNotNull(account.store.read("chatgpt"))
    }

    @Test fun pollsThatCantGetThroughWaitForTheNext() {
        droppedPolls = 2 // the app behind the browser on Android 15+: its network is cut for a while
        val (s, t) = start(SignIn.Via.CODE)
        t.join(15_000)
        assertEquals(SignIn.Phase.DONE, s.state.phase)
        assertEquals(4, polls.get())
    }

    @Test fun pastedAddressFinishesTheBrowserFlow() {
        val (s, t) = start(SignIn.Via.BROWSER)
        val state = query(waiting().url!!)["state"]
        s.paste("http://localhost:1455/auth/callback?code=ac_pasted&state=$state")
        t.join(10_000)
        assertEquals(SignIn.Phase.DONE, s.state.phase)
        assertTrue(tokenBodies.single().contains("code=ac_pasted"))
    }

    @Test fun codeIsTheDefaultAndBrowserNeedsTheFlag() {
        val s = account.signIn { states += it } // a code by default, even with the browser allowed
        thread { s.run() }.join(15_000)
        assertEquals("ABCD-12345", states.first { it.phase == SignIn.Phase.WAITING }.code)
        states.clear()
        account = ChatGptAccount(MemoryStore(), account.api)
        val b = SignIn(account, SignIn.Via.BROWSER, { states += it })
        thread { b.run() }.join(15_000)
        assertEquals("ABCD-12345", states.first { it.phase == SignIn.Phase.WAITING }.code) // no flag: a code, never the loopback
        assertEquals(SignIn.Phase.DONE, b.state.phase)
    }

    @Test fun busyPortFallsBackToACode() {
        ServerSocket(1455, 1, InetAddress.getByName("127.0.0.1")).use {
            val (s, t) = start(SignIn.Via.BROWSER)
            assertEquals("ABCD-12345", waiting().code)
            t.join(15_000)
            assertEquals(SignIn.Phase.DONE, s.state.phase)
        }
    }

    @Test fun cancelKeepsNothing() {
        pendingPolls = Int.MAX_VALUE
        val (s, t) = start(SignIn.Via.CODE)
        waiting()
        s.cancel()
        t.join(5_000)
        assertEquals(SignIn.Phase.CANCELLED, s.state.phase)
        assertEquals("Sign-in stopped. Nothing was kept.", s.state.words)
        assertNull(account.store.read("chatgpt"))
    }

    @Test fun signOutDiscardsAnExchangeAlreadyInFlight() {
        val exchanging = CountDownLatch(1)
        val release = CountDownLatch(1)
        val revoked = CopyOnWriteArrayList<String>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/api/accounts/deviceauth/usercode" -> json("""{"device_auth_id":"da_1","user_code":"ABCD-12345","interval":"0"}""")
                "/api/accounts/deviceauth/token" -> json("""{"authorization_code":"ac_device","code_verifier":"cv_device"}""")
                "/oauth/token" -> {
                    exchanging.countDown()
                    assertTrue(release.await(5, TimeUnit.SECONDS))
                    json("""{"access_token":"$JWT","refresh_token":"rt_late","expires_in":3600}""")
                }
                "/oauth/revoke" -> {
                    revoked += request.body.readUtf8()
                    MockResponse().setResponseCode(200)
                }
                else -> MockResponse().setResponseCode(404)
            }
        }
        val (s, t) = start(SignIn.Via.CODE)
        assertTrue(exchanging.await(10, TimeUnit.SECONDS))
        try { account.signOut() } finally { release.countDown() }
        t.join(10_000)
        assertEquals(SignIn.Phase.CANCELLED, s.state.phase)
        assertNull(account.store.read("chatgpt"))
        assertTrue(revoked.single().contains("rt_late"))
    }

    @Test fun tooLongExpires() {
        pendingPolls = Int.MAX_VALUE
        val (s, t) = start(SignIn.Via.CODE, timeoutMs = 1500)
        t.join(10_000)
        assertEquals(SignIn.Phase.EXPIRED, s.state.phase)
        assertEquals("The sign-in took too long. Tap Sign in with ChatGPT to start again.", s.state.words)
    }

    @Test fun deviceCodeSwitchedOff() {
        usercodeStatus = 404
        val (s, t) = start(SignIn.Via.CODE)
        t.join(5_000)
        assertEquals(SignIn.Phase.FAILED, s.state.phase)
        assertTrue(s.state.words, s.state.words.contains("turn on device code sign-in"))
    }

    @Test fun offline() {
        account = ChatGptAccount(MemoryStore(), ChatGpt(authBase = "http://127.0.0.1:1"))
        val (s, t) = start(SignIn.Via.CODE)
        t.join(5_000)
        assertEquals(SignIn.Phase.OFFLINE, s.state.phase)
        assertEquals("Couldn't reach ChatGPT. Check the internet connection, then tap Sign in again.", s.state.words)
    }

    companion object {
        /** Unsigned JWT whose payload carries chatgpt_account_id "acct_test_123" (as in fixtures/conformance/token-responses.json). */
        const val JWT = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF90ZXN0XzEyMyJ9LCJleHAiOjE3OTAwMDM2MDB9.sig"
    }
}
