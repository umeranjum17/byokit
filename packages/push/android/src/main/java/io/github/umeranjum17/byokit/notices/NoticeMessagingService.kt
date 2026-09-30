package io.github.umeranjum17.byokit.notices

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class NoticeMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) { NoticeHandler.handle(this, message.data, message.messageId) }
}

object NoticeHandler {

  /** Apps with their own Firebase service forward data here instead of registering two services. */
  fun handle(context: android.content.Context, fields: Map<String, String>, messageId: String? = null) {
    val envelope = fields["notice"] ?: return // Do not consume unrelated app messages.
    val fallback = NoticeContent(fields["title"] ?: "New update", fields["body"] ?: "Open the app to read it.", null)
    val key = NoticeKeyStore(context).get()
    val content = try { NoticePayload.display(envelope, key, fallback) } finally { key?.fill(0) }
    val manager = context.getSystemService(NotificationManager::class.java)
    val channel = "byokit.notices"
    if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel(channel, "Updates", NotificationManager.IMPORTANCE_DEFAULT))
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
    content.data?.let { launch.putExtra("byokit.notice.data", it.toString()) }
    val id = (messageId ?: java.util.UUID.randomUUID().toString()).hashCode()
    val tap = PendingIntent.getActivity(context, id, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val generic = NotificationCompat.Builder(context, channel).setSmallIcon(context.applicationInfo.icon)
      .setContentTitle(fallback.title).setContentText(fallback.body).build()
    val notification = NotificationCompat.Builder(context, channel).setSmallIcon(context.applicationInfo.icon)
      .setContentTitle(content.title).setContentText(content.body).setStyle(NotificationCompat.BigTextStyle().bigText(content.body))
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setPublicVersion(generic).setContentIntent(tap).setAutoCancel(true).build()
    try { manager.notify("byokit.notices", id, notification) } catch (_: SecurityException) { /* Permission belongs to the app. */ }
  }
}
