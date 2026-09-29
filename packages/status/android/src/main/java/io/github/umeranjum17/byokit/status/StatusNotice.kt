package io.github.umeranjum17.byokit.status

import android.annotation.SuppressLint
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import java.util.concurrent.CopyOnWriteArraySet

// The one status notification (docs/capability-kits.md 12.5): a promoted ongoing NotificationCompat on its own LOW
// channel, private with a counts-only public copy, a timeout re-armed on every post, a delete intent that records the
// person's dismissal, and actions that open the app only once it is unlocked. StatusRules decides what gets posted.
class StatusNotice(context: Context) {
  private val context = context.applicationContext
  private val manager = NotificationManagerCompat.from(this.context)
  private val prefs = this.context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  private val main = Handler(Looper.getMainLooper())
  private var pending: Pair<Post, String>? = null
  private val flushLater = Runnable { flush() }

  companion object {
    const val CHANNEL = "byokit.status"
    const val EXTRA_ACTION = "byokit.status.action"
    const val EXTRA_NONCE = "byokit.status.nonce"
    const val PREFS = "byokit.status"
    private const val TAG = "byokit.status"
    private const val ID = 1

    /** Called on the person's dismissal, in whichever process the delete intent reached. */
    val dismissals = CopyOnWriteArraySet<() -> Unit>()

    private val supported get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA
  }

  @Synchronized fun show(p: Post, channelName: String) {
    if (!supported) return
    pending = p to channelName
    flush()
  }

  @Synchronized fun clear() {
    pending = null
    main.removeCallbacks(flushLater)
    manager.cancel(TAG, ID)
    prefs.edit().remove("signature").remove("at").remove("timeoutMs").remove("dismissed").apply()
  }

  /** The delete intent fired: the person's swipe, or the timeout (StatusRules.userDismissed tells them apart). */
  @Synchronized fun deleted() {
    if (!StatusRules.userDismissed(SystemClock.elapsedRealtime(), last())) return
    pending = null
    main.removeCallbacks(flushLater)
    prefs.edit().putBoolean("dismissed", true).apply()
    for (fn in dismissals) runCatching { fn() }
  }

  fun state(): String {
    if (!supported) return "unsupported"
    if (!manager.areNotificationsEnabled()) return "needs-permission"
    val importance = manager.getNotificationChannel(CHANNEL)?.importance
    if (importance == NotificationManagerCompat.IMPORTANCE_NONE) return "needs-permission"
    if (importance != null && !StatusRules.channelPromotable(importance)) return "off"
    val system = context.getSystemService(NotificationManager::class.java)
    return if (system.canPostPromotedNotifications()) "on" else "off"
  }

  /** The promotion setting when there is one, else the app's notification settings. */
  fun openSettings() {
    val pkg = context.packageName
    val screens = listOfNotNull(
      if (supported && manager.areNotificationsEnabled()) Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS else null,
      Settings.ACTION_APP_NOTIFICATION_SETTINGS,
    )
    for (action in screens) {
      val intent = Intent(action).putExtra(Settings.EXTRA_APP_PACKAGE, pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try { context.startActivity(intent); return } catch (_: ActivityNotFoundException) { /* next screen */ }
    }
  }

  @Synchronized private fun flush() {
    val (p, channelName) = pending ?: return
    val now = SystemClock.elapsedRealtime()
    // A notification gone without a delete intent (force-stop, a channel blocked and unblocked) is not a duplicate.
    val last = last()?.let { if (posted()) it else it.copy(signature = "") }
    when (val d = StatusRules.decide(StatusRules.signature(p), now, last, prefs.getBoolean("dismissed", false))) {
      StatusRules.Decision.Drop -> pending = null
      is StatusRules.Decision.Later -> { main.removeCallbacks(flushLater); main.postDelayed(flushLater, d.ms) }
      StatusRules.Decision.Show -> { pending = null; post(p, channelName, now) }
    }
  }

  /** The last post, timed on the boot clock (the wall clock can jump); one from an earlier boot is forgotten. */
  private fun last(): Last? {
    val sig = prefs.getString("signature", null) ?: return null
    val at = prefs.getLong("at", 0)
    if (at > SystemClock.elapsedRealtime()) return null
    return Last(sig, at, prefs.getLong("timeoutMs", 0))
  }

  private fun posted(): Boolean =
    context.getSystemService(NotificationManager::class.java).activeNotifications.any { it.tag == TAG && it.id == ID }

  @SuppressLint("MissingPermission") // areNotificationsEnabled() is false without POST_NOTIFICATIONS
  private fun post(p: Post, channelName: String, now: Long) {
    if (state() == "needs-permission") return
    manager.createNotificationChannel(
      NotificationChannelCompat.Builder(CHANNEL, NotificationManagerCompat.IMPORTANCE_LOW)
        .setName(channelName).setShowBadge(false).build(),
    )
    val icon = p.icon?.let { context.resources.getIdentifier(it, "drawable", context.packageName) }
      ?.takeIf { it != 0 } ?: context.applicationInfo.icon
    val public = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(icon).setContentTitle(p.publicText).setOngoing(true)
      .apply { if (p.chip.isNotEmpty()) setShortCriticalText(p.chip) }
      .build()
    val deleted = PendingIntent.getBroadcast(
      context, 0, Intent(context, StatusDismissReceiver::class.java), PendingIntent.FLAG_IMMUTABLE,
    )
    val builder = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(icon)
      .setContentTitle(p.title)
      .setContentText(p.text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setRequestPromotedOngoing(p.promote)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(public)
      .setTimeoutAfter(p.timeoutMs)
      .setDeleteIntent(deleted)
      .setContentIntent(open(0, null))
      .apply { if (p.chip.isNotEmpty()) setShortCriticalText(p.chip) }
    p.actions.forEachIndexed { i, (id, label) ->
      builder.addAction(NotificationCompat.Action.Builder(0, label, open(i + 1, id)).setAuthenticationRequired(true).build())
    }
    manager.notify(TAG, ID, builder.build())
    prefs.edit()
      .putString("signature", StatusRules.signature(p)).putLong("at", now).putLong("timeoutMs", p.timeoutMs)
      .apply()
  }

  /** The app's launch activity, carrying the action id when there is one (an activity, so no trampoline). */
  private fun open(code: Int, action: String?): PendingIntent? {
    val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    if (action != null) intent.putExtra(EXTRA_ACTION, action).putExtra(EXTRA_NONCE, SystemClock.elapsedRealtimeNanos())
    return PendingIntent.getActivity(context, code, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }
}

/** The delete intent's target: records the person's dismissal so later posts are dropped until clear(). */
class StatusDismissReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) = StatusNotice(context).deleted()
}
