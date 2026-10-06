package io.github.umeranjum17.byokit.example.a11y

import android.app.UiAutomation
import android.view.accessibility.AccessibilityNodeInfo
import org.junit.Assert.*
import java.util.concurrent.TimeUnit

/**
 * A cold CI emulator can start with the platform's "Application Not Responding" dialog for another app (SystemUI,
 * the launcher) owning focus. The fixture window then never gets focus and the dialog stays the active window, so
 * every fixture fails behind it. This precondition gives each such app's exact dialog one platform Wait; an ANR of
 * our own apps is a defect and fails instead.
 */
internal class PlatformAnr(private val automation: UiAutomation, private val ours: Set<String>,
  private val shell: (String) -> String, private val trace: (String) -> Unit = {}) {
  /** Apps whose ANR dialog got its single Wait. */
  val waited = mutableListOf<String>()

  /** The exact focused ANR dialog as (window, app), or null when none owns focus. */
  fun owner(): Pair<String, String>? {
    val title = "Application Not Responding: "
    val (windows, input, inputDump) = focus()
    println("Platform ANR owner: windows=$windows, input=$input")
    if (windows.none { it.contains(title) } && input.none { it.contains(title) }) return null
    // Both independent owners must name the same exact dialog on the sole CI display.
    val match = windows.singleOrNull()?.let {
      Regex("""mCurrentFocus=Window\{([0-9a-f]+) u0 Application Not Responding: ([\w.]+)\}""").matchEntire(it)
    }
    assertNotNull("Exact platform ANR window owner", match)
    val (window, app) = match!!.destructured
    assertTrue("Platform ANR is on focused display 0",
      inputDump.lineSequence().any { it.trim() == "FocusedDisplayId: 0" })
    assertEquals("Window manager and input must agree on the platform ANR owner",
      listOf("displayId=0, name='$window $title$app'"), input)
    return window to app
  }

  /** Window manager's and input's focused windows on the sole display, plus the raw input dump. */
  private fun focus(): Triple<List<String>, List<String>, String> {
    val windows = shell("dumpsys window displays").lineSequence()
      .map { it.trim().take(512) }.filter { it.startsWith("mCurrentFocus=") }.take(2).toList()
    val inputDump = shell("dumpsys input")
    val input = inputDump.lineSequence().map { it.trim().take(512) }
      .dropWhile { !it.startsWith("FocusedWindows:") }.drop(1)
      .takeWhile { it.startsWith("displayId=") }.take(2).toList()
    return Triple(windows, input, inputDump)
  }

  /** Gives each focused foreign ANR dialog exactly one Wait, until none owns focus. */
  fun clear() {
    while (true) {
      val (window, app) = owner() ?: break
      assertFalse("Our own app is not responding: $app", app in ours)
      assertFalse("Only one ANR Wait per app is permitted: $app", app in waited)
      trace("before single $app ANR Wait")
      waitOnce(window, app)
      // The platform dismisses the dialog asynchronously; the next owner must be a different window.
      val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
      while (focus().let { (windows, input) -> (windows + input).any { "{$window " in it || "'$window " in it } }) {
        assertTrue("$app ANR dialog closes after its Wait", System.nanoTime() < deadline)
        Thread.sleep(100)
      }
      trace("after single $app ANR Wait")
    }
    if (waited.isEmpty()) println("Platform ANR Wait: unexercised; no exact focused dialog")
  }

  private fun waitOnce(window: String, app: String) {
    val root = automation.rootInActiveWindow ?: error("$app ANR active root absent; left untouched")
    val controls = root.findAccessibilityNodeInfosByViewId("android:id/aerr_wait")
    try {
      assertEquals("$app ANR must expose the active platform dialog root", "android", root.packageName?.toString())
      assertEquals("Exactly one platform ANR Wait control", 1, controls.size)
      val wait = controls.single()
      val clickable = wait.actionList.any { it.id == AccessibilityNodeInfo.ACTION_CLICK }
      println("$app ANR Wait control: owner=$window, rootWindow=${root.windowId}, " +
        "controlWindow=${wait.windowId}, id=${wait.viewIdResourceName}, " +
        "visible=${wait.isVisibleToUser}, enabled=${wait.isEnabled}, clickable=$clickable")
      assertEquals("Wait belongs to the active dialog", root.windowId, wait.windowId)
      assertEquals("Platform Wait resource", "android:id/aerr_wait", wait.viewIdResourceName)
      assertTrue("Platform Wait is visible, enabled and supports click",
        wait.isVisibleToUser && wait.isEnabled && wait.isClickable && clickable)
      assertEquals("Exact dialog still owns focus immediately before Wait", window to app, owner())
      waited += app
      val accepted = wait.performAction(AccessibilityNodeInfo.ACTION_CLICK)
      println("$app ANR Wait: one action issued; accepted=$accepted")
      assertTrue("Platform accepted the single Wait action", accepted)
    } finally {
      controls.forEach { it.recycle() }
      root.recycle()
    }
  }
}
