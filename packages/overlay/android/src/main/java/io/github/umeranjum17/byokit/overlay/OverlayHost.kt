package io.github.umeranjum17.byokit.overlay

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.graphics.PixelFormat
import android.os.Build
import android.view.Gravity
import android.view.View
import android.view.WindowManager

/** Where the bubble's view lives: a window over other apps. Positions are the view's top-left, in pixels. */
interface OverlayHost {
  fun add(view: View, x: Int, y: Int)
  fun move(x: Int, y: Int)
  fun remove()
  val attached: Boolean
}

/** A `TYPE_APPLICATION_OVERLAY` window; needs the SYSTEM_ALERT_WINDOW grant. */
class WindowOverlayHost(context: Context) :
  WindowManagerHost(context, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY)

/** A `TYPE_ACCESSIBILITY_OVERLAY` window from the app's own accessibility service; needs no overlay grant. */
class AccessibilityOverlayHost(service: AccessibilityService) :
  WindowManagerHost(service, WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY)

/** The shared body of both hosts: one not-focusable, wrap-content window at the top-left gravity. */
abstract class WindowManagerHost(internal val context: Context, type: Int) : OverlayHost {
  private val windows = context.getSystemService(WindowManager::class.java)
  private val params = WindowManager.LayoutParams(
    WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, type,
    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
    PixelFormat.TRANSLUCENT,
  ).apply {
    gravity = Gravity.TOP or Gravity.START
    // Screen coordinates, status bar included, which is what Placement works in.
    flags = flags or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
    if (Build.VERSION.SDK_INT >= 30) fitInsetsTypes = 0
  }
  private var view: View? = null

  override val attached: Boolean get() = view != null

  override fun add(view: View, x: Int, y: Int) {
    remove()
    params.x = x; params.y = y
    windows.addView(view, params)
    this.view = view
  }

  override fun move(x: Int, y: Int) {
    val v = view ?: return
    params.x = x; params.y = y
    windows.updateViewLayout(v, params)
  }

  override fun remove() {
    val v = view ?: return
    view = null
    try { windows.removeView(v) } catch (_: IllegalArgumentException) { /* already gone with its window */ }
  }
}
