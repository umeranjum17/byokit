package io.github.umeranjum17.byokit.overlay

import android.accessibilityservice.AccessibilityService
import android.os.Bundle
import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo

/** How hard an insert tries (docs/capability-kits.md 7.4): more tries for a panel on top (Chrome needs ~13). */
data class InsertOpts(
  val attempts: Int = Insert.DEFAULT_ATTEMPTS,
  val retryMs: Long = Insert.RETRY_MS,
  val acceptNewlineLoss: Boolean = false,
)

/** A text field as the kit sees it: the focused node itself, or a focused descendant (WebView/Chrome). */
interface FieldNode {
  val identity: FieldIdentity? get() = null
  fun reacquire(): FieldNode? = null
  fun recycle() {}
  val editable: Boolean
  val password: Boolean
  /** The shown text, or null when the node went away. */
  fun shown(): String?
  fun set(text: String): Boolean
  fun selection(): Pair<Int, Int>?
  val childCount: Int
  fun child(i: Int): FieldNode?
}

/** All three properties must be present to identify a captured field safely. */
data class FieldIdentity(val viewId: String, val bounds: List<Int>, val app: String)

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
      val child = node.child(i) ?: continue
      val found = find(child)
      if (found !== child) child.recycle()
      if (found != null) return found
    }
    return null
  }

  /** The focused editable field's text, or null when no editable field has focus. */
  fun read(service: AccessibilityService): FocusedFieldText? {
    val raw = service.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return null
    val root = NodeWrap(raw)
    val node = find(root)
    try {
      if (node == null) return null
      return FocusedFieldText(
        raw.packageName?.toString() ?: "",
        node.shown() ?: return null,
        node.selection()?.let { (a, b) -> FieldSelection(a, b) },
      )
    } finally {
      if (node !== root) node?.recycle()
      root.recycle()
    }
  }

  /** Searches an owned tree for exactly the captured field, releasing every other node. */
  internal fun sameField(root: FieldNode, identity: FieldIdentity): FieldNode? {
    if (root.editable && !root.password && root.identity == identity) return root
    try {
      for (i in 0 until root.childCount) {
        val found = root.child(i)?.let { sameField(it, identity) }
        if (found != null) return found
      }
      return null
    } finally {
      root.recycle()
    }
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
    val identity = node.identity
    var active = node
    var whole: String? = null
    try {
      repeat(opts.attempts.coerceAtLeast(1)) { i ->
        if (i > 0) {
          pause(opts.retryMs.coerceAtLeast(0))
          if (identity != null) {
            val fresh = node.reacquire()
            if (fresh != null && fresh !== active) {
              if (fresh.editable && !fresh.password && fresh.identity == identity) {
                if (active !== node) active.recycle()
                active = fresh
              } else if (fresh !== node) fresh.recycle()
            }
          }
        }
        val current = active.shown() ?: return@repeat
        if (whole == null) whole = Insert.compose(current, active.selection(), text, replace)
        val target = whole!!
        active.set(target)
        val shown = active.shown()
        if (shown == target) return "inserted"
        if (opts.acceptNewlineLoss && shown != null && Insert.lostOnlyNewlines(target, shown)) {
          return "landedWithoutNewlines"
        }
      }
      return if (copy(text)) "copied" else "failed"
    } finally {
      if (active !== node) active.recycle()
    }
  }

}

/** A live framework node as a [FieldNode]. */
internal class NodeWrap(private val node: AccessibilityNodeInfo) : FieldNode {
  override val identity: FieldIdentity? = run {
    val id = node.viewIdResourceName?.takeIf { it.isNotBlank() }
    val app = node.packageName?.toString()?.takeIf { it.isNotBlank() }
    val bounds = Rect().also(node::getBoundsInScreen)
    if (id == null || app == null || bounds.isEmpty) null
    else FieldIdentity(id, listOf(bounds.left, bounds.top, bounds.right, bounds.bottom), app)
  }
  override fun reacquire(): FieldNode? {
    val captured = identity ?: return null
    val root = ByokitAccessibility.service?.rootInActiveWindow ?: return null
    return FocusedFields.sameField(NodeWrap(root), captured)
  }
  @Suppress("DEPRECATION")
  override fun recycle() = node.recycle()
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
