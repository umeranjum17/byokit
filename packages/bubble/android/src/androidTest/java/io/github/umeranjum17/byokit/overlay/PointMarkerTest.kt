package io.github.umeranjum17.byokit.overlay

import android.app.UiAutomation
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Real Android window and accessibility dispatch, with no UI dumps suppressing the observer. */
@RunWith(AndroidJUnit4::class)
class PointMarkerTest {
  @Test fun markerAnnouncesItsLabelAndLeavesInputWithTheUnderlyingApp() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    val automation = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
    automation.executeShellCommand("appops set ${context.packageName} SYSTEM_ALERT_WINDOW allow").use {
      java.io.FileInputStream(it.fileDescriptor).use { stream -> stream.readBytes() }
    }
    var marker: PointMarker? = null
    try {
      val event = automation.executeAndWaitForEvent({
        instrumentation.runOnMainSync {
          val point = PointMarker(context, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY)
          marker = point
          val options = PointRecord()
          for ((name, value) in mapOf("x" to 120.0, "y" to 180.0, "label" to "Umer, tap here", "ms" to 10000.0)) {
            PointRecord::class.java.getDeclaredField(name).apply { isAccessible = true }.set(options, value)
          }
          assertEquals("shown", point.show(options))
        }
      }, { it.eventType == AccessibilityEvent.TYPE_ANNOUNCEMENT && it.text.contains("Umer, tap here") }, 5000)
      assertEquals(context.packageName, event.packageName.toString())
      instrumentation.runOnMainSync {
        val view = PointMarker::class.java.getDeclaredField("view").apply { isAccessible = true }.get(marker) as View
        val node = view.createAccessibilityNodeInfo()
        assertEquals("Umer, tap here", node.contentDescription.toString())
        assertFalse(node.isFocusable)
        assertFalse(node.isClickable)
        val params = view.layoutParams as WindowManager.LayoutParams
        assertTrue(params.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE != 0)
        assertTrue(params.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE != 0)
        assertTrue(params.alpha <= 0.6f)
        node.recycle()
      }
      event.recycle()
    } finally { instrumentation.runOnMainSync { marker?.dismiss() } }
  }
}
