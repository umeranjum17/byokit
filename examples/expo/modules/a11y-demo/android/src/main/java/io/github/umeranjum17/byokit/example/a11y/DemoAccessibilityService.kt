package io.github.umeranjum17.byokit.example.a11y

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.view.accessibility.AccessibilityEvent
import io.github.umeranjum17.byokit.overlay.ByokitAccessibility

/** The example's own accessibility service: it only hands itself to @byokit/overlay, which does the rest. */
class DemoAccessibilityService : AccessibilityService() {
  override fun onServiceConnected() = ByokitAccessibility.attach(this)

  override fun onUnbind(intent: Intent?): Boolean {
    ByokitAccessibility.detach(this)
    return super.onUnbind(intent)
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {}

  override fun onInterrupt() {}
}
