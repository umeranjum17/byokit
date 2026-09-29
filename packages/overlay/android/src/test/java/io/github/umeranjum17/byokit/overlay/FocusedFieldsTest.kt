package io.github.umeranjum17.byokit.overlay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class FocusedFieldsTest {
  private class FakeNode(
    override val editable: Boolean = false,
    override val password: Boolean = false,
    current: String? = "",
    private var selection: Pair<Int, Int>? = null,
    private val children: List<FakeNode> = emptyList(),
    private val stripNewlines: Boolean = false,
    private val takesOn: Int = 1,
  ) : FieldNode {
    var current = current
      private set
    var sets = 0
    val copied = mutableListOf<String>()
    override fun shown() = current
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

  @Test fun findTakesTheNodeItselfWhenEditable() {
    val node = FakeNode(editable = true)
    assertSame(node, FocusedFields.find(node))
  }

  @Test fun findSkipsAPasswordFieldItself() {
    assertNull(FocusedFields.find(FakeNode(editable = true, password = true)))
  }

  @Test fun findSearchesFocusedDescendantsInOrder() {
    val first = FakeNode(editable = true)
    val root = FakeNode(children = listOf(FakeNode(), first, FakeNode(editable = true)))
    assertSame(first, FocusedFields.find(root))
  }

  @Test fun findSearchesNestedDescendantsAndSkipsPasswords() {
    val deep = FakeNode(editable = true)
    val root = FakeNode(
      children = listOf(
        FakeNode(children = listOf(FakeNode(editable = true, password = true))),
        FakeNode(children = listOf(FakeNode(), deep)),
      ),
    )
    assertSame(deep, FocusedFields.find(root))
  }

  @Test fun findReturnsNullWhenNothingIsEditable() {
    assertNull(FocusedFields.find(FakeNode(children = listOf(FakeNode(), FakeNode(editable = true, password = true)))))
    assertNull(FocusedFields.find(FakeNode()))
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
    assertEquals("copied", FocusedFields.insert(FakeNode(current = null), "hi", pause = noPause, copy = { true }))
    assertEquals("failed", FocusedFields.insert(FakeNode(current = null), "hi", pause = noPause, copy = { false }))
  }
}
