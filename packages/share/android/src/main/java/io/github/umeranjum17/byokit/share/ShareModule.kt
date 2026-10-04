package io.github.umeranjum17.byokit.share

import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

class ShareModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ByokitShare")
    Events("onShare")
    OnNewIntent { intent ->
      appContext.reactContext?.let { ctx ->
        if (Inbox.capture(ctx, appContext.currentActivity, intent)) sendEvent("onShare", emptyMap<String, Any>())
      }
    }
    AsyncFunction("read") Coroutine { ->
      // Check before take: losing the context must not consume a share.
      val ctx = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val inbox = Inbox.get(ctx)
      val p = inbox.take()
      if (p == null) inbox.current()?.let { it.second + ("seq" to it.first) } ?: mapOf("kind" to "none", "seq" to 0)
      else {
        val result = try {
          withContext(Dispatchers.IO) { ShareReader(ctx).read(p.second, File(Inbox.root(ctx), p.first.toString())) }
        } catch (e: CancellationException) {
          inbox.requeue(p)
          throw e
        } catch (_: Exception) {
          mapOf("kind" to "unreadable", "skipReasons" to listOf("unreadable"))
        }
        if (inbox.done(p.first, result)) result + ("seq" to p.first) else mapOf("kind" to "none", "seq" to 0)
      }
    }
    Function("clear") { seq: Long ->
      val ctx = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      Inbox.get(ctx).clear(seq)
    }
    Function("hasPending") {
      appContext.reactContext?.let { Inbox.get(it).hasPending() } ?: false
    }
  }
}
