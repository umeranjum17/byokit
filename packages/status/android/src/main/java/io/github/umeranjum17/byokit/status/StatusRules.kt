package io.github.umeranjum17.byokit.status

// Pure rules for the status notification (docs/capability-kits.md 12.4, 12.5): no Android import, so the JVM tests
// cover them without a device.

data class Post(
  val title: String,
  val text: String,
  val chip: String,
  val publicText: String,
  val promote: Boolean,
  val actions: List<Pair<String, String>>,   // id to label
  val timeoutMs: Long,
  val icon: String?,
)

/** The last post: what it showed, when, and its timeout. */
data class Last(val signature: String, val at: Long, val timeoutMs: Long)

object StatusRules {
  const val CHIP_MAX = 7
  const val ACTIONS_MAX = 3
  const val THROTTLE_MS = 1500L
  const val TIMEOUT_SLACK_MS = 1000L
  private const val IMPORTANCE_MIN = 1   // NotificationManager.IMPORTANCE_MIN: a channel this low blocks promotion
  private val ACTION_ID = Regex("^[a-z][a-z0-9_]{0,31}$")
  private val ICON = Regex("^[a-z][a-z0-9_]{0,63}$")

  fun chipFits(chip: String): Boolean = chip.codePointCount(0, chip.length) <= CHIP_MAX

  /** The 12.3 option rules (the JS core checks them first); null when fine, else what is wrong. */
  fun check(p: Post): String? = when {
    p.title.isBlank() -> "title must not be empty"
    !chipFits(p.chip) -> "chip must be at most $CHIP_MAX characters"
    p.timeoutMs < 1000 -> "timeoutMs must be at least 1000"
    p.icon != null && !ICON.matches(p.icon) -> "icon must match $ICON"
    p.actions.size > ACTIONS_MAX -> "at most $ACTIONS_MAX actions"
    p.actions.any { !ACTION_ID.matches(it.first) } -> "action id must match $ACTION_ID"
    p.actions.any { it.second.isBlank() } -> "action label must not be empty"
    p.actions.map { it.first }.toSet().size != p.actions.size -> "action ids must be unique"
    else -> null
  }

  /** Whether the post can become a chip: the rest of Android's list (ongoing, no custom views, not colorized, not a
   * group summary) holds for every post StatusNotice builds. */
  fun promotable(p: Post, channelImportance: Int): Boolean =
    p.promote && p.title.isNotBlank() && chipFits(p.chip) && channelPromotable(channelImportance)

  /** A channel set to Minimum (or lower) never shows a chip. */
  fun channelPromotable(importance: Int): Boolean = importance > IMPORTANCE_MIN

  /** Every visible field, so an unchanged show() is recognised; not the timeout. */
  fun signature(p: Post): String =
    listOf(p.title, p.text, p.chip, p.publicText, p.promote.toString(), p.icon ?: "",
      p.actions.joinToString("\u0001") { "${it.first}\u0002${it.second}" }).joinToString("\u0000")

  sealed class Decision {
    object Show : Decision()
    object Drop : Decision()
    data class Later(val ms: Long) : Decision()
  }

  /** Show, drop or wait: a dismissal drops everything; an unchanged post is dropped until half its timeout has
   * passed (then it re-arms the timeout); posts are at most one per THROTTLE_MS. */
  fun decide(sig: String, now: Long, last: Last?, dismissed: Boolean): Decision {
    if (dismissed) return Decision.Drop
    if (last == null) return Decision.Show
    if (sig == last.signature && now - last.at < last.timeoutMs / 2) return Decision.Drop
    val wait = last.at + THROTTLE_MS - now
    return if (wait > 0) Decision.Later(wait) else Decision.Show
  }

  /** A delete from the person, not the timeout: a delete within TIMEOUT_SLACK_MS of the timeout is the timeout. */
  fun userDismissed(now: Long, last: Last?): Boolean =
    last == null || now < last.at + last.timeoutMs - TIMEOUT_SLACK_MS
}
