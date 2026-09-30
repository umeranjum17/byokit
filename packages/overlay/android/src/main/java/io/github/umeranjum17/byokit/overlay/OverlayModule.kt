package io.github.umeranjum17.byokit.overlay

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** The JS foreground notice as a record. */
class NoticeRecord : Record {
  @Field val channel: String = ""
  @Field val title: String = ""
  @Field val text: String = ""
  @Field val icon: String = ""
}

/** The JS rules as a record. */
class RulesRecord : Record {
  @Field val paused: Boolean = false
  @Field val on: List<String> = emptyList()
  @Field val off: List<String> = emptyList()
  @Field val defaults: List<String> = emptyList()
}

/** The JS start options as a record. */
class StartRecord : Record {
  @Field val host: String = "window"
  @Field val mood: String = ""
  @Field val notice: NoticeRecord? = null
  @Field val rules: RulesRecord? = null
  @Field val panel: String? = null
  @Field val hideWhilePanelOpen: Boolean = true
  @Field val spots: String = "global"
  @Field val label: String = ""
}

/**
 * Expo module 'ByokitOverlay': the NativeOverlay seam (docs/capability-kits.md 7.3, 7.5). It runs the state machine
 * of 7.3 over the host a start picks, and turns bubble, host and panel changes into 'overlay' events.
 */
class OverlayModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var state = "off"
  private var options: StartRecord? = null
  private var mood = ""
  private var label = ""
  private var bubble: Bubble? = null
  private var host: OverlayHost? = null
  private var rules: RulesRecord? = null
  // The foreground app (accessibility host) and what watches it and the keyboard while the bubble is on.
  private var app: String? = null
  private val watching = mutableListOf<() -> Unit>()
  // The keyboard follows the service's attach and detach on either host.
  private var keyboardOff: (() -> Unit)? = null
  private var pending: Promise? = null
  // A stop while the service is still starting waits for its startForeground; stopping it sooner crashes the app.
  private var stopWhenHosted = false
  private var panelOpen = false
  private val removers = mutableListOf<() -> Unit>()
  private val tapLog by lazy { TapLog(context) }

  private val context: Context get() = appContext.reactContext?.applicationContext ?: throw CodedException("overlay: no context")

  override fun definition() = ModuleDefinition {
    Name("ByokitOverlay")
    Events("overlay")

    OnCreate {
      removers += OverlayService.hosts.add { h -> main.post { hostChanged("window", h) } }
      removers += ByokitAccessibility.hosts.add { h -> main.post { hostChanged("accessibility", h) } }
      removers += PanelActivity.open.add { open -> main.post { panelChanged(open) } }
    }
    OnDestroy {
      removers.forEach { it() }
      removers.clear()
      // The React context may already be gone, so this stop cannot throw.
      main.post { runCatching { stopNow() } }
    }

    AsyncFunction("state") { state }.runOnQueue(Queues.MAIN)
    AsyncFunction("openPermission") {
      val intent = if (options?.host == "accessibility") Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
      else Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${context.packageName}"))
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("start") { o: StartRecord, promise: Promise -> start(o, promise) }.runOnQueue(Queues.MAIN)
    AsyncFunction("stop") { stopNow() }.runOnQueue(Queues.MAIN)
    Function("say") { text: String, mood: String?, ms: Double, announce: Boolean ->
      main.post { bubble?.say(text, mood, ms.toLong(), announce) }
    }
    Function("setMood") { mood: String ->
      main.post { this@OverlayModule.mood = mood; bubble?.setMood(mood) }
    }
    Function("setLabel") { label: String? ->
      main.post { this@OverlayModule.label = label ?: ""; bubble?.setLabel(label) }
    }
    // Applied over the foreground app on the accessibility host; start() rejects rules for 'window'.
    Function("setRules") { r: RulesRecord -> main.post { rules = r; refresh() } }
    // Rejects through the promise: a thrown error reaches JS wrapped in Expo's own message.
    AsyncFunction("openPanel") { props: Map<String, String>, promise: Promise ->
      val panel = options?.panel ?: return@AsyncFunction promise.reject(CodedException("overlay: no panel"))
      PanelActivity.launch(context, panel, props)
      promise.resolve(null)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("closePanel") { PanelActivity.current?.finish(); Unit }.runOnQueue(Queues.MAIN)
    AsyncFunction("logTap") { app: String, action: String -> tapLog.add(app, action, System.currentTimeMillis()) }
    AsyncFunction("taps") { since: Double ->
      tapLog.prune(System.currentTimeMillis())
      tapLog.since(since.toLong()).map { mapOf("app" to it.app, "at" to it.at.toDouble(), "action" to it.action) }
    }
    AsyncFunction("clearTaps") { tapLog.clear() }
  }

  private fun start(o: StartRecord, promise: Promise) {
    stopNow()
    options = o
    mood = o.mood
    label = o.label
    rules = o.rules
    if (o.host == "accessibility") {
      val h = ByokitAccessibility.host ?: return promise.resolve(setState("needs-permission"))
      show(h)
      return promise.resolve(state)
    }
    val notice = o.notice ?: return promise.reject(CodedException("overlay: host window needs notice"))
    if (!Settings.canDrawOverlays(context)) return promise.resolve(setState("needs-permission"))
    pending = promise
    stopWhenHosted = false
    try {
      context.startForegroundService(OverlayService.intent(context, notice.channel, notice.title, notice.text, notice.icon))
    } catch (e: Exception) {
      pending = null
      promise.reject(CodedException("overlay: ${e.message}"))
    }
  }

  private fun show(h: OverlayHost) {
    val o = options ?: return
    host = h
    val b = Bubble(h, PrefsSpotStore(context), ServiceBubble.drawables(context), ServiceBubble.reducedMotion(context))
    b.events.add(::bubbleEvent)
    bubble = b
    b.setLabel(label.takeIf { it.isNotEmpty() })
    watchKeyboard()
    val foreground = ByokitAccessibility.foreground
    if (o.host == "accessibility" && foreground != null) { app = foreground.current; watching += foreground.onChange(::appChanged) }
    b.spotKey = SpotStore.key(o.spots == "per-app", app)
    refresh()
    setState("on")
  }

  /** The bubble rests above the keyboard while the app's accessibility service is attached. */
  private fun watchKeyboard() {
    keyboardOff?.invoke()
    keyboardOff = null
    val b = bubble ?: return
    val k = ByokitAccessibility.keyboard
    b.imeTopPx = k?.imeTopPx
    keyboardOff = k?.onChange { b.imeTopPx = it }
  }

  private fun appChanged(now: String?) {
    // A window change can briefly have no app, and the panel is the app's own window over the app it opened from.
    if (now == null || (panelOpen && now == context.packageName)) return
    app = now
    val b = bubble ?: return
    val key = SpotStore.key(options?.spots == "per-app", now)
    if (key != b.spotKey) { b.hide(); b.spotKey = key } // shown again below, at this app's spot
    refresh()
  }

  /** The bubble shows unless the open panel hides it or, on the accessibility host, the rules hide it over this app. */
  private fun refresh() {
    val o = options ?: return
    val b = bubble ?: return
    val ruledOut = o.host == "accessibility" && rules?.shows(app) == false
    if ((panelOpen && o.hideWhilePanelOpen) || ruledOut) b.hide() else b.show(mood)
  }

  private fun unwatch() {
    watching.forEach { it() }
    watching.clear()
    keyboardOff?.invoke()
    keyboardOff = null
    app = null
  }

  private fun hostChanged(kind: String, h: OverlayHost?) {
    if (kind == "window" && h != null && stopWhenHosted) {
      stopWhenHosted = false
      context.stopService(Intent(context, OverlayService::class.java))
      return
    }
    if (kind == "accessibility" && state == "on") watchKeyboard()
    if (options?.host != kind) return
    if (h != null) {
      val p = pending ?: return
      pending = null
      show(h)
      p.resolve(state)
      return
    }
    if (state != "on" || host == null) return
    unwatch()
    bubble?.hide()
    bubble = null
    host = null
    setState("stuck")
  }

  private fun stopNow() {
    val starting = pending
    pending = null
    unwatch()
    bubble?.hide()
    bubble = null
    host = null
    if (options?.host == "window") {
      if (starting != null) stopWhenHosted = true else context.stopService(Intent(context, OverlayService::class.java))
    }
    options = null
    if (state != "off") setState("off")
    starting?.resolve("off")
  }

  private fun bubbleEvent(e: OverlayEvent) {
    when (e) {
      is OverlayEvent.Tap -> {
        emit(mapOf("type" to "tap"))
        options?.panel?.let { PanelActivity.launch(context, it, emptyMap()) }
      }
      is OverlayEvent.LongPress -> emit(mapOf("type" to "longPress"))
      is OverlayEvent.Moved -> emit(mapOf("type" to "moved", "edge" to e.spot.edge.name.lowercase(), "y" to e.spot.y.toDouble()))
      else -> {}
    }
  }

  private fun panelChanged(open: Boolean) {
    panelOpen = open
    emit(mapOf("type" to "panel", "open" to open))
    refresh()
  }

  private fun setState(s: String): String {
    state = s
    emit(mapOf("type" to "state", "state" to s))
    return s
  }

  /** src/rules.ts shownFor, decided in Kotlin (Rules.shows): paused, no app, or turned off hides. */
  private fun RulesRecord.shows(app: String?): Boolean = Rules(paused, on, off, defaults).shows(app)

  private fun emit(body: Map<String, Any?>) = sendEvent("overlay", body)
}
