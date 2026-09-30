package io.github.umeranjum17.byokit.overlay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class FocusedFieldsTest {
  private class FakeNode(
    override val editable: Boolean = false,
    override var password: Boolean = false,
    private val inputFocused: Boolean = false,
    private val accessibilityFocused: Boolean = false,
    current: String? = "",
    private var selection: Pair<Int, Int>? = null,
    private val children: List<FakeNode> = emptyList(),
    private val stripNewlines: Boolean = false,
    private val takesOn: Int = 1,
    override val identity: FieldIdentity? = null,
    private val reacquired: FieldNode? = null,
    private val unreadableReads: Int = 0,
  ) : FieldNode {
    private var ancestor: FakeNode? = null
    init { children.forEach { it.ancestor = this } }
    override fun parent(): FieldNode? = ancestor
    override fun findFocus(input: Boolean): FieldNode? {
      if (if (input) inputFocused else accessibilityFocused) return this
      return children.firstNotNullOfOrNull { it.findFocus(input) }
    }
    var current = current
      private set
    var sets = 0
    val copied = mutableListOf<String>()
    var reads = 0
    var recycled = 0
    override fun recycle() { recycled++ }
    override fun reacquire() = reacquired
    override fun shown(): String? = if (reads++ < unreadableReads) null else current
    override fun set(text: String): Boolean {
      sets++
      if (sets >= takesOn) current = if (stripNewlines) text.filter { it != '\n' && it != '\r' } else text
      return true
    }
    override fun selection() = selection
    override val childCount get() = children.size
    override fun child(i: Int): FieldNode = children[i]
  }

  private val noPause: (Long) -> Unit = { throw AssertionError("must not pause") }

  @Test fun webViewFocusNeverSelectsTheFirstEditableBox() {
    val first = FakeNode(editable = true, current = "first")
    val password = FakeNode(editable = true, password = true, inputFocused = true, current = "secret")
    val page = FakeNode(children = listOf(first, password))
    assertNull(FocusedFields.find(page))
    assertEquals("failed", FocusedFields.insert(password, "draft", copy = { throw AssertionError("must not copy") }))
    assertEquals(0, first.reads)
    assertEquals(0, first.sets)
    assertEquals(0, password.reads)
    assertEquals(0, password.sets)
  }

  @Test fun webViewSelectsTheInputFocusedPlainBox() {
    val first = FakeNode(editable = true)
    val focused = FakeNode(editable = true, inputFocused = true)
    assertSame(focused, FocusedFields.find(FakeNode(children = listOf(first, focused))))
    assertSame(focused, FocusedFields.find(focused))
  }

  @Test fun webViewWithoutFocusReturnsNoField() {
    assertNull(FocusedFields.find(FakeNode(children = listOf(FakeNode(editable = true)))))
    assertNull(FocusedFields.find(FakeNode(editable = true)))
  }

  @Test fun accessibilityFocusIsAFallbackAndInputFocusWins() {
    val accessible = FakeNode(editable = true, accessibilityFocused = true)
    assertSame(accessible, FocusedFields.find(FakeNode(children = listOf(FakeNode(editable = true), accessible))))
    val input = FakeNode(editable = true, inputFocused = true)
    assertSame(input, FocusedFields.find(FakeNode(children = listOf(accessible, input))))
    val password = FakeNode(editable = true, password = true, inputFocused = true)
    assertNull(FocusedFields.find(FakeNode(children = listOf(accessible, password))))
  }

  @Test fun focusedPasswordPathIsRejectedIncludingContainersAndAncestors() {
    val password = FakeNode(editable = true, password = true, accessibilityFocused = true)
    assertNull(FocusedFields.find(FakeNode(inputFocused = true, children = listOf(FakeNode(editable = true), password))))
    val field = FakeNode(editable = true, inputFocused = true)
    val protected = FakeNode(password = true, children = listOf(field))
    assertNull(FocusedFields.find(protected))
    assertNull(FocusedFields.find(field))
    assertEquals("failed", FocusedFields.insert(field, "draft", copy = { throw AssertionError("must not copy") }))
    assertEquals(0, field.reads)
    assertEquals(0, field.sets)
    val descendant = FakeNode(editable = true, accessibilityFocused = true)
    assertNull(FocusedFields.find(FakeNode(password = true, inputFocused = true, children = listOf(descendant))))
    assertEquals(0, descendant.reads)
  }

  @Test fun passwordChangeDuringRetryStopsReadsWritesAndClipboardFallback() {
    val field = FakeNode(editable = true, takesOn = 3)
    assertEquals("failed", FocusedFields.insert(field, "draft", pause = { field.password = true },
      copy = { throw AssertionError("must not copy") }))
    assertEquals(2, field.reads)
    assertEquals(1, field.sets)
  }

  @Test fun insertComposesOverTheSelection() {
    val node = FakeNode(editable = true, current = "a b c", selection = 2 to 3)
    assertEquals("inserted", FocusedFields.insert(node, "hi", pause = noPause, copy = { false }))
    assertEquals("a hi c", node.current)
    assertEquals(1, node.sets)
  }

  @Test fun insertRetriesUntilAttemptsRunOut() {
    val node = FakeNode(editable = true, current = "", takesOn = 3)
    val pauses = mutableListOf<Long>()
    assertEquals("inserted", FocusedFields.insert(node, "x", opts = InsertOpts(attempts = 5, retryMs = 50), pause = { pauses += it }, copy = { false }))
    assertEquals(3, node.sets)
    assertEquals(listOf(50L, 50L), pauses)
  }

  @Test fun insertReportsNewlineLossOnlyWhenAccepted() {
    val accepted = FakeNode(editable = true, stripNewlines = true)
    assertEquals(
      "landedWithoutNewlines",
      FocusedFields.insert(accepted, "a\nb", opts = InsertOpts(acceptNewlineLoss = true), pause = noPause, copy = { false }),
    )
    val copied = FakeNode(editable = true, stripNewlines = true)
    val pauses = mutableListOf<Long>()
    assertEquals("copied", FocusedFields.insert(copied, "a\nb", pause = { pauses += it }, copy = { true }))
    assertEquals(listOf(150L), pauses)
  }

  @Test fun insertIntoAGoneNodeCopiesOrFails() {
    assertEquals("copied", FocusedFields.insert(FakeNode(editable = true, current = null), "hi", pause = {}, copy = { true }))
    assertEquals("failed", FocusedFields.insert(FakeNode(editable = true, current = null), "hi", pause = {}, copy = { false }))
  }

  private val captured = FieldIdentity("app:id/input", listOf(10, 20, 100, 80), "app")

  @Test fun insertWaitsForTransientlyUnreadableCapturedNode() {
    val node = FakeNode(editable = true, current = "before", unreadableReads = 2)
    val pauses = mutableListOf<Long>()
    assertEquals("inserted", FocusedFields.insert(node, "!", opts = InsertOpts(3, 25), pause = { pauses += it }))
    assertEquals("before!", node.current)
    assertEquals(1, node.sets)
    assertEquals(listOf(25L, 25L), pauses)
  }

  @Test fun insertReacquiresSameFieldAndRecyclesIt() {
    val fresh = FakeNode(editable = true, current = "ab", selection = 1 to 2, identity = captured)
    val stale = FakeNode(editable = true, current = null, identity = captured, reacquired = fresh)
    assertEquals("inserted", FocusedFields.insert(stale, "!", pause = {}))
    assertEquals("a!", fresh.current)
    assertEquals(0, stale.sets)
    assertEquals(1, fresh.recycled)
    assertEquals(0, stale.recycled) // The caller still owns the captured node.
  }

  @Test fun insertRejectsEveryDifferentField() {
    val others = listOf(
      captured.copy(viewId = "app:id/other"),
      captured.copy(bounds = listOf(10, 30, 100, 90)),
      captured.copy(app = "other"),
    )
    for (identity in others) {
      val other = FakeNode(editable = true, identity = identity)
      val stale = FakeNode(editable = true, current = null, identity = captured, reacquired = other)
      assertEquals("failed", FocusedFields.insert(stale, "secret", pause = {}))
      assertEquals(0, other.sets)
      assertEquals(1, other.recycled)
    }
  }

  @Test fun sameFieldSearchMatchesAllPropertiesAndRecyclesOtherNodes() {
    val wrong = FakeNode(editable = true, identity = captured.copy(app = "other"))
    val match = FakeNode(editable = true, identity = captured)
    val branch = FakeNode(children = listOf(match))
    val root = FakeNode(children = listOf(wrong, branch))
    assertSame(match, FocusedFields.sameField(root, captured))
    assertEquals(1, wrong.recycled)
    assertEquals(1, branch.recycled)
    assertEquals(1, root.recycled)
    assertEquals(0, match.recycled)
  }

  @Test fun unreadableWindowExpiresToCopiedOrFailed() {
    for (copies in listOf(true, false)) {
      val node = FakeNode(editable = true, current = null)
      val pauses = mutableListOf<Long>()
      val clipboard = mutableListOf<String>()
      assertEquals(if (copies) "copied" else "failed", FocusedFields.insert(
        node, "hi", opts = InsertOpts(4, 35), pause = { pauses += it },
        copy = { clipboard += it; copies },
      ))
      assertEquals(listOf(35L, 35L, 35L), pauses)
      assertEquals(4, node.reads)
      assertEquals(0, node.sets)
      assertEquals(listOf("hi"), clipboard)
    }
  }

  @Test fun cancelMidRetryStopsReadsSetsAndCopyAndReturnsOnce() {
    val node = FakeNode(editable = true, takesOn = 3)
    val cancellation = InsertCancellation()
    val results = mutableListOf<String>()
    var copies = 0
    results += FocusedFields.insert(node, "x", opts = InsertOpts(5),
      pause = { cancellation.cancel(); cancellation.cancel() },
      copy = { copies++; true }, cancellation = cancellation)
    assertEquals(listOf("cancelled"), results)
    assertEquals(1, node.sets)
    assertEquals(2, node.reads)
    assertEquals(0, copies)
  }

  @Test fun teardownMidRetryCancelsEveryPendingInsertAndLateStarts() {
    val service = object : android.accessibilityservice.AccessibilityService() {
      override fun onAccessibilityEvent(event: android.view.accessibility.AccessibilityEvent?) {}
      override fun onInterrupt() {}
    }
    val outer = FakeNode(editable = true, takesOn = 3)
    val inner = FakeNode(editable = true, takesOn = 3)
    val results = mutableListOf<String>()
    var copies = 0
    results += FocusedFields.insert(outer, "x", opts = InsertOpts(5), service = service,
      copy = { copies++; true }, pause = {
        results += FocusedFields.insert(inner, "y", opts = InsertOpts(5), service = service,
          copy = { copies++; true }, pause = { ByokitAccessibility.detach(service) })
      })
    assertEquals(listOf("cancelled", "cancelled"), results)
    assertEquals(1, outer.sets)
    assertEquals(1, inner.sets)
    assertEquals(2, outer.reads)
    assertEquals(2, inner.reads)
    assertEquals(0, copies)
    val late = FakeNode(editable = true)
    assertEquals("cancelled", FocusedFields.insert(late, "late", service = service))
    assertEquals(0, late.reads)
    assertEquals(0, late.sets)
  }

  @Test fun preCancelledInsertAndCancellationDuringReadSkipWritesAndFallback() {
    val cancellation = InsertCancellation().also { it.cancel() }
    val node = FakeNode(editable = true)
    assertEquals("cancelled", FocusedFields.insert(node, "x", cancellation = cancellation,
      copy = { throw AssertionError("must not copy") }))
    assertEquals(0, node.reads)
    assertEquals(0, node.sets)

    val duringRead = InsertCancellation()
    val field = object : FieldNode by node {
      override fun shown(): String? { duringRead.cancel(); return node.shown() }
    }
    assertEquals("cancelled", FocusedFields.insert(field, "x", cancellation = duringRead,
      copy = { throw AssertionError("must not copy") }))
    assertEquals(0, node.sets)
  }

  @Test fun cancellingAfterCompletionKeepsTheSingleCompletedResult() {
    val cancellation = InsertCancellation()
    assertEquals("inserted", FocusedFields.insert(FakeNode(editable = true), "x", cancellation = cancellation))
    cancellation.cancel()
    assertEquals("inserted", cancellation.finish("cancelled"))
  }

}
