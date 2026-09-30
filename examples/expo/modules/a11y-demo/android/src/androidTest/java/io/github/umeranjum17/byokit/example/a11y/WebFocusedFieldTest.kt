package io.github.umeranjum17.byokit.example.a11y

import android.app.UiAutomation
import android.content.Intent
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

  private fun js(activity: WebFieldActivity, script: String): String {
    val done = CountDownLatch(1)
    var result = ""
    instrumentation.runOnMainSync {
      activity.web.evaluateJavascript(script) { result = it; done.countDown() }
    }
    assertTrue("JavaScript completed", done.await(5, TimeUnit.SECONDS))
    return result
  }

  @Test fun textareaAndInputResolveAndInsertTenTimesAndPasswordsStayHidden() {
    val context = instrumentation.targetContext
    val previous = shell("settings get secure enabled_accessibility_services")
    val enabled = shell("settings get secure accessibility_enabled")
    var activity: WebFieldActivity? = null
    try {
      val component = "${context.packageName}/${WebFieldService::class.java.name}"
      shell("settings put secure enabled_accessibility_services $component")
      shell("settings put secure accessibility_enabled 1")
      val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
      while (WebFieldService.connected == null && System.nanoTime() < deadline) Thread.sleep(50)
      val service = WebFieldService.connected ?: error("Test accessibility service did not connect")
      val page = instrumentation.startActivitySync(Intent(context, WebFieldActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as WebFieldActivity
      activity = page
      assertTrue("Local WebView page loaded", page.loaded.await(10, TimeUnit.SECONDS))

      assertNull("No focus never guesses the decoy", FocusedFields.read(service))
      repeat(10) { run ->
        for ((id, seed) in listOf("area" to "textarea seed", "line" to "input seed")) {
          instrumentation.runOnMainSync { page.web.requestFocus() }
          assertEquals("\"$id\"", js(page, """
            (() => { const field = document.getElementById('$id'); field.value = '$seed';
              field.focus(); field.setSelectionRange(0, field.value.length); return document.activeElement.id; })()
          """.trimIndent()))
          // No sleep/poll here: the production resolver must handle the settling virtual tree itself.
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
      js(page, "document.getElementById('password').focus(); document.activeElement.id")
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
