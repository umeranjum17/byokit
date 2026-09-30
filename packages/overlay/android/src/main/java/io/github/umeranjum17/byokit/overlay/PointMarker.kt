package io.github.umeranjum17.byokit.overlay

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import kotlin.math.roundToInt

class PointRecord : Record {
  @Field val x: Double = 0.0
  @Field val y: Double = 0.0
  @Field val label: String = ""
  @Field val space: ScreenSpaceRecord? = null
  @Field val ms: Double = 2500.0
}

/** The marker is its own window, so dismissing it never removes the bubble. One marker at a time. */
internal class PointMarker(private val context: Context, private val type: Int) {
  private val windows = context.getSystemService(WindowManager::class.java)
  private val main = Handler(Looper.getMainLooper())
  private var view: View? = null
  private var space: ScreenSpace? = null
  private val displays = context.getSystemService(android.hardware.display.DisplayManager::class.java)
  private val changes = object : android.hardware.display.DisplayManager.DisplayListener {
    override fun onDisplayAdded(id: Int) {}
    override fun onDisplayRemoved(id: Int) { if (space?.displayId == id) dismiss() }
    override fun onDisplayChanged(id: Int) { if (view != null && space != ScreenSpace.current(context)) dismiss() }
  }
  private val dismiss = Runnable { dismiss() }

  fun show(o: PointRecord): String {
    require(o.x.isFinite() && o.y.isFinite() && o.label.isNotBlank() && o.ms.isFinite() && o.ms in 1.0..60000.0)
    val s = ScreenSpace.current(context)
    if (o.space?.let { !s.matches(it) } == true) return "display-changed"
    require(o.x >= 0 && o.y >= 0 && o.x < s.width && o.y < s.height)
    dismiss()
    val ring = (56 * s.density).roundToInt()
    val v = RingView(context, o.label, s.density, ring)
    val params = WindowManager.LayoutParams(
      v.markerWidth, ring, type,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
      PixelFormat.TRANSLUCENT,
    ).apply {
      title = "byokit-point-marker"
      gravity = Gravity.TOP or Gravity.LEFT
      x = (o.x - ring / 2f).roundToInt(); y = (o.y - ring / 2f).roundToInt()
      // Android 12+ permits touches through an untrusted application overlay only below its opacity threshold.
      alpha = 0.6f
      if (Build.VERSION.SDK_INT >= 30) fitInsetsTypes = 0
      if (Build.VERSION.SDK_INT >= 28) layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
    }
    windows.addView(v, params)
    view = v
    space = s
    displays.registerDisplayListener(changes, main)
    // Announcement is an event, not a focusable/touchable accessibility target.
    @Suppress("DEPRECATION")
    v.announceForAccessibility(o.label)
    main.postDelayed(dismiss, o.ms.toLong())
    return "shown"
  }
  fun dismiss() {
    main.removeCallbacks(dismiss)
    displays.unregisterDisplayListener(changes)
    space = null
    val v = view ?: return
    view = null
    runCatching { windows.removeView(v) }
  }

  private class RingView(context: Context, private val label: String, private val density: Float, private val ring: Int) : View(context) {
    private val ink = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 14 * density; typeface = android.graphics.Typeface.DEFAULT_BOLD }
    val markerWidth = ring + (ink.measureText(label).coerceAtMost(220 * density) + 24 * density).roundToInt()
    init { contentDescription = label; isFocusable = false; isClickable = false }
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) { setMeasuredDimension(markerWidth, ring) }
    override fun onDraw(canvas: Canvas) {
      val centre = ring / 2f
      ink.style = Paint.Style.STROKE; ink.strokeWidth = 5 * density; ink.color = Color.WHITE
      canvas.drawCircle(centre, centre, 19 * density, ink)
      ink.strokeWidth = 3 * density; ink.color = Color.rgb(0, 103, 78)
      canvas.drawCircle(centre, centre, 19 * density, ink)
      ink.style = Paint.Style.FILL; ink.color = Color.rgb(0, 70, 53)
      canvas.drawRoundRect(ring.toFloat(), 10 * density, markerWidth.toFloat(), ring - 10 * density, 8 * density, 8 * density, ink)
      ink.color = Color.WHITE
      val text = android.text.TextUtils.ellipsize(label, android.text.TextPaint(ink), markerWidth - ring - 16 * density, android.text.TextUtils.TruncateAt.END).toString()
      canvas.drawText(text, ring + 8 * density, centre - (ink.ascent() + ink.descent()) / 2, ink)
    }
  }
}
