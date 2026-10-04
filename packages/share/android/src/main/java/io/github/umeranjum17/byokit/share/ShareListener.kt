package io.github.umeranjum17.byokit.share

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.util.Log
import expo.modules.core.interfaces.ReactActivityLifecycleListener
import java.io.File

internal object Inbox {
  fun root(context: Context) = File(context.cacheDir, "byokit-share")
  private var inbox: ShareInbox<Intent, Map<String, Any?>>? = null
  @Synchronized fun get(context: Context): ShareInbox<Intent, Map<String, Any?>> {
    return inbox ?: run {
      val root = root(context.applicationContext)
      ShareInbox<Intent, Map<String, Any?>>(
        { root.listFiles()?.mapNotNull { it.name.toLongOrNull() }.orEmpty() },
        { File(root, it.toString()).deleteRecursively(); Unit },
        { root.deleteRecursively(); Unit }
      ).also { inbox = it }
    }
  }
  fun capture(context: Context, activity: Activity?, intent: Intent): Boolean {
    return try {
      if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0 ||
        intent.getBooleanExtra(ShareRules.CONSUMED, false) || !ShareRules.isShare(intent.action, intent.type)) false
      else {
        // Keep the sender's Intent only in-process. Do not copy grants to a relaunch.
        get(context).offer(intent)
        activity?.intent = Intent(intent).putExtra(ShareRules.CONSUMED, true)
        true
      }
    } catch (_: Exception) {
      Log.w("ByokitShare", "skipped 1")
      false
    }
  }
}

class ShareListener(private val context: Context) : ReactActivityLifecycleListener {
  override fun onCreate(activity: Activity?, savedInstanceState: Bundle?) {
    try { activity?.intent?.let { Inbox.capture(context, activity, it) } }
    catch (_: Exception) { Log.w("ByokitShare", "skipped 1") }
  }
}
