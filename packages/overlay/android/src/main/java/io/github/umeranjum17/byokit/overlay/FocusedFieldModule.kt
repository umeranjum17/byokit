package io.github.umeranjum17.byokit.overlay

import android.content.ClipData
import android.content.ClipboardManager
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** A text field insert works on: its shown text (null when it went away), and setting it. */
interface EditableField {
  fun text(): String?
  fun set(text: String): Boolean
}

/** Insert's decisions (docs/capability-kits.md 7.4), pure so the JVM tests cover them. */
object Insert {
  const val RETRY_MS = 150L

  /** The field's whole new text: [text] over the selection (or at the end with none), or over all of it. */
  fun compose(current: String, selection: Pair<Int, Int>?, text: String, replace: String): String {
    if (replace == "all") return text
    val (a, b) = selection ?: (current.length to current.length)
    val start = minOf(a, b).coerceIn(0, current.length)
    val end = maxOf(a, b).coerceIn(0, current.length)
    return current.substring(0, start) + text + current.substring(end)
  }

  /** Sets [whole], reads it back, and retries once [RETRY_MS] later; else puts [text] on the clipboard. */
  fun run(field: EditableField, whole: String, text: String, pause: (Long) -> Unit, copy: (String) -> Boolean): String {
    for (attempt in 0..1) {
      if (attempt > 0) pause(RETRY_MS)
      field.set(whole)
      if (field.text() == whole) return "inserted"
    }
    return if (copy(text)) "copied" else "failed"
  }
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
      val node = focused() ?: return@AsyncFunction null
      mapOf(
        "app" to (node.packageName?.toString() ?: ""),
        "text" to shown(node),
        "selection" to selection(node)?.let { (start, end) -> mapOf("start" to start, "end" to end) },
      )
    }
    AsyncFunction("insert") { text: String, replace: String ->
      val node = focused() ?: return@AsyncFunction "failed"
      val whole = Insert.compose(shown(node), selection(node), text, replace)
      Insert.run(NodeField(node), whole, text, Thread::sleep, ::copy)
    }
  }

  private fun focused(): AccessibilityNodeInfo? =
    ByokitAccessibility.service?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.takeIf { it.isEditable && !it.isPassword }

  private fun copy(text: String): Boolean = runCatching {
    val context = appContext.reactContext ?: return false
    context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("text", text))
  }.isSuccess

  private class NodeField(private val node: AccessibilityNodeInfo) : EditableField {
    override fun text(): String? = if (node.refresh()) shown(node) else null
    override fun set(text: String): Boolean = node.performAction(
      AccessibilityNodeInfo.ACTION_SET_TEXT,
      Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) },
    )
  }

  private companion object {
    /** The field's own text; an empty field reports its hint as text, which is not the person's. */
    fun shown(node: AccessibilityNodeInfo): String = if (node.isShowingHintText) "" else node.text?.toString() ?: ""

    /** The selection in order (a caret is start == end), or null when the field reports none. */
    fun selection(node: AccessibilityNodeInfo): Pair<Int, Int>? {
      val a = node.textSelectionStart.takeIf { it >= 0 } ?: return null
      val b = node.textSelectionEnd.takeIf { it >= 0 } ?: a
      return minOf(a, b) to maxOf(a, b)
    }
  }
}
