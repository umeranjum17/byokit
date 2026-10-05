package io.github.umeranjum17.byokit.example.a11y

import android.accessibilityservice.AccessibilityService
import android.app.UiAutomation
import android.content.Intent
import android.graphics.PixelFormat
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.View
import android.view.WindowManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.umeranjum17.byokit.overlay.ByokitAccessibility
import io.github.umeranjum17.byokit.overlay.AccessibilityForegroundApp
import io.github.umeranjum17.byokit.overlay.FocusedFieldText
import io.github.umeranjum17.byokit.overlay.FocusedFields
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

/** Account-free fixture: attached app-owned service, a window with no focused editor, and our own overlay. */
@RunWith(AndroidJUnit4::class)
class ForegroundAppTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val automation = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
  private fun shell(command: String): String = automation.executeShellCommand(command).use {
    android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().readText().trim()
  }
  private fun await(message: String, condition: () -> Boolean) {
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
    while (!condition()) {
      assertTrue(message, System.nanoTime() < deadline)
      Thread.sleep(50)
    }
  }

  @Test fun unknownPackageOrUnavailableRootReturnsNull() {
    val service = object : AccessibilityService() {
      init { attachBaseContext(instrumentation.targetContext) }
      var missing = true
      var app: String? = null
      override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
      override fun onInterrupt() {}
      @Suppress("DEPRECATION")
      override fun getRootInActiveWindow(): AccessibilityNodeInfo? =
        if (missing) null else AccessibilityNodeInfo.obtain().apply {
          packageName = app
          text = "Private fixture text" // the public read must remain just a package
          // Framework-delivered nodes are sealed; getWindow() rejects an unsealed synthetic node.
          AccessibilityNodeInfo::class.java.getDeclaredMethod("setSealed", Boolean::class.javaPrimitiveType)
            .invoke(this, true)
        }
      override fun getRootInActiveWindow(prefetchingStrategy: Int): AccessibilityNodeInfo? = rootInActiveWindow
    }
    val source = AccessibilityForegroundApp(service)
    assertNull(source.current)
    service.missing = false
    assertNull(source.current)
    service.app = " "
    assertNull(source.current)
    service.app = "com.example.fixture"
    assertEquals("com.example.fixture", source.current)
  }

  @Test fun packageWithoutFocusedTextAndOverlayExclusionAndDetach() {
    val context = instrumentation.targetContext
    val previous = shell("settings get secure enabled_accessibility_services")
    val enabled = shell("settings get secure accessibility_enabled")
    var activity: WebFieldActivity? = null
    var overlay: View? = null
    var remove: (() -> Unit)? = null
    var manager: WindowManager? = null
    try {
      val component = "${context.packageName}/${WebFieldService::class.java.name}"
      shell("settings put secure enabled_accessibility_services $component")
      shell("settings put secure accessibility_enabled 1")
      await("Fixture service connects") { WebFieldService.connected != null }
      val service = WebFieldService.connected!!
      // Attach alone supplies the JS getter's source; no bubble start is needed.
      instrumentation.runOnMainSync { ByokitAccessibility.detach(service) }
      assertNull(ByokitAccessibility.foreground)
      instrumentation.runOnMainSync { ByokitAccessibility.attach(service) }
      val source = ByokitAccessibility.foreground!!
      val changes = java.util.concurrent.CopyOnWriteArrayList<String?>()
      instrumentation.runOnMainSync { remove = source.onChange { changes.add(it) } }
      activity = instrumentation.startActivitySync(Intent(context, WebFieldActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as WebFieldActivity
      assertTrue(activity!!.loaded.await(30, TimeUnit.SECONDS))
      // While our change listener is registered, the kit's Watch polls this getter on the app's main thread.
      // Polling it here too races for the same process-wide accessibility client whose WebView root fetch needs
      // that main thread: the two readers starve each other until the interaction timeout, and the await below
      // never sees the package. The subscription is that single poller's output, so it is the safe sync point.
      await("Foreground fixture package resolves without editor focus") { changes.contains(context.packageName) }
      var onMain: String? = null
      var focused: FocusedFieldText? = null
      instrumentation.runOnMainSync { onMain = source.current; focused = FocusedFields.read(service) }
      assertEquals(context.packageName, onMain)
      assertNull("Fixture has no focused text box", focused)
      instrumentation.runOnMainSync {
        manager = service.getSystemService(WindowManager::class.java)
        overlay = View(service)
        manager!!.addView(overlay, WindowManager.LayoutParams(80, 80,
          WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
          WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
          PixelFormat.TRANSLUCENT))
      }
      val fixture = "io.github.umeranjum17.byokit.example"
      shell("am start -W -n $fixture/${ForegroundFixtureActivity::class.java.name}")
      await("Change subscription emits the separate package beneath host overlay") { changes.contains(fixture) }
      onMain = null
      instrumentation.runOnMainSync { onMain = source.current }
      assertEquals("Host overlay must not replace the foreground package", fixture, onMain)
      assertFalse("No unrelated package emitted", changes.any { it != null && it != context.packageName && it != fixture })
      instrumentation.runOnMainSync {
        remove?.invoke(); remove = null
        ByokitAccessibility.detach(service)
      }
      assertNull("Service off clears the getter source", ByokitAccessibility.foreground)
      instrumentation.runOnMainSync { ByokitAccessibility.attach(service) }
      await("Reattach gets a fresh foreground source") { ByokitAccessibility.foreground?.current == fixture }
    } finally {
      instrumentation.runOnMainSync {
        remove?.invoke()
        overlay?.let { manager?.removeView(it) }
        activity?.finish()
      }
      shell("am force-stop io.github.umeranjum17.byokit.example")
      if (previous == "null") shell("settings delete secure enabled_accessibility_services")
      else shell("settings put secure enabled_accessibility_services $previous")
      if (enabled == "null") shell("settings delete secure accessibility_enabled")
      else shell("settings put secure accessibility_enabled $enabled")
    }
  }
}
