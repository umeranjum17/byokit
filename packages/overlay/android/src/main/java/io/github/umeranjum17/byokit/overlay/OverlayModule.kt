package io.github.umeranjum17.byokit.overlay

import android.content.Context
import android.content.Intent
import android.graphics.drawable.Drawable
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

class NoticeRecord : Record {
  @Field val channel: String = ""
  @Field val title: String = ""
  @Field val text: String = ""
  @Field val icon: String = ""
}

class RulesRecord : Record {
  @Field val paused: Boolean = false
  @Field val on: List<String> = emptyList()
  @Field val off: List<String> = emptyList()
  @Field val defaults: List<String> = emptyList()
}

class StartRecord : Record {
  @Field val host: String = "window"
  @Field val mood: String = ""
  @Field val notice: NoticeRecord? = null
  @Field val rules: RulesRecord? = null
  @Field val panel: String? = null
  @Field val hideWhilePanelOpen: Boolean = true
  @Field val spots: String = "global"
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
  private var bubble: Bubble? = null
  private var host: OverlayHost? = null
  private var rules: RulesRecord? = null
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
    Function("say") { text: String, mood: String?, ms: Double -> main.post { bubble?.say(text, mood, ms.toLong()) } }
    Function("setMood") { mood: String ->
      main.post { this@OverlayModule.mood = mood; bubble?.setMood(mood) }
    }
    // Kept for the accessibility host; BK-O3's foreground-app provider applies them.
    Function("setRules") { r: RulesRecord -> main.post { rules = r } }
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
    val b = Bubble(h, PrefsSpotStore(context), ::drawable, ::reducedMotion)
    b.spotKey = SpotStore.key(o.spots == "per-app", null)
    b.events.add(::bubbleEvent)
    bubble = b
    if (!(panelOpen && o.hideWhilePanelOpen)) b.show(mood)
    setState("on")
  }

  private fun hostChanged(kind: String, h: OverlayHost?) {
    if (kind == "window" && h != null && stopWhenHosted) {
      stopWhenHosted = false
      context.stopService(Intent(context, OverlayService::class.java))
      return
    }
    if (options?.host != kind) return
    if (h != null) {
      val p = pending ?: return
      pending = null
      show(h)
      p.resolve(state)
      return
    }
    if (state != "on" || host == null) return
    bubble?.hide()
    bubble = null
    host = null
    setState("stuck")
  }

  private fun stopNow() {
    val starting = pending
    pending = null
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
    val o = options ?: return
    if (!o.hideWhilePanelOpen) return
    if (open) bubble?.hide() else bubble?.show(mood)
  }

  private fun setState(s: String): String {
    state = s
    emit(mapOf("type" to "state", "state" to s))
    return s
  }

  private fun emit(body: Map<String, Any?>) = sendEvent("overlay", body)

  private fun drawable(name: String): Drawable? {
    val id = context.resources.getIdentifier(name, "drawable", context.packageName)
    return context.getDrawable(if (id != 0) id else context.applicationInfo.icon)
  }

  private fun reducedMotion(): Boolean =
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
}
