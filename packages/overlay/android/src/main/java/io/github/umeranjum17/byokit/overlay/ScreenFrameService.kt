package io.github.umeranjum17.byokit.overlay

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import java.io.File

/** A fresh projection per request, with one PNG and no running capture after success, failure or teardown. */
class ScreenFrameService : Service() {
  private val main = Handler(Looper.getMainLooper())
  private var projection: MediaProjection? = null
  private var display: VirtualDisplay? = null
  private var reader: ImageReader? = null
  private var request = ""
  private var done = false
  private var space: ScreenSpace? = null
  override fun onBind(intent: Intent?): IBinder? = null
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    request = intent?.getStringExtra(ScreenFrames.EXTRA_ID) ?: ""
    try {
      foreground()
      if (!ScreenFrames.requests.active(request)) { finish(mapOf("status" to "cancelled")); return START_NOT_STICKY }
      val code = intent?.getIntExtra(EXTRA_CODE, 0) ?: 0
      @Suppress("DEPRECATION") val data = intent?.getParcelableExtra<Intent>(EXTRA_DATA)
      val p = data?.let { getSystemService(MediaProjectionManager::class.java).getMediaProjection(code, it) }
        ?: throw IllegalStateException("No projection")
      projection = p
      val s = ScreenSpace.current(this)
      space = s
      p.registerCallback(object : MediaProjection.Callback() {
        override fun onStop() { finish(mapOf("status" to "cancelled")) }
        override fun onCapturedContentResize(width: Int, height: Int) {
          // OEMs can override the full-display request. Never return misleading marker coordinates.
          if (width != s.width || height != s.height) finish(ScreenFrames.failed("display-changed"))
        }
      }, main)
      val r = ImageReader.newInstance(s.width, s.height, PixelFormat.RGBA_8888, 2)
      reader = r
      display = p.createVirtualDisplay("byokit-still", s.width, s.height, s.densityDpi,
        DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, main)
      main.postDelayed({ if (!done) { r.setOnImageAvailableListener({ take(it) }, main); take(r) } }, 400L)
      main.postDelayed({ finish(ScreenFrames.failed("timeout")) }, 6000L)
    } catch (_: Exception) { finish(ScreenFrames.failed("capture-failed")) }
    return START_NOT_STICKY
  }
  private fun take(r: ImageReader) {
    if (done) return
    val s = space ?: return
    if (s != ScreenSpace.current(this)) { finish(ScreenFrames.failed("display-changed")); return }
    val image = runCatching { r.acquireLatestImage() }.getOrNull() ?: return
    val result = try {
      val plane = image.planes[0]
      val padded = Bitmap.createBitmap(plane.rowStride / plane.pixelStride, image.height, Bitmap.Config.ARGB_8888)
      var still: Bitmap? = null
      try {
        padded.copyPixelsFromBuffer(plane.buffer)
        val cropped = Bitmap.createBitmap(padded, 0, 0, image.width, image.height)
        still = cropped
        val file = File(cacheDir, "${ScreenFrames.CACHE_PREFIX}${request}.png")
        try {
          file.outputStream().use { if (!cropped.compress(Bitmap.CompressFormat.PNG, 100, it)) throw IllegalStateException("PNG failed") }
          mapOf<String, Any>("status" to "captured", "uri" to "file://${file.absolutePath}", "mimeType" to "image/png",
            "width" to image.width, "height" to image.height, "space" to s.toMap())
        } catch (e: Exception) { file.delete(); throw e }
      } finally { if (still !== padded) still?.recycle(); padded.recycle() }
    } catch (_: Exception) { ScreenFrames.failed("capture-failed") }
    finally { image.close() }
    finish(result)
  }
  private fun finish(result: Map<String, Any>) {
    if (done) return
    done = true
    main.removeCallbacksAndMessages(null)
    runCatching { reader?.setOnImageAvailableListener(null, null) }
    runCatching { display?.release() }; display = null
    runCatching { projection?.stop() }; projection = null
    runCatching { reader?.close() }; reader = null
    ScreenFrames.requests.end(request, result)
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }
  override fun onDestroy() { finish(mapOf("status" to "cancelled")); super.onDestroy() }
  private fun foreground() {
    val channel = "byokit-screen-frame"
    val text = Words.get(this, "screen.taking")
    getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(channel, text, NotificationManager.IMPORTANCE_LOW))
    val icon = resources.getIdentifier("byokit_notification", "drawable", packageName).takeIf { it != 0 } ?: applicationInfo.icon
    val n = Notification.Builder(this, channel).setContentTitle(text).setSmallIcon(icon).build()
    if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION) else startForeground(ID, n)
  }
  companion object {
    private const val ID = 0x5C4E
    private const val EXTRA_CODE = "byokit.frame.code"
    private const val EXTRA_DATA = "byokit.frame.data"
    fun intent(context: Context, request: String, code: Int, data: Intent): Intent =
      Intent(context, ScreenFrameService::class.java).putExtra(ScreenFrames.EXTRA_ID, request).putExtra(EXTRA_CODE, code).putExtra(EXTRA_DATA, data)
  }
}
