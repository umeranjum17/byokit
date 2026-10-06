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
    val v = RingView(context, o.label, s.density, o.x.toFloat(), o.y.toFloat(), s.width, s.height)
    val params = WindowManager.LayoutParams(
      v.w, v.h, type,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
      PixelFormat.TRANSLUCENT,
    ).apply {
      title = "byokit-point-marker"
      gravity = Gravity.TOP or Gravity.LEFT
      x = v.winX; y = v.winY
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

  /** The label sits below the ring (above it near the bottom edge), so it never covers the target's own text. */
  private class RingView(
    context: Context, private val label: String, private val density: Float, x: Float, y: Float, screenW: Int, screenH: Int,
  ) : View(context) {
    private val ink = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 14 * density; typeface = android.graphics.Typeface.DEFAULT_BOLD }
    private val ring = 56 * density
    private val pillW = ink.measureText(label).coerceAtMost(220 * density) + 24 * density
    private val pillH = 28 * density
    private val gap = 23 * density                      // centre to pill edge: just outside the ring's 21.5 dp stroke
    private val below = y + gap + pillH <= screenH
    private val pillX = (x - pillW / 2).coerceAtMost(screenW - pillW).coerceAtLeast(0f)
    val winX = minOf(x - ring / 2, pillX).roundToInt()
    val winY = (if (below) y - ring / 2 else y - gap - pillH).roundToInt()
    val w = (maxOf(x + ring / 2, pillX + pillW) - winX).roundToInt()
    val h = (ring / 2 + gap + pillH).roundToInt()
    private val cx = x - winX
    private val cy = y - winY
    private val pillTop = if (below) cy + gap else 0f
    init { contentDescription = label; isFocusable = false; isClickable = false }
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) { setMeasuredDimension(w, h) }
    override fun onDraw(canvas: Canvas) {
      ink.style = Paint.Style.STROKE; ink.strokeWidth = 5 * density; ink.color = Color.WHITE
      canvas.drawCircle(cx, cy, 19 * density, ink)
      ink.strokeWidth = 3 * density; ink.color = Color.rgb(0, 103, 78)
      canvas.drawCircle(cx, cy, 19 * density, ink)
      ink.style = Paint.Style.FILL; ink.color = Color.rgb(0, 70, 53)
      val l = pillX - winX
      canvas.drawRoundRect(l, pillTop, l + pillW, pillTop + pillH, 8 * density, 8 * density, ink)
      ink.color = Color.WHITE
      val text = android.text.TextUtils.ellipsize(label, android.text.TextPaint(ink), pillW - 24 * density, android.text.TextUtils.TruncateAt.END).toString()
      canvas.drawText(text, l + (pillW - ink.measureText(text)) / 2, pillTop + pillH / 2 - (ink.ascent() + ink.descent()) / 2, ink)
    }
  }
}
