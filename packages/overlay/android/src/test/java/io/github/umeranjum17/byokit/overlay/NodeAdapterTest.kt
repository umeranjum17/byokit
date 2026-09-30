package io.github.umeranjum17.byokit.overlay

import android.accessibilityservice.AccessibilityService
import android.content.ContextWrapper
import android.graphics.Rect
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** The public adapter over framework nodes: FieldNode.of, insert(AccessibilityNodeInfo, ...), capture, clipboard. */
class NodeAdapterTest {
  /**
   * A framework node over android.jar's stubs. The stubbed Bundle keeps no text, so a set makes the node show [lands]
   * (the composed text the test expects); any other composition fails the read-back.
   */
  private class Info(
    private val editable: Boolean = false,
    private val password: Boolean = false,
    var text: String? = "",
    private val hint: Boolean = false,
    private val selection: Pair<Int, Int>? = null,
    private val id: String? = "app:id/input",
    private val pkg: String? = "app",
    private val box: List<Int> = listOf(10, 20, 100, 80),
    private val kids: List<Info> = emptyList(),
    private var deadReads: Int = 0,
    private val gone: Boolean = false,
    private val lands: String? = null,
  ) : AccessibilityNodeInfo() {
    val actions = mutableListOf<Int>()
    var recycled = 0
    override fun isEditable() = editable
    override fun isPassword() = password
    override fun refresh(): Boolean = if (deadReads > 0) { deadReads--; false } else !gone
    override fun isShowingHintText() = hint
    override fun getText(): CharSequence? = text
    override fun performAction(action: Int, arguments: Bundle?): Boolean {
      actions += action
      if (lands != null) text = lands
      return true
    }
    override fun getTextSelectionStart() = selection?.first ?: -1
    override fun getTextSelectionEnd() = selection?.second ?: -1
    override fun getChildCount() = kids.size
    override fun getChild(index: Int): AccessibilityNodeInfo = kids[index]
    override fun getViewIdResourceName() = id
    override fun getPackageName(): CharSequence? = pkg
    override fun getBoundsInScreen(outBounds: Rect) {
      outBounds.left = box[0]; outBounds.top = box[1]; outBounds.right = box[2]; outBounds.bottom = box[3]
    }
    @Deprecated("Deprecated in Java") override fun recycle() { recycled++ }
  }

  private class Service(
    private val root: AccessibilityNodeInfo? = null,
    private val focus: AccessibilityNodeInfo? = null,
  ) : AccessibilityService() {
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}
    override fun getRootInActiveWindow(): AccessibilityNodeInfo? = root
    override fun findFocus(focus: Int): AccessibilityNodeInfo? = this.focus
  }

  private val identity = FieldIdentity("app:id/input", listOf(10, 20, 100, 80), "app")

  @Test fun ofReadsTheFrameworkNode() {
    val child = Info(editable = true)
    val node = FieldNode.of(Info(editable = true, password = true, text = "abc", selection = 3 to 1, kids = listOf(child)))
    assertTrue(node.editable)
    assertTrue(node.password)
    assertEquals("abc", node.shown())
    assertEquals("a backwards selection is ordered", 1 to 3, node.selection())
    assertEquals(identity, node.identity)
    assertEquals(1, node.childCount)
    assertTrue(node.child(0)!!.editable)
    assertNull("no selection", FieldNode.of(Info()).selection())
    assertEquals("a hint is no text", "", FieldNode.of(Info(text = "Type here", hint = true)).shown())
    assertNull("a node that went away", FieldNode.of(Info(gone = true)).shown())
  }

  @Test fun ofNeedsAllThreePropertiesForAnIdentity() {
    assertNull(FieldNode.of(Info(id = null)).identity)
    assertNull(FieldNode.of(Info(id = " ")).identity)
    assertNull(FieldNode.of(Info(pkg = null)).identity)
    assertNull(FieldNode.of(Info(box = listOf(10, 20, 10, 80))).identity)
    assertNull(FieldNode.of(Info(box = listOf(10, 20, 100, 20))).identity)
  }

  @Test fun ofSetsTextAndRecyclesTheNode() {
    val info = Info(editable = true, lands = "x")
    val node = FieldNode.of(info)
    assertTrue(node.set("x"))
    assertEquals(listOf(AccessibilityNodeInfo.ACTION_SET_TEXT), info.actions)
    node.recycle()
    assertEquals(1, info.recycled)
  }

  @Test fun insertFindsTheFocusedDescendantAndLeavesTheCapturedNode() {
    val field = Info(editable = true, text = "ab", selection = 1 to 2, lands = "a!")
    val captured = Info(kids = listOf(Info(), field))
    assertEquals("inserted", FocusedFields.insert(captured, "!", pause = { throw AssertionError("no pause") }))
    assertEquals("a!", field.text)
    assertEquals(1, field.recycled) // the kit's own child wrapper
    assertEquals(0, captured.recycled) // the caller's
  }

  @Test fun insertWaitsOutATransientlyUnreadableCapturedNode() {
    val captured = Info(editable = true, text = "before", deadReads = 2, lands = "before!")
    val pauses = mutableListOf<Long>()
    val result = FocusedFields.insert(captured, "!", opts = InsertOpts(3, 25), pause = { pauses += it }, service = Service())
    assertEquals("inserted", result)
    assertEquals(listOf(25L, 25L), pauses)
    assertEquals(1, captured.actions.size)
    assertEquals(0, captured.recycled)
  }

  @Test fun insertReacquiresTheSameFieldThroughTheService() {
    val fresh = Info(editable = true, text = "ab", selection = 1 to 2, lands = "a!")
    val window = Info(pkg = "app", id = null, kids = listOf(Info(editable = true, id = "app:id/other"), fresh))
    val stale = Info(editable = true, gone = true)
    assertEquals("inserted", FocusedFields.insert(stale, "!", pause = {}, service = Service(root = window)))
    assertEquals("a!", fresh.text)
    assertEquals(emptyList<Int>(), stale.actions)
    assertEquals(0, stale.recycled)
    assertEquals(1, window.recycled)
    assertEquals(1, fresh.recycled)
  }

  @Test fun insertNeverTypesIntoADifferentField() {
    for (other in listOf(
      Info(editable = true, id = "app:id/other"),
      Info(editable = true, box = listOf(10, 30, 100, 90)),
      Info(editable = true, pkg = "other"),
      Info(editable = true, password = true),
    )) {
      val stale = Info(editable = true, gone = true)
      val clipboard = mutableListOf<String>()
      val result = FocusedFields.insert(
        stale, "secret", pause = {}, copy = { clipboard += it; true }, service = Service(root = Info(kids = listOf(other))),
      )
      assertEquals("copied", result)
      assertEquals(emptyList<Int>(), other.actions)
      assertEquals(listOf("secret"), clipboard)
    }
  }

  @Test fun insertFailsWithNoEditableField() {
    val password = Info(editable = true, password = true)
    assertEquals("failed", FocusedFields.insert(Info(kids = listOf(password)), "hi", copy = { true }))
    assertEquals(emptyList<Int>(), password.actions)
  }

  @Test fun captureKeepsTheFocusedFieldAndRecyclesTheRest() {
    val field = Info(editable = true, text = "hi")
    val focus = Info(kids = listOf(field))
    val captured = FocusedFields.capture(Service(focus = focus))!!
    assertEquals("hi", captured.shown())
    assertEquals(1, focus.recycled)
    assertEquals(0, field.recycled)
    captured.recycle()
    assertEquals(1, field.recycled)

    val self = Info(editable = true)
    val same = FocusedFields.capture(Service(focus = self))!!
    assertEquals(0, self.recycled)
    assertSame(null, FocusedFields.capture(Service()))
    val none = Info(kids = listOf(Info()))
    assertNull(FocusedFields.capture(Service(focus = none)))
    assertEquals(1, none.recycled)
    same.recycle()
  }

  @Test fun capturedFieldInsertsLater() {
    val field = Info(editable = true, text = "a", lands = "ab")
    val captured = FocusedFields.capture(Service(focus = Info(kids = listOf(field))))!!
    assertEquals("inserted", FocusedFields.insert(captured, "b", pause = {}))
  }

  @Test fun clipboardTurnedAwayIsFalseNotAThrow() {
    assertFalse(FocusedFields.clipboard(ContextWrapper(null))("hi"))
  }

  @Test fun aDescendantFieldReacquiresThroughThePassedService() {
    val fresh = Info(editable = true, text = "ab", lands = "ab!")
    val stale = Info(editable = true, gone = true)
    val captured = Info(kids = listOf(stale)) // a WebView focus: the field is a descendant
    val result = FocusedFields.insert(captured, "!", pause = {}, service = Service(root = Info(kids = listOf(fresh))))
    assertEquals("inserted", result)
    assertEquals(emptyList<Int>(), stale.actions)
    assertEquals("ab!", fresh.text)
  }
}
