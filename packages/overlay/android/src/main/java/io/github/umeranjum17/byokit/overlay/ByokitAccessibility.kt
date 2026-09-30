package io.github.umeranjum17.byokit.overlay

import android.accessibilityservice.AccessibilityService

/**
 * The app's own accessibility service hands itself to the kit: `attach(this)` in onServiceConnected, `detach(this)`
 * when it goes. That supplies the 'accessibility' host, the foreground app, the keyboard's inset and the focused field.
 * Main thread only.
 */
object ByokitAccessibility {
  /** The 'accessibility' host while a service is attached. */
  @Volatile var host: OverlayHost? = null
    private set
  /** The foreground app while a service is attached. */
  @Volatile var foreground: ForegroundApp? = null
    private set
  /** The keyboard's top while a service is attached. */
  @Volatile var keyboard: KeyboardInset? = null
    private set
  /** The attached service, for FocusedFieldModule. */
  @Volatile internal var service: AccessibilityService? = null
    private set
  /** A host on attach, null on detach. */
  val hosts = Listeners<OverlayHost?>()

  /** Hands [service] to the kit (a different attached service is detached first); again for the same one is a no-op. */
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

  /** Takes [service] back; nothing when it is not the attached one. */
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
