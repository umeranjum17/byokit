package io.github.umeranjum17.byokit

import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** The shared `catalogue.json` and `words.json` (fixtures/ in the byokit repo), bundled into the library. */
object Byokit {
    private fun resource(name: String) =
        Byokit::class.java.getResourceAsStream("/byokit/$name")!!.bufferedReader().use { it.readText() }

    val catalogue: JSONObject by lazy { JSONObject(resource("catalogue.json")) }
    private val words: JSONObject by lazy { JSONObject(resource("words.json")) }

    /** One provider's catalogue entry, by id ("chatgpt"). */
    fun provider(id: String): JSONObject {
        val all = catalogue.getJSONArray("providers")
        for (i in 0 until all.length()) if (all.getJSONObject(i).getString("id") == id) return all.getJSONObject(i)
        throw IllegalArgumentException("no such AI account: $id")
    }

    /** A plain sentence from words.json with its `{placeholders}` filled in. */
    fun say(key: String, vars: Map<String, String> = emptyMap()): String =
        vars.entries.fold(words.getString(key)) { s, (k, v) -> s.replace("{$k}", v) }

    /** "3:40 pm", or "Fri 3:40 pm" when it is not today: the time in "resting until …". */
    fun clock(t: Long, zone: ZoneId = ZoneId.systemDefault()): String {
        val at = Instant.ofEpochMilli(t).atZone(zone)
        val time = at.format(DateTimeFormatter.ofPattern("h:mm a", Locale.US)).lowercase(Locale.US)
        return if (at.toLocalDate() == LocalDate.now(zone)) time
        else at.format(DateTimeFormatter.ofPattern("EEE ", Locale.US)) + time
    }
}

private const val NETWORK = "fetch failed|network|ENOTFOUND|EAI_AGAIN|ECONN|timed? ?out|socket|unable to resolve host|failed to connect|connection (refused|reset)"
private fun re(p: String) = Regex(p, RegexOption.IGNORE_CASE)

/** A failed sign-in's message → the words.json key to show (fixtures/conformance/signin-errors.json). */
fun signInWords(error: String): String = when {
    re("expired|expire").containsMatchIn(error) -> "signin.expired"
    re("denied|declined|access_denied|rejected").containsMatchIn(error) -> "signin.declined"
    re(NETWORK).containsMatchIn(error) -> "signin.offline"
    re("device code.*(disabled|not enabled)|enable device").containsMatchIn(error) -> "signin.code_off"
    else -> "signin.failed"
}

/** Why a model call failed, in the kinds an app acts on, and until when the account rests (0 = it didn't say). */
enum class Kind { RATE_LIMIT, OVERLOADED, SIGNED_OUT, NETWORK }
data class Limit(val kind: Kind, val until: Long)

/** A failure message → its kind (fixtures/conformance/classify.json); null when it is none of them. */
fun classify(error: String, now: Long = System.currentTimeMillis()): Limit? {
    val mins = re("try again in ~?(\\d+)\\s*min").find(error)?.groupValues?.get(1)
    val until = mins?.let { now + it.toLong() * 60_000 } ?: 0
    val kind = when {
        re("usage limit|rate.?limit|quota|too many requests|\\b429\\b").containsMatchIn(error) -> Kind.RATE_LIMIT
        re("overloaded|high demand|\\b50[234]\\b|unavailable").containsMatchIn(error) -> Kind.OVERLOADED
        re("unauthori[sz]ed|\\b40[13]\\b|sign in again|expired|invalid.*token|authentication").containsMatchIn(error) -> Kind.SIGNED_OUT
        re(NETWORK).containsMatchIn(error) -> Kind.NETWORK
        else -> return null
    }
    return Limit(kind, until)
}
