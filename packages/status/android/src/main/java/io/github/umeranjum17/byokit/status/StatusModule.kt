package io.github.umeranjum17.byokit.status

import android.content.Context
import android.content.Intent
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class ActionRecord : Record {
  @Field val id: String = ""
  @Field val label: String = ""
}

class ShowRecord : Record {
  @Field val title: String = ""
  @Field val text: String = ""
  @Field val chip: String = ""
  @Field val publicText: String = ""
  @Field val promote: Boolean = false
  @Field val actions: List<ActionRecord> = emptyList()
  @Field val timeoutMs: Double = 0.0
  @Field val icon: String? = null
  @Field val channel: String = ""
}

// Expo module 'ByokitStatus': the NativeStatus seam (docs/capability-kits.md 12.3, 12.5). Action ids arrive on the
// launch intent and are held until JS listens; dismissals arrive from StatusNotice.
class StatusModule : Module() {
  private val notice by lazy { StatusNotice(appContext.reactContext ?: throw Exceptions.ReactContextLost()) }
  private val held = mutableListOf<Map<String, Any?>>()
  private var observing = false
  private val onDismissed: () -> Unit = { emit(mapOf("type" to "dismissed")) }

  override fun definition() = ModuleDefinition {
    Name("ByokitStatus")
    Events("status")

    OnCreate {
      StatusNotice.dismissals.add(onDismissed)
      appContext.currentActivity?.intent?.let { take(it) }   // a cold start from an action: the activity came first
    }
    OnDestroy { StatusNotice.dismissals.remove(onDismissed) }
    OnStartObserving {
      val out = synchronized(held) { observing = true; held.toList().also { held.clear() } }
      for (e in out) sendEvent("status", e)
    }
    OnStopObserving { synchronized(held) { observing = false } }
    OnNewIntent { intent -> take(intent) }
    OnActivityEntersForeground { appContext.currentActivity?.intent?.let { take(it) } }

    Function("show") { o: ShowRecord ->
      val post = Post(o.title, o.text, o.chip, o.publicText, o.promote, o.actions.map { it.id to it.label }, o.timeoutMs.toLong(), o.icon)
      StatusRules.check(post)?.let { throw CodedException("status: $it") }
      notice.show(post, o.channel)
    }
    Function("clear") { notice.clear() }
    AsyncFunction("state") { notice.state() }
    AsyncFunction("openSettings") { notice.openSettings() }
  }

  /** An action tap: the id rides on the launch intent. The system keeps that intent and replays it when it restores
   * the activity (after process death, or from Recents), so each tap's nonce is taken once, across processes. */
  private fun take(intent: Intent) {
    val id = intent.getStringExtra(StatusNotice.EXTRA_ACTION) ?: return
    val nonce = intent.getLongExtra(StatusNotice.EXTRA_NONCE, 0L)
    intent.removeExtra(StatusNotice.EXTRA_ACTION)
    if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
    val prefs = (appContext.reactContext ?: return).getSharedPreferences(StatusNotice.PREFS, Context.MODE_PRIVATE)
    if (prefs.getLong("taken", 0L) == nonce) return
    prefs.edit().putLong("taken", nonce).apply()
    emit(mapOf("type" to "action", "id" to id))
  }

  private fun emit(e: Map<String, Any?>) {
    val now = synchronized(held) { if (!observing) held += e; observing }
    if (now) sendEvent("status", e)
  }
}
