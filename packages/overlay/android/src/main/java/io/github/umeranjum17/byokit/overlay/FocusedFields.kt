package io.github.umeranjum17.byokit.overlay

import android.accessibilityservice.AccessibilityService
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo

/** How hard an insert tries (docs/capability-kits.md 7.4): more tries for a panel on top (Chrome needs ~13). */
data class InsertOpts(
  /** SET_TEXT tries, at least one. */
  val attempts: Int = Insert.DEFAULT_ATTEMPTS,
  /** The pause between tries. */
  val retryMs: Long = Insert.RETRY_MS,
  /** Resolve "landedWithoutNewlines" when a contenteditable dropped only the newlines. */
  val acceptNewlineLoss: Boolean = false,
)

/**
 * A text field as the kit sees it: the focused node itself, or a focused descendant (WebView/Chrome). An app's own
 * accessibility service wraps the node it captured with [FieldNode.of]; the JVM tests fake it.
 */
interface FieldNode {
  /** What identifies this field for a safe re-acquisition; null when it lacks a view id, bounds or package. */
  val identity: FieldIdentity? get() = null
  /** The same field (same [identity]) found again in the active window, or null; the caller recycles it. */
  fun reacquire(): FieldNode? = null
  /** Releases the wrapped node; the kit calls it only on nodes it obtained itself. */
  fun recycle() {}
  /** Whether the field takes text. */
  val editable: Boolean
  /** Whether it is a password field, which the kit never reads or types into. */
  val password: Boolean
  /** The shown text, or null when the node went away. */
  fun shown(): String?
  /** Replaces the whole text; true when the field accepted the action (read it back with [shown] to verify). */
  fun set(text: String): Boolean
  /** The selection as (start, end) with start <= end, or null when the field reports none. */
  fun selection(): Pair<Int, Int>?
  /** The number of child nodes. */
  val childCount: Int
  /** The [i]th child, or null when it went away; the caller recycles it. */
  fun child(i: Int): FieldNode?

  companion object {
    /**
     * The node an app's own accessibility service captured (at tap time, with `findFocus(FOCUS_INPUT)`) as a
     * [FieldNode], for [FocusedFields.find] and [FocusedFields.insert]. It re-acquires the same field through
     * [service], else the service attached with [ByokitAccessibility.attach]. [recycle] recycles [node].
     */
    fun of(node: AccessibilityNodeInfo, service: AccessibilityService? = null): FieldNode = NodeWrap(node, service)
  }
}

/** A captured field's identity: all three must match for a re-acquired node to count as the same field. */
data class FieldIdentity(
  /** The view's resource name, such as `com.app:id/input`. */
  val viewId: String,
  /** Screen bounds as left, top, right, bottom. */
  val bounds: List<Int>,
  /** The package that owns the field. */
  val app: String,
)

/** A selection in a field's text, start <= end. */
data class FieldSelection(val start: Int, val end: Int)

/** What [FocusedFields.read] returns: the field's package, its shown text and its selection. */
data class FocusedFieldText(val app: String, val text: String, val selection: FieldSelection?)

/**
 * The focused field for Kotlin callers (docs/capability-kits.md 7.4): the app's own accessibility service reads at
 * tap time and inserts into the captured node, with no JS running. Password fields are never read or typed into.
 */
object FocusedFields {
  /**
   * The node itself when it is an editable non-password field, else its first such descendant in child order. Focus is
   * not checked on descendants: pass the focused node (`findFocus(FOCUS_INPUT)`), not a layout from an event.
   */
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

  /**
   * The focused editable field now (see [find]), kept for a later [insert] by the app's own service; null when no
   * editable field has focus. The caller recycles it.
   */
  fun capture(service: AccessibilityService): FieldNode? {
    val root = NodeWrap(service.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return null, service)
    val node = find(root)
    if (node !== root) root.recycle()
    return node
  }

  /** The focused editable field's text, or null when no editable field has focus. */
  fun read(service: AccessibilityService): FocusedFieldText? {
    val raw = service.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return null
    val root = NodeWrap(raw, service)
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

  /**
   * Inserts [text] into [node] (usually from [find] or [capture]): compose over the selection (or `replace = "all"`),
   * set, read back, and retry up to [InsertOpts.attempts] times, pausing [InsertOpts.retryMs]. A retry re-acquires
   * the same field (same view id, bounds and package, never a different field) when [node] went stale. Otherwise
   * [copy] gets the text: "inserted", "landedWithoutNewlines", "copied" or "failed". Cancellation returns "cancelled"
   * before subsequent reads, writes or copy fallback; service detach cancels pending inserts. [node] stays the caller's.
   * [pause] blocks by default, so call it off the main thread.
   */
  fun insert(
    node: FieldNode,
    text: String,
    replace: String = "selection",
    opts: InsertOpts = InsertOpts(),
    pause: (Long) -> Unit = Thread::sleep,
    copy: (String) -> Boolean = { false },
    cancellation: InsertCancellation = InsertCancellation(),
    service: AccessibilityService? = (node as? NodeWrap)?.owner ?: ByokitAccessibility.service,
  ): String {
    ByokitAccessibility.track(service, cancellation)
    try {
      val value = insertSteps(node, text, replace, opts, pause, copy, cancellation)
      return cancellation.finish(value)
    } catch (_: InsertCancelled) {
      return cancellation.finish("cancelled")
    } finally {
      ByokitAccessibility.untrack(service, cancellation)
    }
  }

  private fun insertSteps(
    node: FieldNode, text: String, replace: String, opts: InsertOpts,
    pause: (Long) -> Unit, copy: (String) -> Boolean, cancellation: InsertCancellation,
  ): String {
    val identity = cancellation.step { node.identity }
    var active = node
    var whole: String? = null
    try {
      repeat(opts.attempts.coerceAtLeast(1)) { i ->
        cancellation.step { }
        if (i > 0) {
          pause(opts.retryMs.coerceAtLeast(0))
          cancellation.step {
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
        }
        val current = cancellation.step { active.shown() } ?: return@repeat
        if (whole == null) whole = Insert.compose(current, cancellation.step { active.selection() }, text, replace)
        val target = whole!!
        cancellation.step { active.set(target) }
        val shown = cancellation.step { active.shown() }
        if (shown == target) return "inserted"
        if (opts.acceptNewlineLoss && shown != null && Insert.lostOnlyNewlines(target, shown)) {
          return "landedWithoutNewlines"
        }
      }
      return if (cancellation.step { copy(text) }) "copied" else "failed"
    } finally {
      if (active !== node) active.recycle()
    }
  }

  /**
   * [insert] for the node an app's own accessibility service captured with `findFocus(FOCUS_INPUT)`: [node] itself
   * when it is an editable non-password field, else its first such descendant ([find]), with the same retry and
   * same-field re-acquisition (through [service], else the attached one). "failed" when there is no such field. [node] stays the caller's.
   */
  fun insert(
    node: AccessibilityNodeInfo,
    text: String,
    replace: String = "selection",
    opts: InsertOpts = InsertOpts(),
    pause: (Long) -> Unit = Thread::sleep,
    copy: (String) -> Boolean = { false },
    service: AccessibilityService? = ByokitAccessibility.service,
    cancellation: InsertCancellation = InsertCancellation(),
  ): String {
    ByokitAccessibility.track(service, cancellation)
    var root: FieldNode? = null
    var field: FieldNode? = null
    try {
      root = cancellation.step { NodeWrap(node, service) }
      field = cancellation.step { find(root!!) }
      val value = field?.let { insertSteps(it, text, replace, opts, pause, copy, cancellation) } ?: "failed"
      return cancellation.finish(value)
    } catch (_: InsertCancelled) {
      return cancellation.finish("cancelled")
    } finally {
      if (field !== root) field?.recycle()
      ByokitAccessibility.untrack(service, cancellation)
    }
  }

  /** A [insert] `copy` that puts the text on the clipboard; false when the clipboard turns it away. */
  fun clipboard(context: Context): (String) -> Boolean = { text ->
    runCatching {
      context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("text", text))
    }.isSuccess
  }
}

/** A live framework node as a [FieldNode]; re-acquires through [service], else the attached one. */
internal class NodeWrap(
  private val node: AccessibilityNodeInfo,
  private val service: AccessibilityService? = null,
) : FieldNode {
  internal val owner = service ?: ByokitAccessibility.service
  override val identity: FieldIdentity? = run {
    val id = node.viewIdResourceName?.takeIf { it.isNotBlank() }
    val app = node.packageName?.toString()?.takeIf { it.isNotBlank() }
    val b = Rect().also(node::getBoundsInScreen)
    // Rect.isEmpty, spelled out so the JVM tests' stubbed Rect agrees.
    if (id == null || app == null || b.left >= b.right || b.top >= b.bottom) null
    else FieldIdentity(id, listOf(b.left, b.top, b.right, b.bottom), app)
  }
  override fun reacquire(): FieldNode? {
    val captured = identity ?: return null
    val root = owner?.rootInActiveWindow ?: return null
    return FocusedFields.sameField(NodeWrap(root, owner), captured)
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
  override fun child(i: Int): FieldNode? = node.getChild(i)?.let { NodeWrap(it, owner) }
}
