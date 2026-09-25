package io.github.umeranjum17.byokit

import java.io.IOException

/** What to show for an account, always with one plain sentence. */
data class Status(val state: State, val until: Long, val words: String) {
    enum class State { READY, RESTING, SIGNED_OUT }
}

/**
 * One person's ChatGPT plan inside this app: sign in, stay signed in, ask. Every call does network I/O, so call it off
 * the main thread (e.g. `withContext(Dispatchers.IO)`).
 */
class ChatGptAccount(
    val store: CredentialStore,
    val api: ChatGpt = ChatGpt(),
    val id: String = "chatgpt",
) {
    private val entry = Byokit.provider("chatgpt")
    val name: String = entry.getString("name")
    /** The grey-terms line to show next to the button: "Uses your ChatGPT plan. OpenAI may change this at any time." */
    val termsLine: String = Byokit.say("terms.grey", mapOf("name" to name, "company" to entry.getString("company")))
    val strongModel: String = entry.getJSONObject("models").getString("strong")
    val fastModel: String = entry.getJSONObject("models").optString("fast", strongModel)

    /** 0 when the account can be used; otherwise when it stops resting. */
    @Volatile var restingUntil: Long = 0
        private set
    @Volatile private var busy = false

    /** Starts "Sign in with ChatGPT". Run [SignIn.run] on a background thread; show [SignIn.State] as it changes. */
    fun signIn(via: SignIn.Via = SignIn.Via.BROWSER, onChange: (SignIn.State) -> Unit) = SignIn(this, via, onChange)

    val signedIn: Boolean get() = store.read(id) != null

    fun signOut() = store.write(id, null)

    /**
     * A credential good for at least [minValidityMs], refreshed if needed; null when signed out. Only the account refusing
     * the refresh signs it out: a network hiccup throws and keeps the sign-in.
     */
    @Synchronized fun credential(minValidityMs: Long = 5 * 60_000): Credential? {
        val cred = store.read(id) ?: return null
        if (cred.expires - api.now() > minValidityMs) return cred
        return try {
            api.refresh(cred.refresh).also { store.write(id, it) }
        } catch (e: ChatGptException) {
            if (e.limit?.kind != Kind.SIGNED_OUT) throw e
            store.write(id, null)
            null
        }
    }

    /**
     * One question to the person's plan. Throws [ChatGptException]: its `limit` says whether to rest (RATE_LIMIT with
     * `until`), try later (OVERLOADED), sign in again (SIGNED_OUT) or check the connection (NETWORK). The app falls back
     * to its own on-phone model in every case.
     */
    fun ask(input: String, instructions: String = "You are a helpful assistant.", model: String = strongModel): String {
        val now = api.now()
        if (restingUntil > now) throw ChatGptException(status().words, Limit(Kind.RATE_LIMIT, restingUntil))
        val cred = try {
            credential()
        } catch (e: IOException) {
            throw noted(e)
        } ?: throw ChatGptException(status().words, Limit(Kind.SIGNED_OUT, 0))
        return try {
            api.respond(cred, model, instructions, input).also { busy = false }
        } catch (e: IOException) {
            throw noted(e)
        }
    }

    private fun noted(e: IOException): ChatGptException {
        val limit = (e as? ChatGptException)?.limit ?: classify(e.message ?: "", api.now()) ?: Limit(Kind.NETWORK, 0)
        busy = limit.kind == Kind.OVERLOADED
        when (limit.kind) {
            // A limit that didn't say when it lifts rests for an hour, as Crewhouse does.
            Kind.RATE_LIMIT -> restingUntil = limit.until.takeIf { it > 0 } ?: (api.now() + 60 * 60_000)
            Kind.SIGNED_OUT -> store.write(id, null)
            else -> {}
        }
        return if (e is ChatGptException && e.limit == limit) e else ChatGptException(e.message ?: "network", limit)
    }

    fun status(): Status {
        val vars = mapOf("name" to name)
        return when {
            !signedIn -> Status(Status.State.SIGNED_OUT, 0, Byokit.say("status.signedOut", vars))
            restingUntil > api.now() -> Status(Status.State.RESTING, restingUntil,
                Byokit.say("status.resting", vars + ("until" to Byokit.clock(restingUntil))))
            busy -> Status(Status.State.READY, 0, Byokit.say("status.busy", vars))
            else -> Status(Status.State.READY, 0, Byokit.say("status.ready", vars))
        }
    }
}
