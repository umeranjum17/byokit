package io.github.umeranjum17.byokit.overlay

import android.graphics.drawable.Drawable

/**
 * The bubble driven from Kotlin alone (docs/capability-kits.md 7.5): JS `overlay.start()` only runs inside a React
 * context, so after a reboot or process death it cannot restore the bubble. The app's own accessibility service keeps
 * a ServiceBubble instead: `start(config)` once (usually in onServiceConnected, with the persisted rules), and the
 * bubble shows as soon as the service attaches, and again after every rebind, until `stop()`.
 *
 * Main thread only, like the service's callbacks.
 */
class ServiceBubble(
  moods: (String) -> Drawable?,
  spots: SpotStore,
  reducedMotion: () -> Boolean = { false },
  private val bubbles: (OverlayHost) -> BubbleControl = { h -> Bubble(h, spots, moods, reducedMotion) },
  private val hosts: Listeners<OverlayHost?> = ByokitAccessibility.hosts,
  private val hostNow: () -> OverlayHost? = { ByokitAccessibility.host },
  private val foregroundNow: () -> ForegroundApp? = { ByokitAccessibility.foreground },
  private val keyboardNow: () -> KeyboardInset? = { ByokitAccessibility.keyboard },
) {
  data class Config(
    val mood: String,
    val label: String? = null,
    val rules: Rules = Rules(),
    val perAppSpots: Boolean = false,
  )

  /** Bubble events (tap, longPress, moved); the app opens its panel from these. There is no JS event bridge here. */
  val events = Listeners<OverlayEvent>()
  private var config: Config? = null
  private var bubble: BubbleControl? = null
  private var host: OverlayHost? = null
  private var app: String? = null
  private val watching = mutableListOf<() -> Unit>()
  private var unhost: (() -> Unit)? = null

  /** Remembers [config] and shows the bubble now when the service is attached, else on the next attach. */
  fun start(config: Config) {
    stop()
    this.config = config
    unhost = hosts.add(::hostChanged)
    hostNow()?.let(::show)
  }

  fun stop() {
    unhost?.invoke()
    unhost = null
    unwatch()
    bubble?.hide()
    bubble = null
    host = null
    config = null
  }

  fun say(text: String, mood: String? = null, ms: Long = 2500, announce: Boolean = false) {
    bubble?.say(text, mood, ms, announce)
  }

  fun setMood(mood: String) {
    config = config?.copy(mood = mood)
    bubble?.setMood(mood)
  }

  fun setLabel(label: String?) {
    config = config?.copy(label = label)
    bubble?.setLabel(label)
  }

  /** Persists nothing itself: the app passes back the rules it persisted, so they work before JS runs again. */
  fun setRules(rules: Rules) {
    config = config?.copy(rules = rules)
    refresh()
  }

  private fun show(h: OverlayHost) {
    val c = config ?: return
    host = h
    val b = bubbles(h)
    b.events.add(events::emit)
    bubble = b
    watch()
    b.spotKey = SpotStore.key(c.perAppSpots, app)
    b.setLabel(c.label)
    refresh()
  }

  private fun watch() {
    val b = bubble ?: return
    foregroundNow()?.let { f ->
      app = f.current
      watching += f.onChange(::appChanged)
    }
    keyboardNow()?.let { k ->
      b.imeTopPx = k.imeTopPx
      watching += k.onChange { b.imeTopPx = it }
    }
  }

  private fun appChanged(now: String?) {
    if (now == null) return
    app = now
    val b = bubble ?: return
    val key = SpotStore.key(config?.perAppSpots == true, now)
    if (key != b.spotKey) {
      b.hide()
      b.spotKey = key
    } // shown again below, at this app's spot
    refresh()
  }

  /** The bubble shows unless the rules hide it over this app. */
  private fun refresh() {
    val c = config ?: return
    val b = bubble ?: return
    if (c.rules.shows(app)) b.show(c.mood) else b.hide()
  }

  private fun unwatch() {
    watching.forEach { it() }
    watching.clear()
    app = null
  }

  private fun hostChanged(h: OverlayHost?) {
    if (config == null) return
    if (h != null) {
      if (host == null) show(h) // a rebind restores the bubble with the remembered config
    } else {
      unwatch()
      bubble?.hide()
      bubble = null
      host = null
    }
  }
}
