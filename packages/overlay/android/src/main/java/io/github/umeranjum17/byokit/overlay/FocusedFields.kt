package io.github.umeranjum17.byokit.overlay

import android.accessibilityservice.AccessibilityService
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo

/** How hard an insert tries (docs/capability-kits.md 7.4): more tries for a panel on top (Chrome needs ~13). */
data class InsertOpts(
  val attempts: Int = Insert.DEFAULT_ATTEMPTS,
  val retryMs: Long = Insert.RETRY_MS,
  val acceptNewlineLoss: Boolean = false,
)

/** A text field as the kit sees it: the focused node itself, or a focused descendant (WebView/Chrome). */
interface FieldNode {
  val editable: Boolean
  val password: Boolean
  /** The shown text, or null when the node went away. */
  fun shown(): String?
  fun set(text: String): Boolean
  fun selection(): Pair<Int, Int>?
  val childCount: Int
  fun child(i: Int): FieldNode?
}

data class FieldSelection(val start: Int, val end: Int)
data class FocusedFieldText(val app: String, val text: String, val selection: FieldSelection?)

/**
 * The focused field for Kotlin callers (docs/capability-kits.md 7.4): the app's own accessibility service reads at
 * tap time and inserts into the captured node, with no JS running. Password fields are never read or typed into.
 */
object FocusedFields {
  /** The node itself when it is an editable non-password field, else the first such focused descendant. */
  fun find(node: FieldNode): FieldNode? {
    if (node.editable && !node.password) return node
    for (i in 0 until node.childCount) {
      val found = node.child(i)?.let(::find)
      if (found != null) return found
    }
    return null
  }

  /** The focused editable field's text, or null when no editable field has focus. */
  fun read(service: AccessibilityService): FocusedFieldText? {
    val raw = service.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return null
    val node = find(NodeWrap(raw)) ?: return null
    return FocusedFieldText(
      raw.packageName?.toString() ?: "",
      node.shown() ?: return null,
      node.selection()?.let { (a, b) -> FieldSelection(a, b) },
    )
  }

  /** Inserts [text] into [node] (usually from [find]): compose, set, verify, retry, else copy back to the caller. */
  fun insert(
    node: FieldNode,
    text: String,
    replace: String = "selection",
    opts: InsertOpts = InsertOpts(),
    pause: (Long) -> Unit = Thread::sleep,
    copy: (String) -> Boolean = { false },
  ): String {
    val current = node.shown() ?: return if (copy(text)) "copied" else "failed"
    return Insert.run(NodeField(node), Insert.compose(current, node.selection(), text, replace), text, opts, pause, copy)
  }

  private class NodeField(private val node: FieldNode) : EditableField {
    override fun text(): String? = node.shown()
    override fun set(text: String): Boolean = node.set(text)
  }
}

/** A live framework node as a [FieldNode]. */
internal class NodeWrap(private val node: AccessibilityNodeInfo) : FieldNode {
  override val editable: Boolean get() = node.isEditable
  override val password: Boolean get() = node.isPassword
  override fun shown(): String? =
    if (node.refresh()) (if (node.isShowingHintText) "" else node.text?.toString() ?: "") else null
  override fun set(text: String): Boolean = node.performAction(
    AccessibilityNodeInfo.ACTION_SET_TEXT,
    Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) },
  )
  override fun selection(): Pair<Int, Int>? {
    val a = node.textSelectionStart.takeIf { it >= 0 } ?: return null
    val b = node.textSelectionEnd.takeIf { it >= 0 } ?: a
    return minOf(a, b) to maxOf(a, b)
  }
  override val childCount: Int get() = node.childCount
  override fun child(i: Int): FieldNode? = node.getChild(i)?.let(::NodeWrap)
}
