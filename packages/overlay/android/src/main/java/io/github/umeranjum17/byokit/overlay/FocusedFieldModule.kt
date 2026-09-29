package io.github.umeranjum17.byokit.overlay

import android.content.ClipData
import android.content.ClipboardManager
import android.view.accessibility.AccessibilityNodeInfo
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** A text field insert works on: its shown text (null when it went away), and setting it. */
interface EditableField {
  fun text(): String?
  fun set(text: String): Boolean
}

/** Insert's decisions (docs/capability-kits.md 7.4), pure so the JVM tests cover them. */
object Insert {
  const val RETRY_MS = 150L
  const val DEFAULT_ATTEMPTS = 2

  /** The field's whole new text: [text] over the selection (or at the end with none), or over all of it. */
  fun compose(current: String, selection: Pair<Int, Int>?, text: String, replace: String): String {
    if (replace == "all") return text
    val (a, b) = selection ?: (current.length to current.length)
    val start = minOf(a, b).coerceIn(0, current.length)
    val end = maxOf(a, b).coerceIn(0, current.length)
    return current.substring(0, start) + text + current.substring(end)
  }

  /** Sets [whole], reads it back, and retries [RETRY_MS] later; else puts [text] on the clipboard. */
  fun run(field: EditableField, whole: String, text: String, pause: (Long) -> Unit, copy: (String) -> Boolean): String =
    run(field, whole, text, InsertOpts(), pause, copy)

  /**
   * Sets [whole] up to [opts.attempts] times, pausing [opts.retryMs] between tries, and reads it back after every
   * set. A panel on top makes Chrome refuse SET_TEXT, so more tries land it. A contenteditable that drops newlines
   * still reads back the text without them: with [opts.acceptNewlineLoss] that resolves 'landedWithoutNewlines'
   * instead of falling back to the clipboard ('copied', or 'failed' when the clipboard turns it away too).
   */
  fun run(
    field: EditableField,
    whole: String,
    text: String,
    opts: InsertOpts,
    pause: (Long) -> Unit,
    copy: (String) -> Boolean,
  ): String {
    repeat(opts.attempts.coerceAtLeast(1)) { i ->
      if (i > 0) pause(opts.retryMs.coerceAtLeast(0))
      field.set(whole)
      val shown = field.text()
      if (shown == whole) return "inserted"
      if (opts.acceptNewlineLoss && shown != null && lostOnlyNewlines(whole, shown)) return "landedWithoutNewlines"
    }
    return if (copy(text)) "copied" else "failed"
  }

  /** Whether [shown] is [whole] with only its newlines gone (what a contenteditable reports after a landed insert). */
  fun lostOnlyNewlines(whole: String, shown: String): Boolean =
    whole.any { it == '\n' || it == '\r' } && shown == whole.filter { it != '\n' && it != '\r' }
}

class InsertRecord : Record {
  @Field val replace: String = "selection"
  @Field val attempts: Double = 2.0
  @Field val retryMs: Double = 150.0
  @Field val acceptNewlineLoss: Boolean = false
}

/**
 * Expo module 'ByokitFocusedField' (docs/capability-kits.md 7.4): the focused editable field, through the app's own
 * accessibility service, only when the app calls. Password fields are never read or typed into.
 */
class FocusedFieldModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ByokitFocusedField")

    AsyncFunction("available") { ByokitAccessibility.service != null }
    AsyncFunction("read") {
      val t = FocusedFields.read(ByokitAccessibility.service ?: return@AsyncFunction null)
        ?: return@AsyncFunction null
      mapOf(
        "app" to t.app,
        "text" to t.text,
        "selection" to t.selection?.let { (start, end) -> mapOf("start" to start, "end" to end) },
      )
    }
    AsyncFunction("insert") { text: String, o: InsertRecord ->
      val service = ByokitAccessibility.service ?: return@AsyncFunction "failed"
      val raw = service.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return@AsyncFunction "failed"
      val node = FocusedFields.find(NodeWrap(raw)) ?: return@AsyncFunction "failed"
      FocusedFields.insert(
        node, text, o.replace,
        InsertOpts(o.attempts.toInt(), o.retryMs.toLong(), o.acceptNewlineLoss), Thread::sleep, ::copy,
      )
    }
  }

  private fun copy(text: String): Boolean = runCatching {
    val context = appContext.reactContext ?: return false
    context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("text", text))
  }.isSuccess
}
