package io.github.umeranjum17.byokit

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** A ChatGPT sign-in, in the same shape pi-ai stores (`{type:"oauth",access,refresh,expires,accountId}`). */
data class Credential(val access: String, val refresh: String, val expires: Long, val accountId: String) {
    fun toJson(): JSONObject = JSONObject().put("type", "oauth").put("access", access).put("refresh", refresh)
        .put("expires", expires).put("accountId", accountId)

    companion object {
        fun fromJson(o: JSONObject) = Credential(o.getString("access"), o.getString("refresh"), o.getLong("expires"), o.getString("accountId"))
    }
}

/** A failure the person can act on: its kind decides the words ("resting until 3:40pm", "signed out"). */
class ChatGptException(message: String, val limit: Limit? = null) : IOException(message)

data class DeviceCode(val deviceAuthId: String, val userCode: String, val intervalSeconds: Long)

sealed interface Poll {
    data object Pending : Poll
    data object SlowDown : Poll
    data class Complete(val authorizationCode: String, val codeVerifier: String) : Poll
    data class Failed(val message: String) : Poll
}

/**
 * ChatGPT's sign-in and model endpoints, the ones Codex (and pi-ai's `openai-codex`) use. Plain HTTP, so it runs on any
 * thread but the main one. Base URLs are overridable only so tests can point it at a mock.
 */
class ChatGpt(
    val authBase: String = "https://auth.openai.com",
    val apiBase: String = "https://chatgpt.com/backend-api",
    val originator: String = "byokit",
    val now: () -> Long = System::currentTimeMillis,
) {
    fun authorizeUrl(challenge: String, state: String): String = "$authBase/oauth/authorize?" + form(
        "response_type" to "code", "client_id" to CLIENT_ID, "redirect_uri" to REDIRECT_URI, "scope" to SCOPE,
        "code_challenge" to challenge, "code_challenge_method" to "S256", "state" to state,
        "id_token_add_organizations" to "true", "codex_cli_simplified_flow" to "true", "originator" to originator,
    )

    fun startDeviceCode(): DeviceCode {
        val (status, body) = post("$authBase/api/accounts/deviceauth/usercode", JSONObject().put("client_id", CLIENT_ID))
        return parseDeviceCode(status, body)
    }

    fun pollDeviceCode(dc: DeviceCode): Poll {
        val (status, body) = post("$authBase/api/accounts/deviceauth/token",
            JSONObject().put("device_auth_id", dc.deviceAuthId).put("user_code", dc.userCode))
        return parsePoll(status, body)
    }

    fun exchange(code: String, verifier: String, redirectUri: String): Credential = token(
        "grant_type" to "authorization_code", "client_id" to CLIENT_ID, "code" to code,
        "code_verifier" to verifier, "redirect_uri" to redirectUri,
    )

    /** A new access token. Throws [ChatGptException] with kind SIGNED_OUT when the account refuses. */
    fun refresh(refreshToken: String): Credential =
        token("grant_type" to "refresh_token", "refresh_token" to refreshToken, "client_id" to CLIENT_ID)

    private fun token(vararg fields: Pair<String, String>): Credential {
        val (status, body) = request("$authBase/oauth/token", "application/x-www-form-urlencoded", form(*fields))
        if (status !in 200..299) {
            val refused = status in 400..403
            throw ChatGptException("ChatGPT sign-in failed ($status): $body", if (refused) Limit(Kind.SIGNED_OUT, 0) else null)
        }
        val json = runCatching { JSONObject(body) }.getOrElse { throw ChatGptException("ChatGPT sign-in answered oddly: $body") }
        return credentialFrom(json, now())
    }

    /**
     * Ends a sign-in at ChatGPT too, as Codex's own logout does (openai/codex#17825): the refresh token, else the access
     * token, one request, never retried (fixtures/conformance/revoke.json). Throws on failure; [ChatGptAccount.signOut]
     * deletes the sign-in here whatever it answers.
     */
    fun revoke(cred: Credential) {
        val body = if (cred.refresh.isNotEmpty()) JSONObject().put("token", cred.refresh).put("token_type_hint", "refresh_token").put("client_id", CLIENT_ID)
            else JSONObject().put("token", cred.access).put("token_type_hint", "access_token")
        val (status, text) = request("$authBase/oauth/revoke", "application/json", body.toString(), timeoutMs = 10_000, noReplay = true)
        if (status !in 200..299) throw ChatGptException("ChatGPT sign-out failed ($status): $text")
    }

    /** One question, one answer: a streamed Responses call collected into its text. */
    fun respond(cred: Credential, model: String, instructions: String, input: String): String {
        val body = JSONObject().put("model", model).put("store", false).put("stream", true)
            .put("instructions", instructions)
            .put("input", JSONArray().put(JSONObject().put("role", "user")
                .put("content", JSONArray().put(JSONObject().put("type", "input_text").put("text", input)))))
            .put("text", JSONObject().put("verbosity", "low"))
            .put("reasoning", JSONObject().put("effort", "none")) // pi-ai's default for gpt-6-sol and -luna (thinking off)
        val c = open("$apiBase/codex/responses", "application/json", body.toString(), mapOf(
            "Authorization" to "Bearer ${cred.access}", "chatgpt-account-id" to cred.accountId,
            "OpenAI-Beta" to "responses=experimental", "accept" to "text/event-stream",
        ))
        try {
            if (c.responseCode !in 200..299) {
                val err = limitFrom(c.responseCode, c.errorStream?.bufferedReader()?.use { it.readText() } ?: "", now())
                throw ChatGptException(err.second, err.first)
            }
            return c.inputStream.bufferedReader().use { readSse(it, now()) }
        } finally {
            c.disconnect()
        }
    }

    private fun post(url: String, json: JSONObject) = request(url, "application/json", json.toString())

    private fun request(url: String, type: String, body: String, timeoutMs: Int = 120_000, noReplay: Boolean = false): Pair<Int, String> {
        val c = open(url, type, body, timeoutMs = timeoutMs, noReplay = noReplay)
        try {
            val status = c.responseCode
            val text = (if (status in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            return status to text
        } finally {
            c.disconnect()
        }
    }

    private fun open(url: String, type: String, body: String, headers: Map<String, String> = emptyMap(), timeoutMs: Int = 120_000, noReplay: Boolean = false): HttpURLConnection {
        val c = URL(url).openConnection() as HttpURLConnection
        c.requestMethod = "POST"
        c.connectTimeout = minOf(15_000, timeoutMs)
        c.readTimeout = timeoutMs
        c.doOutput = true
        c.setRequestProperty("Content-Type", type)
        c.setRequestProperty("originator", originator)
        c.setRequestProperty("User-Agent", "byokit-android/0.1")
        headers.forEach(c::setRequestProperty)
        val bytes = body.toByteArray()
        if (noReplay) c.setFixedLengthStreamingMode(bytes.size)
        c.outputStream.use { it.write(bytes) }
        return c
    }

    companion object {
        const val CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
        /** The only browser redirect Codex's client accepts: a phone app catches it with a loopback listener. */
        const val REDIRECT_URI = "http://localhost:1455/auth/callback"
        const val LOOPBACK_PORT = 1455
        const val DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback"
        const val DEVICE_VERIFICATION_URI = "https://auth.openai.com/codex/device"
        const val SCOPE = "openid profile email offline_access"

        private fun form(vararg fields: Pair<String, String>) =
            fields.joinToString("&") { (k, v) -> "$k=" + URLEncoder.encode(v, "UTF-8").replace("+", "%20") }

        private val random = SecureRandom()
        private fun b64(bytes: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        fun randomToken(bytes: Int = 32) = b64(ByteArray(bytes).also(random::nextBytes))
        fun challengeOf(verifier: String) = b64(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))

        // Parsers, one per conformance fixture (fixtures/conformance/*.json).

        fun parseDeviceCode(status: Int, body: String): DeviceCode {
            if (status == 404) throw ChatGptException("OpenAI Codex device code login is not enabled for this server.")
            if (status !in 200..299) throw ChatGptException("OpenAI Codex device code request failed with status $status: $body")
            val o = JSONObject(body)
            val interval = when (val i = o.opt("interval")) {
                is Number -> i.toLong()
                is String -> i.trim().toLongOrNull()
                else -> null
            }
            val id = o.optString("device_auth_id")
            val code = o.optString("user_code")
            if (id.isEmpty() || code.isEmpty() || interval == null || interval < 0) throw ChatGptException("Invalid device code response: $body")
            return DeviceCode(id, code, interval)
        }

        fun parsePoll(status: Int, body: String): Poll {
            if (status in 200..299) {
                val o = runCatching { JSONObject(body) }.getOrNull()
                val code = o?.optString("authorization_code").orEmpty()
                val verifier = o?.optString("code_verifier").orEmpty()
                return if (code.isNotEmpty() && verifier.isNotEmpty()) Poll.Complete(code, verifier)
                else Poll.Failed("Invalid device auth token response: $body")
            }
            if (status == 403 || status == 404) return Poll.Pending
            val err = runCatching { JSONObject(body).opt("error") }.getOrNull()
            return when (if (err is JSONObject) err.optString("code") else err as? String) {
                "deviceauth_authorization_pending" -> Poll.Pending
                "slow_down" -> Poll.SlowDown
                else -> Poll.Failed("OpenAI Codex device auth failed with status $status: $body")
            }
        }

        fun credentialFrom(o: JSONObject, now: Long): Credential {
            val access = o.opt("access_token") as? String
            val refresh = o.opt("refresh_token") as? String
            val expiresIn = o.opt("expires_in") as? Number
            if (access == null || refresh == null || expiresIn == null) throw ChatGptException("Token response missing fields")
            val accountId = accountIdOf(access) ?: throw ChatGptException("Failed to extract accountId from token")
            return Credential(access, refresh, now + expiresIn.toLong() * 1000, accountId)
        }

        fun accountIdOf(jwt: String): String? = runCatching {
            val parts = jwt.split(".")
            if (parts.size != 3) return null
            val payload = JSONObject(String(Base64.getUrlDecoder().decode(parts[1])))
            payload.optJSONObject("https://api.openai.com/auth")?.optString("chatgpt_account_id")?.ifEmpty { null }
        }.getOrNull()

        /** An error response → (its kind, the message to keep). Mirrors pi-ai's "You have hit your ChatGPT usage limit". */
        fun limitFrom(status: Int, body: String, now: Long): Pair<Limit?, String> {
            val err = runCatching { JSONObject(body).optJSONObject("error") }.getOrNull()
            val code = err?.optString("code")?.ifEmpty { null } ?: err?.optString("type").orEmpty()
            if (Regex("usage_limit_reached|usage_not_included|rate_limit_exceeded", RegexOption.IGNORE_CASE).containsMatchIn(code) || status == 429) {
                val plan = err?.optString("plan_type")?.ifEmpty { null }?.let { " (${it.lowercase()} plan)" } ?: ""
                val resets = err?.optLong("resets_at", 0) ?: 0
                val mins = if (resets > 0) " Try again in ~${maxOf(0, Math.round((resets * 1000 - now) / 60_000.0))} min." else ""
                return Limit(Kind.RATE_LIMIT, resets * 1000) to "You have hit your ChatGPT usage limit$plan.$mins"
            }
            val message = err?.optString("message")?.ifEmpty { null } ?: body.ifEmpty { "Request failed" }
            val kind = when (status) {
                401, 403 -> Kind.SIGNED_OUT
                500, 502, 503, 504 -> Kind.OVERLOADED
                else -> null
            }
            return kind?.let { Limit(it, 0) } to message
        }

        /** A streamed answer → its text; an error event → [ChatGptException]. */
        fun readSse(reader: BufferedReader, now: Long): String {
            val text = StringBuilder()
            var completed: JSONObject? = null
            val data = StringBuilder()
            fun event() {
                val raw = data.toString().trim()
                data.setLength(0)
                if (raw.isEmpty() || raw == "[DONE]") return
                val e = JSONObject(raw)
                when (e.optString("type")) {
                    "response.output_text.delta" -> text.append(e.optString("delta"))
                    "response.completed" -> completed = e.optJSONObject("response")
                    "error" -> fail(e.optString("message", "ChatGPT stopped answering"), now)
                    "response.failed" -> fail(e.optJSONObject("response")?.optJSONObject("error")?.optString("message") ?: "ChatGPT stopped answering", now)
                }
            }
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) event() else if (line.startsWith("data:")) data.append(line.substring(5).trim()).append('\n')
            }
            event()
            if (text.isEmpty()) {
                val output = completed?.optJSONArray("output") ?: JSONArray()
                for (i in 0 until output.length()) {
                    val content = output.getJSONObject(i).optJSONArray("content") ?: continue
                    for (j in 0 until content.length()) content.getJSONObject(j).takeIf { it.optString("type") == "output_text" }
                        ?.let { text.append(it.optString("text")) }
                }
            }
            return text.toString()
        }

        private fun fail(message: String, now: Long): Nothing = throw ChatGptException(message, classify(message, now))

        /** "Having trouble?": what a person pasted back → (code, state). */
        fun parsePaste(input: String): Pair<String?, String?> {
            val v = input.trim()
            if (v.isEmpty()) return null to null
            val query = when {
                Regex("^[a-z][a-z0-9+.-]*://", RegexOption.IGNORE_CASE).containsMatchIn(v) -> v.substringAfter('?', "").substringBefore('#')
                v.contains('#') -> return v.substringBefore('#') to v.substringAfter('#')
                v.contains("code=") -> v
                else -> return v to null
            }
            val params = query.split('&').mapNotNull { p -> p.split('=', limit = 2).takeIf { it.size == 2 } }
                .associate { (k, value) -> k to java.net.URLDecoder.decode(value, "UTF-8") }
            return params["code"] to params["state"]
        }
    }
}
