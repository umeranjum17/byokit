package io.github.umeranjum17.byokit.overlay

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.ComponentCallbacks
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.roundToInt

/**
 * The bubble on a host: a mood image that can be dragged to an edge, tapped and long-pressed, and a pill next to it
 * for [say]. Main thread only. [spotKey] picks the remembered spot (see [SpotStore.key]).
 */
class Bubble(
  private val host: OverlayHost,
  private val spots: SpotStore,
  private val moods: (String) -> Drawable?,
  private val reducedMotion: () -> Boolean,
) : BubbleControl {
  override val events = Listeners<OverlayEvent>()
  override var spotKey: String = SpotStore.GLOBAL
  /** The keyboard's top in screen pixels while it is open; the bubble rests above it and returns when it closes. */
  override var imeTopPx: Int? = null
    set(v) { if (field == v) return; field = v; if (host.attached) place() }

  private val main = Handler(Looper.getMainLooper())
  private var mood: String? = null
  private var a11yLabel: String? = null
  private var row: LinearLayout? = null
  private var image: ImageView? = null
  private var pill: TextView? = null
  private var spot = Spot(Edge.RIGHT, 0.5f)
  private var x = 0
  private var y = 0
  private var glide: ValueAnimator? = null
  // Rotation or a display size change moves the screen under the window; the spot stays, its pixels change.
  private val config = object : ComponentCallbacks {
    override fun onConfigurationChanged(c: Configuration) { main.post { if (host.attached) place() } }
    @Deprecated("Deprecated in Java") override fun onLowMemory() {}
  }
  private val unsay = Runnable { pill?.visibility = View.GONE; mood?.let { image?.setImageDrawable(moods(it)) }; place() }

  /** Shows the bubble at its remembered spot with the resting [mood]. */
  override fun show(mood: String) {
    this.mood = mood
    if (host.attached) { setMood(mood); return }
    val context = viewContext() ?: return
    spot = spots.get(spotKey) ?: spot
    build(context)
    image?.setImageDrawable(moods(mood))
    val (px, py) = pixels()
    x = px; y = py
    host.add(row!!, x, y)
    place() // a pill left visible while hidden shifts the row on the right edge
    context.registerComponentCallbacks(config)
  }

  override fun hide() {
    glide?.cancel()
    main.removeCallbacks(unsay)
    pill?.visibility = View.GONE
    viewContext()?.unregisterComponentCallbacks(config)
    host.remove()
  }

  /**
   * A pill next to the bubble for [ms], with [mood] shown meanwhile when given; still under reduced motion. With
   * [announce] the pill's text is also announced, so TalkBack reads it.
   */
  override fun say(text: String, mood: String?, ms: Long, announce: Boolean) {
    val p = pill ?: return
    main.removeCallbacks(unsay)
    p.text = text
    p.visibility = View.VISIBLE
    if (announce) p.announceForAccessibility(text)
    if (mood != null) image?.setImageDrawable(moods(mood))
    if (host.attached) place()
    main.postDelayed(unsay, ms)
  }

  /** The resting mood; a still frame, never animated. */
  override fun setMood(mood: String) {
    this.mood = mood
    image?.setImageDrawable(moods(mood))
  }

  /** The TalkBack label for the bubble; null clears it back to no label. */
  override fun setLabel(label: String?) {
    a11yLabel = label
    image?.contentDescription = label
  }

  private fun viewContext(): Context? = (host as? WindowManagerHost)?.context

  private fun dp(context: Context, v: Float): Int =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, context.resources.displayMetrics).roundToInt()

  @SuppressLint("ClickableViewAccessibility")
  private fun build(context: Context) {
    if (row != null) return
    val size = dp(context, 56f)
    image = ImageView(context).apply {
      layoutParams = LinearLayout.LayoutParams(size, size)
      scaleType = ImageView.ScaleType.FIT_CENTER
      contentDescription = a11yLabel
      setOnClickListener { events.emit(OverlayEvent.Tap) }
      setOnTouchListener(Touch(context))
    }
    pill = TextView(context).apply {
      visibility = View.GONE
      setTextColor(Color.WHITE)
      maxWidth = dp(context, 220f)
      maxLines = 2
      ellipsize = android.text.TextUtils.TruncateAt.END
      val pad = dp(context, 10f)
      setPadding(pad, pad / 2, pad, pad / 2)
      background = GradientDrawable().apply { setColor(0xE6202124.toInt()); cornerRadius = dp(context, 16f).toFloat() }
    }
    row = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    arrange()
  }

  /** The pill sits on the inner side: after the bubble on the left edge, before it on the right. */
  private fun arrange() {
    val r = row ?: return
    r.removeAllViews()
    val gap = dp(r.context, 6f)
    (pill!!.layoutParams as? LinearLayout.LayoutParams ?: LinearLayout.LayoutParams(-2, -2)).also {
      it.marginStart = if (spot.edge == Edge.LEFT) gap else 0
      it.marginEnd = if (spot.edge == Edge.RIGHT) gap else 0
      pill!!.layoutParams = it
    }
    if (spot.edge == Edge.LEFT) { r.addView(image); r.addView(pill) } else { r.addView(pill); r.addView(image) }
  }

  /** Where the whole row goes: the bubble at its spot, the row shifted left by the pill's width on the right edge. */
  private fun place() {
    glide?.cancel()
    val (px, py) = pixels()
    val p = pill ?: return
    val shift = if (spot.edge == Edge.RIGHT && p.visibility == View.VISIBLE) {
      p.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED)
      p.measuredWidth + dp(p.context, 6f)
    } else 0
    x = px - shift; y = py
    host.move(x, y)
  }

  private fun bubbleSize(): Size = image?.let { Size(it.layoutParams.width, it.layoutParams.height) } ?: Size(0, 0)

  private fun pixels(): Pair<Int, Int> {
    val (screen, top) = screen()
    return Placement.toPixels(spot, screen, bubbleSize(), top, imeTopPx)
  }

  /** The screen size and the status bar's height, from the host's window manager. */
  private fun screen(): Pair<Size, Int> {
    val context = viewContext()!!
    val wm = context.getSystemService(WindowManager::class.java)
    if (Build.VERSION.SDK_INT >= 30) {
      val m = wm.currentWindowMetrics
      val insets = m.windowInsets.getInsetsIgnoringVisibility(WindowInsets.Type.systemBars())
      return Size(m.bounds.width(), m.bounds.height() - insets.bottom) to insets.top
    }
    val dm = context.resources.displayMetrics
    val id = context.resources.getIdentifier("status_bar_height", "dimen", "android")
    return Size(dm.widthPixels, dm.heightPixels) to (if (id != 0) context.resources.getDimensionPixelSize(id) else 0)
  }

  private fun settle(to: Spot) {
    val edgeChanged = to.edge != spot.edge
    spot = to
    spots.put(spotKey, to)
    events.emit(OverlayEvent.Moved(to))
    if (edgeChanged) arrange()
    val (px, py) = pixels()
    if (reducedMotion() || pill?.visibility == View.VISIBLE) { place(); return }
    val fromX = x; val fromY = y
    glide = ValueAnimator.ofFloat(0f, 1f).apply {
      duration = 180
      addUpdateListener {
        val f = it.animatedValue as Float
        x = (fromX + (px - fromX) * f).roundToInt(); y = (fromY + (py - fromY) * f).roundToInt()
        host.move(x, y)
      }
      start()
    }
  }

  private inner class Touch(context: Context) : View.OnTouchListener {
    private val density = context.resources.displayMetrics.density
    private var downX = 0f
    private var downY = 0f
    private var startX = 0
    private var startY = 0
    private var dragging = false
    private var longPressed = false
    private val longPress = Runnable { longPressed = true; events.emit(OverlayEvent.LongPress) }

    override fun onTouch(v: View, e: MotionEvent): Boolean {
      when (e.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          glide?.cancel()
          downX = e.rawX; downY = e.rawY; startX = x; startY = y
          dragging = false; longPressed = false
          main.postDelayed(longPress, ViewConfiguration.getLongPressTimeout().toLong())
        }
        MotionEvent.ACTION_MOVE -> {
          val dx = e.rawX - downX; val dy = e.rawY - downY
          if (!dragging && !longPressed && Placement.isDrag(dx, dy, density)) {
            dragging = true
            main.removeCallbacks(longPress)
          }
          if (dragging) { x = startX + dx.roundToInt(); y = startY + dy.roundToInt(); host.move(x, y) }
        }
        MotionEvent.ACTION_UP -> {
          main.removeCallbacks(longPress)
          val (screen, top) = screen()
          when {
            dragging -> settle(Placement.snap(x + rowOffset(), y, screen, bubbleSize(), top, imeTopPx))
            !longPressed -> v.performClick()
          }
        }
        MotionEvent.ACTION_CANCEL -> {
          main.removeCallbacks(longPress)
          if (dragging) settle(spot)
        }
      }
      return true
    }

    /** The bubble's x inside the row: past the pill when the pill is before it. */
    private fun rowOffset(): Int = image?.left ?: 0
  }
}
