package io.github.umeranjum17.byokit.overlay

import android.accessibilityservice.AccessibilityService

/**
 * The app's own accessibility service hands itself to the kit: `attach(this)` in onServiceConnected, `detach(this)`
 * when it goes. That supplies the 'accessibility' host (BK-O3 adds the foreground app, keyboard and focused field).
 */
object ByokitAccessibility {
  @Volatile var host: OverlayHost? = null
    private set
  private var service: AccessibilityService? = null
  /** A host on attach, null on detach. */
  val hosts = Listeners<OverlayHost?>()

  @Synchronized
  fun attach(service: AccessibilityService) {
    if (this.service === service) return
    this.service = service
    val h = AccessibilityOverlayHost(service)
    host = h
    hosts.emit(h)
  }

  @Synchronized
  fun detach(service: AccessibilityService) {
    if (this.service !== service) return
    this.service = null
    host?.remove()
    host = null
    hosts.emit(null)
  }
}
