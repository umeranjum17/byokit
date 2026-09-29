package io.github.umeranjum17.byokit.overlay

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/** The foreground service that keeps the 'window' host alive; it owns the WindowOverlayHost. */
class OverlayService : Service() {
  private var host: WindowOverlayHost? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    foreground(NOTIFICATION_ID, notification(intent))
    val h = host ?: WindowOverlayHost(this).also { host = it }
    current = h
    hosts.emit(h)
    // Not sticky: after the system kills it, the bubble reports 'stuck' and the app calls start() again.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    host?.remove()
    host = null
    current = null
    hosts.emit(null)
    super.onDestroy()
  }

  private fun foreground(id: Int, n: Notification) {
    if (Build.VERSION.SDK_INT >= 34) startForeground(id, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    else startForeground(id, n)
  }

  private fun notification(intent: Intent?): Notification {
    val channel = intent?.getStringExtra(EXTRA_CHANNEL) ?: packageName
    getSystemService(NotificationManager::class.java)
      .createNotificationChannel(NotificationChannel(channel, channel, NotificationManager.IMPORTANCE_LOW))
    val icon = intent?.getStringExtra(EXTRA_ICON)?.let { resources.getIdentifier(it, "drawable", packageName) }
    return Notification.Builder(this, channel)
      .setContentTitle(intent?.getStringExtra(EXTRA_TITLE))
      .setContentText(intent?.getStringExtra(EXTRA_TEXT))
      .setSmallIcon(icon?.takeIf { it != 0 } ?: applicationInfo.icon)
      .setOngoing(true)
      .build()
  }

  companion object {
    private const val NOTIFICATION_ID = 0x0B7B
    private const val EXTRA_CHANNEL = "byokit.channel"
    private const val EXTRA_TITLE = "byokit.title"
    private const val EXTRA_TEXT = "byokit.text"
    private const val EXTRA_ICON = "byokit.icon"

    /** The running service's host, and its changes: a host when it starts, null when it is destroyed. */
    @Volatile var current: OverlayHost? = null
      private set
    val hosts = Listeners<OverlayHost?>()

    fun intent(context: Context, channel: String, title: String, text: String, icon: String): Intent =
      Intent(context, OverlayService::class.java)
        .putExtra(EXTRA_CHANNEL, channel).putExtra(EXTRA_TITLE, title)
        .putExtra(EXTRA_TEXT, text).putExtra(EXTRA_ICON, icon)
  }
}
