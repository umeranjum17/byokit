package io.github.umeranjum17.byokit.overlay

import android.accessibilityservice.AccessibilityService

/**
 * The app's own accessibility service hands itself to the kit: `attach(this)` in onServiceConnected, `detach(this)`
 * when it goes. That supplies the 'accessibility' host, the foreground app, the keyboard's inset and the focused field.
 * Main thread only.
 */
object ByokitAccessibility {
  @Volatile var host: OverlayHost? = null
    private set
  @Volatile var foreground: ForegroundApp? = null
    private set
  @Volatile var keyboard: KeyboardInset? = null
    private set
  /** The attached service, for FocusedFieldModule. */
  @Volatile internal var service: AccessibilityService? = null
    private set
  /** A host on attach, null on detach. */
  val hosts = Listeners<OverlayHost?>()

  @Synchronized
  fun attach(service: AccessibilityService) {
    if (this.service === service) return
    this.service?.let(::detach)
    this.service = service
    foreground = AccessibilityForegroundApp(service)
    keyboard = AccessibilityKeyboardInset(service)
    val h = AccessibilityOverlayHost(service)
    host = h
    hosts.emit(h)
  }

  @Synchronized
  fun detach(service: AccessibilityService) {
    if (this.service !== service) return
    this.service = null
    (foreground as? AccessibilityForegroundApp)?.close()
    (keyboard as? AccessibilityKeyboardInset)?.close()
    foreground = null
    keyboard = null
    host?.remove()
    host = null
    hosts.emit(null)
  }
}
