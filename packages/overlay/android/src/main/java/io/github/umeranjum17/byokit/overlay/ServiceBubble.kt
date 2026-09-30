package io.github.umeranjum17.byokit.overlay

import android.content.Context
import android.graphics.drawable.Drawable
import android.provider.Settings

/**
 * The bubble driven from Kotlin alone (docs/capability-kits.md 7.5): JS `overlay.start()` only runs inside a React
 * context, so after a reboot or process death it cannot restore the bubble. The app's own accessibility service keeps
 * a ServiceBubble instead: `start(config)` once (usually in onServiceConnected, with the persisted rules), and the
 * bubble shows as soon as the service attaches, and again after every rebind, until `stop()`. An app's own foreground
 * service passes its host instead (the secondary constructor): that bubble knows no foreground app, so it takes no
 * rules and shows everywhere. It hides while [PanelActivity] is on top (`Config.hideWhilePanelOpen`), and shows again
 * over another app the person switches to while the panel is still open; the app opens the panel from [events].
 *
 * Main thread only, like the service's callbacks.
 *
 * @param moods the drawable for a mood name ([drawables] resolves the app's drawables by name)
 * @param spots where the rest spot is remembered ([PrefsSpotStore])
 * @param reducedMotion whether to snap instead of glide ([reducedMotion] reads the system setting)
 * The remaining parameters are the kit's own sources (bubble view, host, foreground app, keyboard, panel and the
 * open panel's package), replaced in the JVM tests.
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
  private val panels: Listeners<Boolean> = PanelActivity.open,
  private val panelApp: () -> String? = { PanelActivity.current?.packageName },
) {
  /**
   * The bubble over [host], a window the app's own foreground service owns (`WindowOverlayHost(this)`): it shows on
   * [start] and goes on [stop]; the service calls [stop] in onDestroy. It knows no foreground app or keyboard, so the
   * rules and per-app spots do not apply and it does not rest above the keyboard.
   */
  constructor(
    host: OverlayHost,
    moods: (String) -> Drawable?,
    spots: SpotStore,
    reducedMotion: () -> Boolean = { false },
    bubbles: (OverlayHost) -> BubbleControl = { h -> Bubble(h, spots, moods, reducedMotion) },
  ) : this(
    moods, spots, reducedMotion, bubbles,
    hosts = Listeners(), hostNow = { host }, foregroundNow = { null }, keyboardNow = { null },
  )

  /**
   * What the bubble shows: its resting [mood], a TalkBack [label], the per-app [rules] (applied while the foreground
   * app is known), one rest spot per app with [perAppSpots], and whether it hides while the panel is open.
   */
  data class Config(
    val mood: String,
    val label: String? = null,
    val rules: Rules = Rules(),
    val perAppSpots: Boolean = false,
    val hideWhilePanelOpen: Boolean = true,
  )

  /** Bubble events (tap, longPress, moved); the app opens its panel from these. There is no JS event bridge here. */
  val events = Listeners<OverlayEvent>()
  private var config: Config? = null
  private var bubble: BubbleControl? = null
  private var host: OverlayHost? = null
  private var app: String? = null
  private var ruled = false
  private var panelOpen = false
  // The person switched to another app with the panel still open, so it no longer covers the bubble.
  private var leftPanel = false
  private val watching = mutableListOf<() -> Unit>()
  private var unhost: (() -> Unit)? = null
  private var unpanel: (() -> Unit)? = null

  /** Remembers [config] and shows the bubble now when the service is attached, else on the next attach. */
  fun start(config: Config) {
    stop()
    this.config = config
    unhost = hosts.add(::hostChanged)
    unpanel = panels.add(::panelChanged)
    panelOpen = panelApp() != null
    hostNow()?.let(::show)
  }

  /** Hides the bubble and forgets the config; later attaches show nothing until the next [start]. */
  fun stop() {
    unhost?.invoke()
    unhost = null
    unpanel?.invoke()
    unpanel = null
    panelOpen = false
    leftPanel = false
    unwatch()
    bubble?.hide()
    bubble = null
    host = null
    config = null
  }

  /** A pill next to the bubble for [ms], with [mood] meanwhile; [announce] reads it aloud to TalkBack. */
  fun say(text: String, mood: String? = null, ms: Long = 2500, announce: Boolean = false) {
    bubble?.say(text, mood, ms, announce)
  }

  /** The resting mood, kept for later shows. */
  fun setMood(mood: String) {
    config = config?.copy(mood = mood)
    bubble?.setMood(mood)
  }

  /** The TalkBack label, kept for later shows; null clears it. */
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
      ruled = true
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
    if (panelOpen) {
      // The panel is the app's own window over the app it opened from; the app is re-read when it closes.
      leftPanel = now != panelApp()
      if (!leftPanel) return refresh()
    }
    app = now
    val b = bubble ?: return
    val key = SpotStore.key(config?.perAppSpots == true, now)
    if (key != b.spotKey) {
      b.hide()
      b.spotKey = key
    } // shown again below, at this app's spot
    refresh()
  }

  /** The bubble shows unless the open panel hides it or, with the foreground app known, the rules hide it there. */
  private fun refresh() {
    val c = config ?: return
    val b = bubble ?: return
    val underPanel = panelOpen && !leftPanel && c.hideWhilePanelOpen
    if (underPanel || (ruled && !c.rules.shows(app))) b.hide() else b.show(c.mood)
  }

  private fun panelChanged(open: Boolean) {
    panelOpen = open
    leftPanel = false
    val now = if (open) null else foregroundNow()?.current
    if (now != null) appChanged(now) else refresh()
  }

  private fun unwatch() {
    watching.forEach { it() }
    watching.clear()
    app = null
    ruled = false
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

  companion object {
    /** Moods as the app's drawables by name (the config plugin copies them in), else the app's icon. */
    fun drawables(context: Context): (String) -> Drawable? = { name ->
      val id = context.resources.getIdentifier(name, "drawable", context.packageName)
      context.getDrawable(if (id != 0) id else context.applicationInfo.icon)
    }

    /** Whether the system asks for reduced motion (animator duration scale 0). */
    fun reducedMotion(context: Context): () -> Boolean = {
      Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
  }
}
