package io.github.umeranjum17.byokit.example.a11y

import android.app.KeyguardManager
import android.app.UiAutomation
import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.view.accessibility.AccessibilityNodeInfo
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.umeranjum17.byokit.overlay.FocusedFields
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class WebFocusedFieldTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val automation = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)

  private fun shell(command: String): String = automation.executeShellCommand(command).use {
    android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().readText().trim()
  }

  private fun deviceState(): Triple<Boolean, Boolean, Boolean> {
    val context = instrumentation.targetContext
    val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    val keyguard = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
    return Triple(power.isInteractive, keyguard.isKeyguardLocked, keyguard.isKeyguardSecure)
  }

  private fun windowState(label: String) {
    val (interactive, locked, secure) = deviceState()
    println("WebView device $label: interactive=$interactive, keyguardLocked=$locked, keyguardSecure=$secure")
    // Keep the owner/precondition evidence bounded, rather than dumping every window or service.
    val owners = shell("dumpsys window displays").lineSequence().filter {
      it.contains("mCurrentFocus") || it.contains("mFocusedApp") ||
        it.contains("mTopFocusedDisplayId") || it.contains("mObscuringWindow") ||
        it.contains("keyguard", ignoreCase = true)
    }.take(12).map { it.trim().take(512) }.joinToString("\n")
    println("WebView windows $label:\n$owners")
    // Input focus owners follow their section headings on separate lines; keep those entries together.
    var focusSection = false
    val inputFocus = shell("dumpsys input").lineSequence().filter {
      val line = it.trim()
      val heading = line.startsWith("FocusedApplications:") ||
        line.startsWith("FocusedWindows:") || line.startsWith("FocusRequests:")
      val entry = focusSection && line.startsWith("displayId=")
      if (heading) focusSection = true
      else if (line.isNotEmpty() && !entry) focusSection = false
      heading || entry || line.startsWith("FocusedDisplayId:")
    }.take(12).map { it.trim().take(512) }.joinToString("\n")
    println("WebView input $label:\n$inputFocus")
  }

  private var systemUiWaitIssued = false

  private fun systemUiAnrOwner(): String? {
    val title = "Application Not Responding: com.android.systemui"
    val windows = shell("dumpsys window displays").lineSequence()
      .map { it.trim().take(512) }.filter { it.startsWith("mCurrentFocus=") }.take(2).toList()
    val inputDump = shell("dumpsys input")
    val input = inputDump.lineSequence().map { it.trim().take(512) }
      .dropWhile { !it.startsWith("FocusedWindows:") }.drop(1)
      .takeWhile { it.startsWith("displayId=") }.take(2).toList()
    println("SystemUI ANR owner: windows=$windows, input=$input")
    if (windows.none { it.contains(title) } && input.none { it.contains(title) }) return null
    // Both independent owners must name the same exact dialog on the sole CI display.
    val owner = windows.singleOrNull()?.let {
      Regex("""mCurrentFocus=Window\{([0-9a-f]+) u0 Application Not Responding: com\.android\.systemui\}""")
        .matchEntire(it)?.groupValues?.get(1)
    }
    assertNotNull("Exact SystemUI ANR window owner", owner)
    assertTrue("SystemUI ANR is on focused display 0",
      inputDump.lineSequence().any { it.trim() == "FocusedDisplayId: 0" })
    assertEquals("Window manager and input must agree on the SystemUI ANR owner",
      listOf("displayId=0, name='$owner $title'"), input)
    return owner
  }

  private fun waitForExactSystemUiAnr() {
    val owner = systemUiAnrOwner()
    if (owner == null) {
      println("SystemUI ANR Wait: unexercised; no exact focused dialog")
      return
    }
    windowState("before single SystemUI ANR Wait")
    val root = automation.rootInActiveWindow ?: error("SystemUI ANR active root absent; left untouched")
    val controls = root.findAccessibilityNodeInfosByViewId("android:id/aerr_wait")
    try {
      assertEquals("SystemUI ANR must expose the active platform dialog root", "android", root.packageName?.toString())
      assertEquals("Exactly one platform ANR Wait control", 1, controls.size)
      val wait = controls.single()
      val clickable = wait.actionList.any { it.id == AccessibilityNodeInfo.ACTION_CLICK }
      println("SystemUI ANR Wait control: owner=$owner, rootWindow=${root.windowId}, " +
        "controlWindow=${wait.windowId}, id=${wait.viewIdResourceName}, " +
        "visible=${wait.isVisibleToUser}, enabled=${wait.isEnabled}, clickable=$clickable")
      assertEquals("Wait belongs to the active dialog", root.windowId, wait.windowId)
      assertEquals("Platform Wait resource", "android:id/aerr_wait", wait.viewIdResourceName)
      assertTrue("Platform Wait is visible, enabled and supports click",
        wait.isVisibleToUser && wait.isEnabled && wait.isClickable && clickable)
      assertEquals("Exact dialog still owns focus immediately before Wait", owner, systemUiAnrOwner())
      assertFalse("Only one SystemUI ANR Wait action is permitted", systemUiWaitIssued)
      systemUiWaitIssued = true
      val accepted = wait.performAction(AccessibilityNodeInfo.ACTION_CLICK)
      println("SystemUI ANR Wait: one action issued; accepted=$accepted")
      assertTrue("Platform accepted the single Wait action", accepted)
      windowState("after single SystemUI ANR Wait")
    } finally {
      controls.forEach { it.recycle() }
      root.recycle()
    }
  }

  private fun prepareDevice() {
    windowState("before setup")
    val (interactive, _, _) = deviceState()
    if (!interactive) {
      shell("input keyevent KEYCODE_WAKEUP")
      windowState("after wake")
    }
    // Never send credentials or try to bypass a secure lock. An unresolved lock still fails awaitPage.
    val (_, locked, secure) = deviceState()
    if (locked && !secure) {
      shell("wm dismiss-keyguard")
      windowState("after keyguard dismissal")
    }
    waitForExactSystemUiAnr()
  }

  private fun js(activity: WebFieldActivity, script: String): String {
    val done = CountDownLatch(1)
    var result = ""
    instrumentation.runOnMainSync {
      activity.web.evaluateJavascript(script) { result = it; done.countDown() }
    }
    assertTrue("JavaScript completed", done.await(10, TimeUnit.SECONDS))
    return result
  }

  private fun pageReady(activity: WebFieldActivity): Boolean {
    var ready = false
    instrumentation.runOnMainSync {
      ready = activity.web.run {
        isAttachedToWindow && isShown && hasWindowFocus() && isLaidOut && width > 0 && height > 0
      }
    }
    return ready
  }

  private fun pageState(activity: WebFieldActivity): String {
    var state = ""
    instrumentation.runOnMainSync {
      state = activity.web.run {
        "attached=$isAttachedToWindow, shown=$isShown, windowFocus=${hasWindowFocus()}, " +
          "laidOut=$isLaidOut, size=${width}x$height, layoutRequested=$isLayoutRequested"
      }
    }
    return state
  }

  private fun awaitPage(activity: WebFieldActivity) {
    val loaded = activity.loaded.await(60, TimeUnit.SECONDS)
    if (!loaded) windowState("page load timeout")
    assertTrue("Local WebView page loaded", loaded)
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60)
    var observed = ""
    while (!pageReady(activity)) {
      val state = pageState(activity)
      if (state != observed) { println("WebView waiting for page: $state"); observed = state }
      val withinDeadline = System.nanoTime() < deadline
      if (!withinDeadline) windowState("page focus timeout")
      assertTrue("WebView attached, laid out and window focused: $state", withinDeadline)
      instrumentation.runOnMainSync { activity.web.requestFocus() }
      Thread.sleep(100)
    }
    println("WebView page ready: ${pageState(activity)}")
    // onPageFinished does not guarantee that the DOM has reached the next rendered frame.
    val drawn = CountDownLatch(1)
    instrumentation.runOnMainSync {
      activity.web.postVisualStateCallback(0, object : WebView.VisualStateCallback() {
        override fun onComplete(requestId: Long) { drawn.countDown() }
      })
    }
    assertTrue("Local WebView page ready to draw", drawn.await(60, TimeUnit.SECONDS))
    if (systemUiWaitIssued) {
      windowState("fixture focus after single SystemUI ANR Wait")
      assertNull("SystemUI ANR must not persist after fixture focus", systemUiAnrOwner())
      assertTrue("Fixture retains window focus after Wait", pageReady(activity))
    }
  }

  /** DOM focus completes before Chromium publishes it to Android. Wait on that independent test precondition,
   * not on repeated kit reads: once ready, each run still requires read/capture/insert to succeed on its first call.
   */
  @Suppress("DEPRECATION")
  private fun awaitFocus(service: AccessibilityService, activity: WebFieldActivity, id: String,
    description: String, text: String? = null, password: Boolean = false) {
    require(password || text != null)
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60)
    var nextRequest = 0L
    var requests = 0
    var observed = "no snapshot"
    val app = instrumentation.targetContext.packageName
    do {
      val editors = mutableListOf<AccessibilityNodeInfo>()
      fun visit(node: AccessibilityNodeInfo) {
        var kept = false
        try {
          if (!node.refresh() || node.packageName?.toString() != app) return
          if (node.isEditable) {
            editors += node
            kept = true
          }
          for (i in 0 until node.childCount) node.getChild(i)?.let(::visit)
        } finally {
          if (!kept) node.recycle()
        }
      }
      try {
        // Read raw framework snapshots, including virtual nodes, without exercising the kit's resolver.
        for (window in service.windows) {
          try { window.root?.let(::visit) } finally { window.recycle() }
        }
        service.rootInActiveWindow?.let(::visit)
        val unique = editors.distinct() // active root can repeat a window's independently owned snapshot
        val focused = unique.filter { it.isFocused }
        val ready = focused.singleOrNull()?.let {
          it.isPassword == password && (password || it.text?.toString() == text)
        } ?: false
        observed = "editors=${unique.size}, focused=${focused.size}, expected=${ready}"
        if (ready && pageReady(activity)) {
          println("Android accessibility focus ready: $description; requests=$requests; $observed")
          return
        }
      } finally {
        editors.forEach { it.recycle() }
      }
      if (System.nanoTime() >= nextRequest && pageReady(activity)) {
        instrumentation.runOnMainSync { activity.web.requestFocus() }
        // A DOM editor can remain active after an early native focus request was lost. Blur/refocus
        // generates a fresh Chromium focus event instead of waiting forever on that one request.
        assertEquals("\"$id\"", js(activity, """
          (() => { const field = document.getElementById('$id'); field.blur(); field.focus();
            ${if (password) "" else "field.setSelectionRange(0, field.value.length);"}
            return document.activeElement.id; })()
        """.trimIndent()))
        requests++
        nextRequest = System.nanoTime() + TimeUnit.SECONDS.toNanos(1)
      }
      Thread.sleep(100) // polling interval, never a substitute for the focus/text condition
    } while (System.nanoTime() < deadline)
    fail("Android accessibility focus did not settle: $description; requests=$requests; $observed; pageReady=${pageReady(activity)}")
  }

  @Test fun textareaAndInputResolveAndInsertTenTimesAndPasswordsStayHidden() {
    val context = instrumentation.targetContext
    val previous = shell("settings get secure enabled_accessibility_services")
    val enabled = shell("settings get secure accessibility_enabled")
    var activity: WebFieldActivity? = null
    try {
      prepareDevice()
      val component = "${context.packageName}/${WebFieldService::class.java.name}"
      shell("settings put secure enabled_accessibility_services $component")
      shell("settings put secure accessibility_enabled 1")
      val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60)
      while (WebFieldService.connected == null && System.nanoTime() < deadline) Thread.sleep(50)
      val service = WebFieldService.connected ?: error("Test accessibility service did not connect")
      val page = instrumentation.startActivitySync(Intent(context, WebFieldActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as WebFieldActivity
      activity = page
      awaitPage(page)

      assertEquals("\"\"", js(page, "document.activeElement.id"))
      assertNull("No focus never guesses the decoy", FocusedFields.read(service))
      repeat(10) { run ->
        for ((id, label) in listOf("area" to "textarea", "line" to "input")) {
          val seed = "$label seed $run" // a prior run's cached text cannot satisfy the readiness condition
          instrumentation.runOnMainSync { page.web.requestFocus() }
          assertEquals("\"$id\"", js(page, """
            (() => { const field = document.getElementById('$id'); field.value = '$seed';
              field.focus(); field.setSelectionRange(0, field.value.length); return document.activeElement.id; })()
          """.trimIndent()))
          awaitFocus(service, page, id, "$id ${run + 1}/10", text = seed)
          val read = FocusedFields.read(service)
          assertNotNull("$id read ${run + 1}/10", read)
          assertEquals("$id resolves the right node", seed, read!!.text)
          val field = FocusedFields.capture(service) ?: error("$id capture ${run + 1}/10 was null")
          try {
            assertEquals("$id insert ${run + 1}/10", "inserted", FocusedFields.insert(field, "$id-$run", replace = "all",
              copy = { error("A focused web field must insert, never copy") }, service = service))
          } finally { field.recycle() }
          assertEquals("\"$id-$run\"", js(page, "document.getElementById('$id').value"))
          assertEquals("\"leave me alone\"", js(page, "document.getElementById('decoy').value"))
        }
      }
      assertEquals("\"password\"", js(page, "document.getElementById('password').focus(); document.activeElement.id"))
      awaitFocus(service, page, "password", "password editor", password = true)
      assertNull("Password read is hidden", FocusedFields.read(service))
      assertNull("Password capture is hidden", FocusedFields.capture(service))
      val root = service.rootInActiveWindow ?: error("Password window root unavailable")
      try {
        assertEquals("failed", FocusedFields.insert(root, "never write", service = service,
          copy = { error("A password must never reach the clipboard") }))
      } finally {
        @Suppress("DEPRECATION") root.recycle()
      }
      assertEquals("\"private\"", js(page, "document.getElementById('password').value"))
      if (systemUiWaitIssued) {
        windowState("real checks after single SystemUI ANR Wait")
        assertNull("SystemUI ANR must not recur during the real checks", systemUiAnrOwner())
        assertTrue("Fixture retains window focus after real checks", pageReady(page))
      }
      println("WebView focused fields: textarea 10/10, input 10/10, password hidden; decoy untouched")
    } finally {
      activity?.let { page -> instrumentation.runOnMainSync { page.finish() } }
      if (previous == "null") shell("settings delete secure enabled_accessibility_services")
      else shell("settings put secure enabled_accessibility_services $previous")
      if (enabled == "null") shell("settings delete secure accessibility_enabled")
      else shell("settings put secure accessibility_enabled $enabled")
    }
  }
}
