package io.github.umeranjum17.byokit.overlay

import java.util.concurrent.CopyOnWriteArrayList

/** What the bubble reports; OverlayModule maps each to the JS OverlayEvent (docs/capability-kits.md 7.3). */
sealed class OverlayEvent {
  object Tap : OverlayEvent()
  object LongPress : OverlayEvent()
  data class Moved(val spot: Spot) : OverlayEvent()
  data class State(val state: String) : OverlayEvent()
  data class Panel(val open: Boolean) : OverlayEvent()
}

/** A listener set: add returns its own remover, and one throwing listener never stops the rest. */
class Listeners<T> {
  // A wrapper per add, so the same function added twice is removed once per remover (as in the JS core).
  private class Entry<T>(val fn: (T) -> Unit)
  private val entries = CopyOnWriteArrayList<Entry<T>>()

  fun add(fn: (T) -> Unit): () -> Unit {
    val entry = Entry(fn)
    entries.add(entry)
    return { entries.remove(entry) }
  }

  fun emit(e: T) {
    for (entry in entries) {
      try { entry.fn(e) } catch (_: Exception) { /* the others still run */ }
    }
  }
}
