package io.github.umeranjum17.byokit.overlay

import android.accessibilityservice.AccessibilityService
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityWindowInfo

/** The app in the foreground, from the app's own accessibility service. */
interface ForegroundApp {
  /** The foreground app's package name, or null when unknown. */
  val current: String?
  /** Calls [fn] with each change; the returned function stops it. */
  fun onChange(fn: (String?) -> Unit): () -> Unit
}

/** The keyboard's top edge in screen pixels while it is open. */
interface KeyboardInset {
  /** The keyboard's top in screen pixels, or null while it is closed. */
  val imeTopPx: Int?
  /** Calls [fn] with each change; the returned function stops it. */
  fun onChange(fn: (Int?) -> Unit): () -> Unit
}

/**
 * The package of the window the person is using: the service's active window's root (needs `canRetrieveWindowContent`).
 * Only the root is fetched where Android allows it (13+), so no other node of that app's screen is read.
 */
class AccessibilityForegroundApp(private val service: AccessibilityService) : ForegroundApp {
  private val watch = Watch { current }
  @Suppress("DEPRECATION")
  override val current: String? get() = runCatching {
    val root = if (Build.VERSION.SDK_INT >= 33) service.getRootInActiveWindow(0) else service.rootInActiveWindow
    if (root == null) return@runCatching null
    try {
      val window = root.window
      val overlay = try {
        window?.type == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY ||
          (root.packageName?.toString() == service.packageName &&
            (window?.type == AccessibilityWindowInfo.TYPE_SYSTEM || PanelActivity.current != null))
      } finally { window?.recycle() }
      if (!overlay) return@runCatching root.packageName?.toString()?.takeIf { it.isNotBlank() }
      // A host overlay can become the active root. Resolve only an active/focused application window,
      // never an arbitrary background app and never children or screen text.
      val windows = service.windows
      try {
        val underlying = windows.firstOrNull {
          it.type == AccessibilityWindowInfo.TYPE_APPLICATION && (it.isActive || it.isFocused) &&
            (PanelActivity.current == null || it.id != root.windowId)
        } ?: return@runCatching null
        val appRoot = if (Build.VERSION.SDK_INT >= 33) underlying.getRoot(0) else underlying.root
        try { appRoot?.packageName?.toString()?.takeIf { it.isNotBlank() } }
        finally { appRoot?.recycle() }
      } finally { windows.forEach { it.recycle() } }
    } finally { root.recycle() }
  }.getOrNull()
  override fun onChange(fn: (String?) -> Unit): () -> Unit = watch.onChange(fn)
  internal fun close() = watch.close()
}

/** The input method window's top, from the service's window list (needs `flagRetrieveInteractiveWindows`). */
class AccessibilityKeyboardInset(private val service: AccessibilityService) : KeyboardInset {
  private val watch = Watch { imeTopPx }
  override val imeTopPx: Int? get() = runCatching {
    service.windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }
      ?.let { Rect().also(it::getBoundsInScreen).top }
  }.getOrNull()
  override fun onChange(fn: (Int?) -> Unit): () -> Unit = watch.onChange(fn)
  internal fun close() = watch.close()
}

/**
 * A value read from the service, re-read while anyone listens and reported when it changes. The kit gets the app's
 * service only through attach, not its events, so it polls. Main thread only.
 * ponytail: polls every POLL_MS while a listener exists; take events from the app's service if that ever costs too much.
 */
internal class Watch<T>(private val read: () -> T) {
  private val main = Handler(Looper.getMainLooper())
  private val listeners = Listeners<T>()
  private var count = 0
  private var last: T? = null
  private val tick = object : Runnable {
    override fun run() {
      val now = read()
      if (now != last) { last = now; listeners.emit(now) }
      main.postDelayed(this, POLL_MS)
    }
  }

  fun onChange(fn: (T) -> Unit): () -> Unit {
    val remove = listeners.add(fn)
    if (count++ == 0) { last = read(); main.postDelayed(tick, POLL_MS) }
    var removed = false
    return {
      if (!removed) {
        removed = true
        remove()
        if (--count == 0) main.removeCallbacks(tick)
      }
    }
  }

  fun close() { count = 0; main.removeCallbacks(tick) }

  companion object {
    const val POLL_MS = 400L
  }
}
