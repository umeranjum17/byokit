package io.github.umeranjum17.byokit.overlay

/** One insert's cancellation signal. Create before starting the worker; cancel on capture invalidation. */
class InsertCancellation {
  private var cancelled = false
  private var result: String? = null

  /** Idempotent; completed operations keep their result. An in-flight field action finishes before this returns. */
  @Synchronized fun cancel() { if (result == null) cancelled = true }

  /** Serializes cancellation with each field read/write and clipboard fallback. */
  @Synchronized internal fun <T> step(action: () -> T): T {
    if (cancelled) throw InsertCancelled()
    return action()
  }

  @Synchronized internal fun finish(value: String): String {
    if (result == null) result = if (cancelled) "cancelled" else value
    return result!!
  }
}

internal class InsertCancelled : RuntimeException()
