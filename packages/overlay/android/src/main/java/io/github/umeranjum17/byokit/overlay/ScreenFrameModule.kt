package io.github.umeranjum17.byokit.overlay

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.UUID

/** One in-flight request. IDs keep a late callback from finishing a newer request. Clear before calling back. */
internal class FrameRequest {
  private var id: String? = null
  private var answer: ((Map<String, Any>) -> Unit)? = null
  @Synchronized fun begin(callback: (Map<String, Any>) -> Unit): String? {
    if (id != null) return null
    val next = UUID.randomUUID().toString()
    id = next; answer = callback
    return next
  }
  @Synchronized fun active(request: String): Boolean = id == request
  @Synchronized fun busy(): Boolean = id != null
  fun end(request: String, result: Map<String, Any>) {
    val callback = synchronized(this) {
      if (id != request) return
      val callback = answer
      id = null; answer = null
      callback
    }
    callback?.invoke(result)
  }
}
internal object ScreenFrames {
  val requests = FrameRequest()
  const val EXTRA_ID = "byokit.frame.id"
  const val CACHE_PREFIX = "byokit-screen-"
  fun clear(dir: File) { dir.listFiles { f -> f.name.startsWith(CACHE_PREFIX) && f.name.endsWith(".png") }?.forEach { it.delete() } }
  fun failed(reason: String) = mapOf<String, Any>("status" to "failed", "reason" to reason)
}

class ScreenFrameModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var request: String? = null
  private var captureContext: android.content.Context? = null
  override fun definition() = ModuleDefinition {
    Name("ByokitScreenFrame")
    AsyncFunction("frame") { promise: expo.modules.kotlin.Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.resolve(ScreenFrames.failed("capture-failed"))
      } else {
        val id = ScreenFrames.requests.begin { result ->
          main.removeCallbacksAndMessages(null); request = null; captureContext = null; promise.resolve(result)
        }
        if (id == null) promise.resolve(mapOf("status" to "busy"))
        else {
          request = id
          captureContext = activity.applicationContext
          ScreenFrames.clear(activity.cacheDir)
          try {
            activity.startActivity(Intent(activity, ScreenFrameActivity::class.java).putExtra(ScreenFrames.EXTRA_ID, id))
            // Includes an abandoned consent dialog. No grant is cached, even if this timer expires.
            main.postDelayed({
              if (ScreenFrames.requests.active(id)) {
                ScreenFrames.requests.end(id, ScreenFrames.failed("timeout"))
                activity.stopService(Intent(activity, ScreenFrameService::class.java))
              }
            }, 60000L)
          } catch (_: Exception) { ScreenFrames.requests.end(id, ScreenFrames.failed("capture-failed")) }
        }
      }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("clear") {
      if (ScreenFrames.requests.busy()) throw CodedException("screen frame: capture in progress")
      appContext.reactContext?.cacheDir?.let(ScreenFrames::clear)
    }.runOnQueue(Queues.MAIN)
    OnDestroy {
      main.removeCallbacksAndMessages(null)
      val context = captureContext
      request?.let { id ->
        context?.stopService(Intent(context, ScreenFrameService::class.java))
        ScreenFrames.requests.end(id, mapOf("status" to "cancelled"))
      }
      captureContext = null
      request = null
    }
  }
}

/** Transparent consent trampoline; the platform asks on every call, with a new single-use token. */
class ScreenFrameActivity : Activity() {
  private var handed = false
  private val request: String get() = intent.getStringExtra(ScreenFrames.EXTRA_ID) ?: ""
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    handed = savedInstanceState?.getBoolean("handed") ?: false
    if (!ScreenFrames.requests.active(request)) { finish(); return }
    if (savedInstanceState != null) return
    try {
      val manager = getSystemService(MediaProjectionManager::class.java)
      val ask = if (Build.VERSION.SDK_INT >= 34) manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
        else manager.createScreenCaptureIntent()
      startActivityForResult(ask, ASK)
    } catch (_: Exception) { ScreenFrames.requests.end(request, ScreenFrames.failed("capture-failed")); finish() }
  }
  override fun onSaveInstanceState(outState: Bundle) { outState.putBoolean("handed", handed); super.onSaveInstanceState(outState) }
  @Deprecated("Deprecated in Java")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode != ASK) return
    if (ScreenFrames.requests.active(request)) {
      if (resultCode == RESULT_OK && data != null) {
        try { startForegroundService(ScreenFrameService.intent(this, request, resultCode, data)); handed = true }
        catch (_: Exception) { ScreenFrames.requests.end(request, ScreenFrames.failed("capture-failed")) }
      } else ScreenFrames.requests.end(request, mapOf("status" to "cancelled"))
    }
    finish()
  }
  override fun onDestroy() {
    if (!handed && !isChangingConfigurations) ScreenFrames.requests.end(request, mapOf("status" to "cancelled"))
    super.onDestroy()
  }
  private companion object { const val ASK = 1 }
}
