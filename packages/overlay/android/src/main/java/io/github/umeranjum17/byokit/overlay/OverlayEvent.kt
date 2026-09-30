package io.github.umeranjum17.byokit.overlay

import java.util.concurrent.CopyOnWriteArrayList

/** What the bubble reports; OverlayModule maps each to the JS OverlayEvent (docs/capability-kits.md 7.3). */
sealed class OverlayEvent {
  /** The bubble was tapped. */
  object Tap : OverlayEvent()
  /** The bubble was long-pressed. */
  object LongPress : OverlayEvent()
  /** The bubble was dragged and came to rest at [spot]. */
  data class Moved(val spot: Spot) : OverlayEvent()
  /** The JS module's state changed ('on', 'off', 'stuck', 'needs-permission'). */
  data class State(val state: String) : OverlayEvent()
  /** The panel opened or closed. */
  data class Panel(val open: Boolean) : OverlayEvent()
}

/** A listener set: add returns its own remover, and one throwing listener never stops the rest. */
class Listeners<T> {
  // A wrapper per add, so the same function added twice is removed once per remover (as in the JS core).
  private class Entry<T>(val fn: (T) -> Unit)
  private val entries = CopyOnWriteArrayList<Entry<T>>()

  /** Adds [fn]; the returned function removes it. */
  fun add(fn: (T) -> Unit): () -> Unit {
    val entry = Entry(fn)
    entries.add(entry)
    return { entries.remove(entry) }
  }

  /** Calls every listener with [e]. */
  fun emit(e: T) {
    for (entry in entries) {
      try { entry.fn(e) } catch (_: Exception) { /* the others still run */ }
    }
  }
}
