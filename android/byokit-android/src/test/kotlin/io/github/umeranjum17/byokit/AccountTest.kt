package io.github.umeranjum17.byokit

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Staying signed in, asking, and resting, against a fake ChatGPT. */
class AccountTest {
    private val server = MockWebServer()
    private var now = 1_790_000_000_000L
    private lateinit var account: ChatGptAccount
    private val jwt = SignInFlowTest.JWT

    @Before fun setUp() {
        server.start()
        val base = server.url("/").toString().trimEnd('/')
        account = ChatGptAccount(MemoryStore(), ChatGpt(authBase = base, apiBase = base, now = { now }))
    }

    @After fun tearDown() = server.shutdown()

    private fun signedIn(expires: Long = now + 3_600_000) = account.store.write("chatgpt", Credential(jwt, "rt_old", expires, "acct_test_123"))
    private fun token() = MockResponse().setBody("""{"access_token":"$jwt","refresh_token":"rt_new","expires_in":3600}""")
    private fun sse(vararg events: String) = MockResponse().setHeader("Content-Type", "text/event-stream")
        .setBody(events.joinToString("") { "data: $it\n\n" })
    private fun asking(): ChatGptException = try {
        account.ask("hi")
        throw AssertionError("expected a failure")
    } catch (e: ChatGptException) { e }

    @Test fun asksWithTheRightHeadersAndBody() {
        signedIn()
        server.enqueue(sse("""{"type":"response.output_text.delta","delta":"Hi "}""", """{"type":"response.output_text.delta","delta":"there"}""", """{"type":"response.completed","response":{}}"""))
        assertEquals("Hi there", account.ask("hello", instructions = "Be brief."))
        val r = server.takeRequest()
        assertEquals("/codex/responses", r.path)
        assertEquals("Bearer $jwt", r.getHeader("Authorization"))
        assertEquals("acct_test_123", r.getHeader("chatgpt-account-id"))
        assertEquals("byokit", r.getHeader("originator"))
        val body = JSONObject(r.body.readUtf8())
        assertEquals("gpt-6-sol", body.getString("model"))
        assertEquals(false, body.getBoolean("store"))
        assertEquals("Be brief.", body.getString("instructions"))
        assertEquals("none", body.getJSONObject("reasoning").getString("effort"))
        assertEquals("hello", body.getJSONArray("input").getJSONObject(0).getJSONArray("content").getJSONObject(0).getString("text"))
    }

    @Test fun refreshesAheadOfExpiry() {
        signedIn(expires = now + 60_000)
        server.enqueue(token())
        assertEquals("rt_new", account.credential()?.refresh)
        assertEquals("rt_new", account.store.read("chatgpt")?.refresh)
        assertTrue(server.takeRequest().body.readUtf8().contains("grant_type=refresh_token&refresh_token=rt_old"))
    }

    @Test fun signOutWaitsForRefreshAndRevokesRotatedToken() {
        signedIn(expires = now)
        val refreshing = CountDownLatch(1)
        val release = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/oauth/token" -> {
                    refreshing.countDown()
                    if (!release.await(5, TimeUnit.SECONDS)) throw AssertionError("refresh was not released")
                    token()
                }
                "/oauth/revoke" -> MockResponse().setResponseCode(200)
                else -> MockResponse().setResponseCode(404)
            }
        }
        var refreshed: Credential? = null
        val refresh = Thread { refreshed = account.credential() }.apply { start() }
        assertTrue(refreshing.await(5, TimeUnit.SECONDS))
        val signOut = Thread { account.signOut() }.apply { start() }
        try {
            assertTrue((1..100).any {
                if (signOut.state == Thread.State.BLOCKED) true else { Thread.sleep(10); false }
            })
        } finally {
            release.countDown()
            refresh.join(5_000)
            signOut.join(5_000)
        }
        assertEquals("rt_new", refreshed?.refresh)
        assertTrue(server.takeRequest().body.readUtf8().contains("refresh_token=rt_old"))
        assertEquals("rt_new", JSONObject(server.takeRequest().body.readUtf8()).getString("token"))
        assertNull(account.credential())
    }

    @Test fun refusedRefreshSignsOut() {
        signedIn(expires = now)
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"invalid_grant"}"""))
        assertNull(account.credential())
        assertEquals(Status.State.SIGNED_OUT, account.status().state)
        assertEquals("ChatGPT isn't signed in yet.", account.status().words)
    }

    @Test fun flakyRefreshKeepsTheSignIn() {
        signedIn(expires = now)
        server.enqueue(MockResponse().setResponseCode(502))
        assertEquals(Kind.OVERLOADED, asking().limit?.kind)
        assertEquals("rt_old", account.store.read("chatgpt")?.refresh)
    }

    @Test fun usageLimitRestsUntilItLifts() {
        signedIn(expires = now + 10 * 3_600_000)
        val resets = now / 1000 + 3600
        server.enqueue(MockResponse().setResponseCode(429).setBody("""{"error":{"code":"usage_limit_reached","plan_type":"PLUS","resets_at":$resets}}"""))
        val e = asking()
        assertEquals(Limit(Kind.RATE_LIMIT, resets * 1000), e.limit)
        assertEquals("You have hit your ChatGPT usage limit (plus plan). Try again in ~60 min.", e.message)
        val status = account.status()
        assertEquals(Status.State.RESTING, status.state)
        assertEquals("ChatGPT is resting until ${Byokit.clock(resets * 1000)}.", status.words)
        assertEquals(Kind.RATE_LIMIT, asking().limit?.kind) // no second call while resting
        assertEquals(1, server.requestCount)
        now = resets * 1000 + 1
        server.enqueue(sse("""{"type":"response.output_text.delta","delta":"back"}"""))
        assertEquals("back", account.ask("hi"))
    }

    @Test fun rejectedTokenSignsOut() {
        signedIn()
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":{"message":"Provided authentication token is expired."}}"""))
        assertEquals(Kind.SIGNED_OUT, asking().limit?.kind)
        assertEquals(false, account.signedIn)
    }

    @Test fun overloadedSaysBusy() {
        signedIn()
        server.enqueue(sse("""{"type":"response.failed","response":{"error":{"message":"The model is overloaded."}}}"""))
        assertEquals(Kind.OVERLOADED, asking().limit?.kind)
        assertEquals("ChatGPT is busy right now.", account.status().words)
    }

    @Test fun signedOutAskNeedsNoNetwork() {
        assertEquals(Kind.SIGNED_OUT, asking().limit?.kind)
        assertEquals(0, server.requestCount)
    }
}
