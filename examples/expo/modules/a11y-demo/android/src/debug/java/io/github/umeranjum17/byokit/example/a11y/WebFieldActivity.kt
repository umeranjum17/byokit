package io.github.umeranjum17.byokit.example.a11y

import android.accessibilityservice.AccessibilityService
import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.webkit.WebView
import android.webkit.WebViewClient
import io.github.umeranjum17.byokit.overlay.ByokitAccessibility
import java.util.concurrent.CountDownLatch

/** Debug-only real Chromium accessibility tree; no model, account or network. */
class WebFieldActivity : Activity() {
  lateinit var web: WebView
  val loaded = CountDownLatch(1)

  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    web = WebView(this).apply {
      settings.javaScriptEnabled = true
      webViewClient = object : WebViewClient() {
        override fun onPageFinished(view: WebView, url: String) { loaded.countDown() }
      }
    }
    setContentView(web)
    web.loadDataWithBaseURL("https://byokit.invalid/", """
      <!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
      <label>Decoy<input id="decoy" value="leave me alone"></label><br>
      <label>Textarea<textarea id="area">textarea seed</textarea></label><br>
      <label>Input<input id="line" value="input seed"></label><br>
      <label>Password<input id="password" type="password" value="private"></label>
    """.trimIndent(), "text/html", "UTF-8", null)
  }

  override fun onDestroy() {
    web.destroy()
    super.onDestroy()
  }
}

/** The same attach/configuration path as an app-owned service, confined to the test APK. */
class WebFieldService : AccessibilityService() {
  companion object { @Volatile var connected: WebFieldService? = null }
  override fun onServiceConnected() {
    ByokitAccessibility.attach(this)
    connected = this
  }
  override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
  override fun onInterrupt() {}
  override fun onUnbind(intent: Intent?): Boolean {
    connected = null
    ByokitAccessibility.detach(this)
    return super.onUnbind(intent)
  }
  override fun onDestroy() {
    connected = null
    ByokitAccessibility.detach(this)
    super.onDestroy()
  }
}
