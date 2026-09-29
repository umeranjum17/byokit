package io.github.umeranjum17.byokit.overlay

import org.junit.Assert.assertEquals
import org.junit.Test

class InsertTest {
  /** A field that takes a set only from its [takesOn]th try (0: never), recording what happened. */
  private class Field(private val takesOn: Int) : EditableField {
    var text = "old"
    var sets = 0
    override fun text() = text
    override fun set(text: String): Boolean {
      sets++
      if (takesOn in 1..sets) this.text = text
      return true
    }
  }

  private val pauses = mutableListOf<Long>()
  private val copied = mutableListOf<String>()
  private fun run(field: Field, copies: Boolean = true) =
    Insert.run(field, "whole", "hi", { pauses += it }, { copied += it; copies })

  @Test fun insertedOnTheFirstTry() {
    val field = Field(takesOn = 1)
    assertEquals("inserted", run(field))
    assertEquals(1, field.sets)
    assertEquals(emptyList<Long>(), pauses)
    assertEquals(emptyList<String>(), copied)
  }

  @Test fun retriesOnce150msLater() {
    val field = Field(takesOn = 2)
    assertEquals("inserted", run(field))
    assertEquals(2, field.sets)
    assertEquals(listOf(150L), pauses)
    assertEquals(emptyList<String>(), copied)
  }

  @Test fun copiesTheTextWhenTheRetryStillDoesNotMatch() {
    val field = Field(takesOn = 0)
    assertEquals("copied", run(field))
    assertEquals(2, field.sets)
    assertEquals(listOf(150L), pauses)
    assertEquals(listOf("hi"), copied)
    assertEquals("old", field.text)
  }

  @Test fun failsWhenTheClipboardTurnsItAwayToo() {
    assertEquals("failed", run(Field(takesOn = 0), copies = false))
  }

  @Test fun aFieldThatWentAwayIsNotAMatch() {
    val gone = object : EditableField {
      override fun text(): String? = null
      override fun set(text: String) = false
    }
    assertEquals("copied", Insert.run(gone, "", "", { pauses += it }, { true }))
  }

  @Test fun composeReplacesTheSelectionOrAll() {
    assertEquals("a hi c", Insert.compose("a b c", 2 to 3, "hi", "selection"))
    assertEquals("a backwards selection", "a hi c", Insert.compose("a b c", 3 to 2, "hi", "selection"))
    assertEquals("at the caret", "a hib c", Insert.compose("a b c", 2 to 2, "hi", "selection"))
    assertEquals("no selection: at the end", "a b chi", Insert.compose("a b c", null, "hi", "selection"))
    assertEquals("hi", Insert.compose("a b c", 2 to 3, "hi", "all"))
    assertEquals("clamped into the text", "a b chi", Insert.compose("a b c", 9 to 12, "hi", "selection"))
  }
}
