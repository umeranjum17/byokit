package io.github.umeranjum17.byokit.share

class ShareInbox<I, R>(private val folders: () -> List<Long>, private val delete: (Long) -> Unit, private val wipeAll: () -> Unit) {
  private var seq = 0L
  // ponytail: one pending slot, last wins; use a queue when consumers need bursts.
  private var pending: Pair<Long, I>? = null
  private var last: Pair<Long, R>? = null
  private var watermark = 0L
  private val inFlight = mutableSetOf<Long>()
  private var wiped = false
  @Synchronized fun offer(i: I): Long { pending = ++seq to i; return seq }
  @Synchronized fun take(): Pair<Long, I>? {
    if (!wiped) { wipeAll(); wiped = true }
    val p = pending ?: return null
    pending = null
    inFlight += p.first
    val keep = inFlight + listOfNotNull(last?.first)
    folders().filter { it !in keep }.forEach(delete)
    return p
  }
  @Synchronized fun done(s: Long, r: R): Boolean {
    inFlight -= s
    if (s <= watermark) return false
    watermark = s
    last = s to r
    return true
  }
  @Synchronized fun requeue(p: Pair<Long, I>) {
    inFlight -= p.first
    if (pending == null) pending = p
  }
  @Synchronized fun current(): Pair<Long, R>? = last
  @Synchronized fun clear(s: Long) {
    if (s <= 0) return
    if (last?.first == s) last = null
    if (s > watermark) watermark = s
  }
  @Synchronized fun hasPending() = pending != null
}
