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
    private var password: Boolean = false,
    private val inputFocused: Boolean = editable,
    private val accessibilityFocused: Boolean = false,
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
    private val passwordOnRefresh: Boolean = false,
    private val sameAs: Info? = null,
  ) : AccessibilityNodeInfo() {
    var focusSnapshot: Info? = null
    override fun equals(other: Any?): Boolean =
      other is Info && (sameAs ?: this) === (other.sameAs ?: other)
    override fun hashCode(): Int = System.identityHashCode(sameAs ?: this)
    var parentNode: Info? = null
    override fun getParent(): AccessibilityNodeInfo? = parentNode
    var textReads = 0
    override fun findFocus(focus: Int): AccessibilityNodeInfo? {
      if (if (focus == FOCUS_INPUT) inputFocused else accessibilityFocused) return focusSnapshot ?: this
      return kids.firstNotNullOfOrNull { it.findFocus(focus) }
    }
    val actions = mutableListOf<Int>()
    var recycled = 0
    override fun isEditable() = editable
    override fun isPassword() = password
    override fun isFocused() = inputFocused
    override fun isAccessibilityFocused() = accessibilityFocused
    override fun refresh(): Boolean {
      if (passwordOnRefresh) password = true
      return if (deadReads > 0) { deadReads--; false } else !gone
    }
    override fun isShowingHintText() = hint
    override fun getText(): CharSequence? { textReads++; return text }
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
    private val accessible: AccessibilityNodeInfo? = null,
  ) : AccessibilityService() {
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}
    override fun getRootInActiveWindow(): AccessibilityNodeInfo? = root
    override fun findFocus(focus: Int): AccessibilityNodeInfo? =
      if (focus == AccessibilityNodeInfo.FOCUS_INPUT) this.focus else accessible
  }

  private val identity = FieldIdentity("app:id/input", listOf(10, 20, 100, 80), "app")

  @Test fun ofReadsTheFrameworkNode() {
    val child = Info(editable = true)
    val node = FieldNode.of(Info(editable = true, password = true, text = "abc", selection = 3 to 1, kids = listOf(child)))
    assertTrue(node.editable)
    assertTrue(node.password)
    assertNull(node.shown())
    assertNull("password selections are hidden", node.selection())
    assertEquals("plain selections stay ordered", 1 to 3, FieldNode.of(Info(selection = 3 to 1)).selection())
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
    assertEquals(1, field.recycled) // the kit's focus wrapper
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
    val field = Info(editable = true, text = "hi", inputFocused = false, accessibilityFocused = true)
    val focus = Info(kids = listOf(field), inputFocused = true)
    val captured = FocusedFields.capture(Service(focus = focus))!!
    assertEquals("hi", captured.shown())
    assertEquals(2, focus.recycled) // two settling snapshots
    val releasedSnapshots = field.recycled // input traversal and guards own other snapshots of this fake
    captured.recycle()
    assertEquals(releasedSnapshots + 1, field.recycled)

    val self = Info(editable = true)
    val same = FocusedFields.capture(Service(focus = self))!!
    assertEquals(0, self.recycled)
    assertSame(null, FocusedFields.capture(Service()))
    val none = Info(kids = listOf(Info()))
    assertNull(FocusedFields.capture(Service(focus = none)))
    assertEquals(4, none.recycled) // bounded no-focus retries
    same.recycle()
  }

  @Test fun capturedFieldInsertsLater() {
    val field = Info(editable = true, text = "a", lands = "ab", inputFocused = false, accessibilityFocused = true)
    val captured = FocusedFields.capture(Service(focus = Info(kids = listOf(field), inputFocused = true)))!!
    assertEquals("inserted", FocusedFields.insert(captured, "b", pause = {}))
  }

  @Test fun wrappedWebViewInsertsIntoTheExactFocusedChild() {
    val first = Info(editable = true, text = "first", inputFocused = false)
    val focused = Info(editable = true, text = "focused", lands = "focused!")
    val page = Info(kids = listOf(first, focused))
    assertEquals("inserted", FocusedFields.insert(FieldNode.of(page), "!", pause = {},
      copy = { throw AssertionError("must insert into the focused field") }))
    assertEquals("focused!", focused.text)
    assertEquals(0, first.textReads)
    assertEquals(0, page.textReads)
    assertEquals(emptyList<Int>(), first.actions)
    assertEquals(emptyList<Int>(), page.actions)
    assertEquals(0, page.recycled)
  }

  @Test fun wrappedContainerWithoutFocusNeverReadsSetsOrCopies() {
    val page = Info(kids = listOf(Info(editable = true, inputFocused = false)))
    assertEquals("failed", FocusedFields.insert(FieldNode.of(page), "draft", pause = {},
      copy = { throw AssertionError("must not copy") }))
    assertEquals(0, page.textReads)
    assertEquals(emptyList<Int>(), page.actions)
  }

  @Test fun webViewPasswordFocusNeverReadsWritesOrCopiesTheFirstBox() {
    val first = Info(editable = true, text = "first", inputFocused = false)
    val password = Info(editable = true, password = true, text = "secret")
    val page = Info(kids = listOf(first, password))
    val service = Service(focus = page)
    assertNull(FocusedFields.read(service))
    assertNull(FocusedFields.capture(service))
    assertEquals("failed", FocusedFields.insert(page, "draft", copy = { throw AssertionError("must not copy") }))
    assertEquals("failed", FocusedFields.insert(FieldNode.of(page), "draft", copy = { throw AssertionError("must not copy") }))
    assertNull(FieldNode.of(password).shown())
    assertFalse(FieldNode.of(password).set("draft"))
    assertEquals(0, first.textReads)
    assertEquals(0, password.textReads)
    assertEquals(emptyList<Int>(), first.actions)
    assertEquals(emptyList<Int>(), password.actions)
  }

  @Test fun webViewPlainFocusReadsAndInsertsIntoTheFocusedBox() {
    val first = Info(editable = true, text = "first", inputFocused = false)
    val field = Info(editable = true, text = "focused", lands = "focused!")
    val page = Info(kids = listOf(first, field))
    assertEquals("focused", FocusedFields.read(Service(focus = page))?.text)
    assertEquals("inserted", FocusedFields.insert(page, "!", pause = { throw AssertionError("no pause") }))
    assertEquals("first", first.text)
    assertEquals("focused!", field.text)
    assertEquals(0, first.textReads)
    assertEquals(emptyList<Int>(), first.actions)
  }

  @Test fun noFocusNeverGuessesAFieldAndAccessibilityFocusIsAFallback() {
    val field = Info(editable = true, inputFocused = false)
    val page = Info(kids = listOf(field))
    assertNull(FocusedFields.read(Service(root = page)))
    assertNull(FocusedFields.capture(Service(focus = page)))
    assertEquals("failed", FocusedFields.insert(page, "draft", copy = { throw AssertionError("must not copy") }))
    val accessible = Info(editable = true, inputFocused = false, accessibilityFocused = true, text = "accessible")
    assertEquals("accessible", FocusedFields.read(Service(accessible = accessible))?.text)
    assertEquals("accessible", FocusedFields.capture(Service(accessible = accessible))?.shown())
    val password = Info(editable = true, password = true)
    assertNull(FocusedFields.read(Service(focus = password, accessible = accessible)))
  }

  @Test fun equalFocusSnapshotKeepsItsNewerPasswordFlags() {
    val captured = Info(editable = true, text = "old snapshot")
    val focused = Info(editable = true, password = true, text = "secret", sameAs = captured)
    captured.focusSnapshot = focused
    assertEquals(captured, focused)
    assertNull(FocusedFields.capture(Service(focus = captured)))
    assertNull(FocusedFields.read(Service(focus = captured)))
    assertEquals("failed", FocusedFields.insert(captured, "draft", copy = { throw AssertionError("must not copy") }))
    assertEquals(0, captured.textReads)
    assertEquals(0, focused.textReads)
    assertEquals(emptyList<Int>(), captured.actions)
    assertEquals(emptyList<Int>(), focused.actions)
  }

  @Test fun passwordAncestorNeverExposesOrWritesTheFocusedVirtualField() {
    val field = Info(editable = true, text = "secret")
    field.parentNode = Info(password = true, kids = listOf(field))
    assertNull(FocusedFields.read(Service(focus = field)))
    assertNull(FocusedFields.capture(Service(focus = field)))
    assertNull(FieldNode.of(field).shown())
    assertEquals("failed", FocusedFields.insert(field, "draft", copy = { throw AssertionError("must not copy") }))
    assertFalse(FieldNode.of(field).set("draft"))
    assertEquals(0, field.textReads)
    assertEquals(emptyList<Int>(), field.actions)
  }

  @Test fun refreshThatRevealsAPasswordNeverExposesTextOrCopies() {
    val field = Info(editable = true, text = "secret", passwordOnRefresh = true)
    assertEquals("failed", FocusedFields.insert(FieldNode.of(field), "draft", pause = {},
      copy = { throw AssertionError("must not copy") }))
    assertEquals(0, field.textReads)
    assertEquals(emptyList<Int>(), field.actions)
    val direct = Info(editable = true, passwordOnRefresh = true)
    assertFalse(FieldNode.of(direct).set("draft"))
    assertEquals(emptyList<Int>(), direct.actions)
  }

  @Test fun reacquiredPasswordFailsWithoutClipboardFallback() {
    val password = Info(editable = true, password = true, text = "secret")
    val stale = Info(editable = true, gone = true)
    assertEquals("failed", FocusedFields.insert(stale, "draft", pause = {},
      copy = { throw AssertionError("must not copy") }, service = Service(root = Info(kids = listOf(password)))))
    assertEquals(0, password.textReads)
    assertEquals(emptyList<Int>(), password.actions)
  }

  @Test fun clipboardTurnedAwayIsFalseNotAThrow() {
    assertFalse(FocusedFields.clipboard(ContextWrapper(null))("hi"))
  }

  @Test fun windowRootFindsInputBeforeAccessibilityFallbackAndRefreshesTransientNodes() {
    val accessible = Info(editable = true, inputFocused = false, accessibilityFocused = true, text = "other")
    val field = Info(editable = true, text = "web field", deadReads = 1)
    val page = Info(inputFocused = true, kids = listOf(Info(editable = true, inputFocused = false), field))
    val service = Service(root = page, accessible = accessible)
    val pauses = mutableListOf<Long>()
    val focused = FocusedFields.focus(service) { pauses += it }
    assertSame(field, focused)
    assertEquals(listOf(75L, 75L), pauses) // unreadable first snapshot, then two agreeing snapshots
    assertEquals(0, accessible.textReads)
    assertEquals("web field", FieldNode.of(focused!!, service).shown())
  }

  @Test fun virtualInputFocusUnderANativeContainerNeverGuessesOrExposesPasswords() {
    val decoy = Info(editable = true, inputFocused = false, text = "leave me")
    val password = Info(editable = true, password = true, text = "secret")
    val page = Info(inputFocused = true, kids = listOf(decoy, password))
    assertNull(FocusedFields.read(Service(root = page)))
    assertEquals("failed", FocusedFields.insert(page, "draft", copy = { error("must not copy") }))
    assertEquals(0, decoy.textReads)
    assertEquals(0, password.textReads)
    assertEquals(emptyList<Int>(), decoy.actions)
    assertEquals(emptyList<Int>(), password.actions)
  }

  @Test fun aDescendantFieldReacquiresThroughThePassedService() {
    val fresh = Info(editable = true, text = "ab", lands = "ab!")
    val stale = Info(editable = true, gone = true)
    val captured = Info(kids = listOf(stale)) // input focus resolves the virtual descendant
    val result = FocusedFields.insert(captured, "!", pause = {}, service = Service(root = Info(kids = listOf(fresh))))
    assertEquals("inserted", result)
    assertEquals(emptyList<Int>(), stale.actions)
    assertEquals("ab!", fresh.text)
  }
}
