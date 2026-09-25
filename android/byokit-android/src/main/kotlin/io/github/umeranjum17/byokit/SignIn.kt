package io.github.umeranjum17.byokit

import java.io.IOException
import java.net.ConnectException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * "Sign in with ChatGPT", done entirely on the phone.
 *
 * - [Via.CODE] (default): a code the person types at auth.openai.com/codex/device, on this phone or any other screen.
 *   Proven on a phone; ChatGPT may need "device code sign-in" switched on in its Security settings first.
 * - [Via.BROWSER], only with [ChatGptAccount.browserSignIn]: the app listens on 127.0.0.1:1455 (the only return address
 *   Codex's sign-in accepts), shows [State.url] for the app to open in a Custom Tab, and catches the browser coming back.
 *   On Android 15+ the app must hold a short foreground service meanwhile, or the phone cuts the loopback once the app
 *   is behind the browser. Falls back to a code when port 1455 is taken.
 *
 * Phases: OPENING → WAITING → DONE | CANCELLED | EXPIRED | FAILED | OFFLINE. Nothing is kept unless it ends DONE with a
 * usable sign-in. [run] blocks until then, so call it on a background thread; [cancel] and [paste] work from any thread.
 */
class SignIn internal constructor(
    private val account: ChatGptAccount,
    private val via: Via,
    private val onChange: (State) -> Unit,
    private val timeoutMs: Long = 15 * 60_000,
) {
    enum class Via { BROWSER, CODE }
    enum class Phase { OPENING, WAITING, DONE, CANCELLED, EXPIRED, FAILED, OFFLINE }

    /** What the person sees: open [url] (and type [code] if there is one), always with a plain sentence in [words]. */
    data class State(val phase: Phase, val words: String, val url: String? = null, val code: String? = null, val expiresAt: Long? = null)

    private sealed interface Event {
        data object Cancel : Event
        data class Paste(val text: String) : Event
        data class Callback(val code: String) : Event
    }

    private val events = LinkedBlockingQueue<Event>()
    private val generation = account.register(this)
    private val api = account.api
    private val name = account.name
    private val deadline = api.now() + timeoutMs
    @Volatile var state: State = State(Phase.OPENING, say("signIn.opening"))
        private set

    fun cancel() = events.put(Event.Cancel)

    /** "Having trouble?": the address the browser ended on (or just its code), pasted back by the person. */
    fun paste(text: String) = events.put(Event.Paste(text))

    fun run(): State {
        emit(state)
        val end = try {
            val cred = when (via) {
                Via.BROWSER -> (if (account.browserSignIn) browser() else null) ?: code()
                Via.CODE -> code()
            }
            if (!account.complete(this, generation, cred)) throw Stop(State(Phase.CANCELLED, say("signIn.cancelled")))
            State(Phase.DONE, say("status.ready"))
        } catch (e: Stop) {
            e.state
        } catch (e: Exception) {
            val offline = e is UnknownHostException || e is ConnectException || e is SocketTimeoutException
            val key = if (offline) "signIn.offline" else signInWords(e.message ?: "")
            State(when (key) {
                "signIn.expired" -> Phase.EXPIRED
                "signIn.offline" -> Phase.OFFLINE
                else -> Phase.FAILED
            }, say(key))
        }
        account.finished(this)
        emit(end)
        return end
    }

    /** Browser sign-in with a loopback return; null when the port can't be had (then the code flow takes over). */
    private fun browser(): Credential? {
        val server = try {
            ServerSocket(ChatGpt.LOOPBACK_PORT, 8, InetAddress.getByName("127.0.0.1"))
        } catch (e: IOException) {
            return null
        }
        val verifier = ChatGpt.randomToken()
        val expected = ChatGpt.randomToken(16)
        val listener = thread(name = "byokit-loopback", isDaemon = true) { serve(server, expected) }
        try {
            emit(State(Phase.WAITING, say("signIn.waitingUrl"), url = api.authorizeUrl(ChatGpt.challengeOf(verifier), expected)))
            while (true) {
                val code = when (val e = next(deadline - api.now())) {
                    is Event.Callback -> e.code
                    is Event.Paste -> {
                        val (code, state) = ChatGpt.parsePaste(e.text)
                        if (state != null && state != expected) throw IOException("State mismatch")
                        code ?: continue
                    }
                    else -> continue
                }
                return api.exchange(code, verifier, ChatGpt.REDIRECT_URI)
            }
        } finally {
            server.close()
            listener.join(1000)
        }
    }

    /** Answers the browser's one request to http://localhost:1455/auth/callback?code=…&state=… */
    private fun serve(server: ServerSocket, expected: String) {
        while (!server.isClosed) {
            val socket = try { server.accept() } catch (e: SocketException) { return }
            socket.use { s ->
                s.soTimeout = 5000
                val line = runCatching { s.getInputStream().bufferedReader().readLine() }.getOrNull() ?: return@use
                val target = line.split(' ').getOrNull(1).orEmpty()
                val (code, state) = ChatGpt.parsePaste("http://localhost$target")
                val ok = target.startsWith("/auth/callback") && code != null && state == expected
                val page = if (ok) "Signed in. You can go back to the app." else "This sign-in link didn't match. Go back to the app and try again."
                s.getOutputStream().write(("HTTP/1.1 ${if (ok) "200 OK" else "400 Bad Request"}\r\n" +
                    "Content-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n" +
                    "<!doctype html><meta name=viewport content='width=device-width'><p style='font:18px sans-serif;margin:2em'>$page</p>").toByteArray())
                if (ok) events.put(Event.Callback(code!!))
            }
        }
    }

    private fun code(): Credential {
        val dc = api.startDeviceCode()
        emit(State(Phase.WAITING, say("signIn.waitingCode", mapOf("code" to dc.userCode)),
            url = ChatGpt.DEVICE_VERIFICATION_URI, code = dc.userCode, expiresAt = deadline))
        var intervalMs = maxOf(1000L, dc.intervalSeconds * 1000)
        while (true) {
            // Android 15+ cuts an app's network while it is behind the browser: a poll that can't get through waits for
            // the next, so the sign-in finishes once the person is back rather than ending "offline".
            val poll = try { api.pollDeviceCode(dc) } catch (e: IOException) { if (e is ChatGptException) throw e else Poll.Pending }
            when (val p = poll) {
                is Poll.Complete -> return api.exchange(p.authorizationCode, p.codeVerifier, ChatGpt.DEVICE_REDIRECT_URI)
                is Poll.Failed -> throw IOException(p.message)
                Poll.SlowDown -> intervalMs += 5000
                Poll.Pending -> {}
            }
            next(minOf(intervalMs, deadline - api.now())) // the wait between polls; only a cancel ends it early
        }
    }

    /** Waits up to [ms] for an event; a cancel or the deadline ends the sign-in. */
    private fun next(ms: Long): Event? {
        if (ms <= 0 && api.now() >= deadline) throw Stop(State(Phase.EXPIRED, say("signIn.tooLong")))
        val e = events.poll(maxOf(ms, 0), TimeUnit.MILLISECONDS)
        if (e == Event.Cancel) throw Stop(State(Phase.CANCELLED, say("signIn.cancelled")))
        if (e == null && api.now() >= deadline) throw Stop(State(Phase.EXPIRED, say("signIn.tooLong")))
        return e
    }

    private class Stop(val state: State) : Exception()

    private fun emit(s: State) {
        state = s
        onChange(s)
    }

    private fun say(key: String, vars: Map<String, String> = emptyMap()) = Byokit.say(key, vars + ("name" to name))
}
