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

  @Test fun composeReplacesTheSelectionOrAll() {    assertEquals("a hi c", Insert.compose("a b c", 2 to 3, "hi", "selection"))
    assertEquals("a backwards selection", "a hi c", Insert.compose("a b c", 3 to 2, "hi", "selection"))
    assertEquals("at the caret", "a hib c", Insert.compose("a b c", 2 to 2, "hi", "selection"))
    assertEquals("no selection: at the end", "a b chi", Insert.compose("a b c", null, "hi", "selection"))
    assertEquals("hi", Insert.compose("a b c", 2 to 3, "hi", "all"))
    assertEquals("clamped into the text", "a b chi", Insert.compose("a b c", 9 to 12, "hi", "selection"))
  }

  private fun runOpts(field: Field, opts: InsertOpts, copies: Boolean = true) =
    Insert.run(field, "whole", "hi", opts, { pauses += it }, { copied += it; copies })

  @Test fun moreAttemptsLandALateTake() {
    val field = Field(takesOn = 3)
    assertEquals("inserted", runOpts(field, InsertOpts(attempts = 5)))
    assertEquals(3, field.sets)
    assertEquals(listOf(150L, 150L), pauses)
  }

  @Test fun attemptsRunOutThenCopies() {
    val field = Field(takesOn = 4)
    assertEquals("copied", runOpts(field, InsertOpts(attempts = 3)))
    assertEquals(3, field.sets)
    assertEquals(listOf(150L, 150L), pauses)
    assertEquals(listOf("hi"), copied)
  }

  @Test fun oneAttemptNeverPauses() {
    val field = Field(takesOn = 0)
    assertEquals("copied", runOpts(field, InsertOpts(attempts = 1)))
    assertEquals(1, field.sets)
    assertEquals(emptyList<Long>(), pauses)
  }

  @Test fun attemptsBelowOneStillTryOnce() {
    val field = Field(takesOn = 1)
    assertEquals("inserted", runOpts(field, InsertOpts(attempts = 0)))
    assertEquals(1, field.sets)
  }

  @Test fun customRetryMsPausesBetweenTries() {
    val field = Field(takesOn = 2)
    assertEquals("inserted", runOpts(field, InsertOpts(attempts = 3, retryMs = 50)))
    assertEquals(listOf(50L), pauses)
  }

  /** A field that keeps the set text but drops its newlines, like a contenteditable. */
  private class StrippingField(var text: String = "") : EditableField {
    var sets = 0
    override fun text() = text
    override fun set(text: String): Boolean {
      sets++
      this.text = text.filter { it != '\n' && it != '\r' }
      return true
    }
  }

  @Test fun newlineLossLandsWhenAccepted() {
    val field = StrippingField()
    assertEquals(
      "landedWithoutNewlines",
      Insert.run(field, "a\nb", "a\nb", InsertOpts(acceptNewlineLoss = true), { pauses += it }, { false }),
    )
    assertEquals(1, field.sets)
    assertEquals(emptyList<Long>(), pauses)
  }

  @Test fun newlineLossCopiesWhenNotAccepted() {
    val field = StrippingField()
    assertEquals(
      "copied",
      Insert.run(field, "a\nb", "a\nb", InsertOpts(), { pauses += it }, { copied += it; true }),
    )
    assertEquals(2, field.sets)
    assertEquals(listOf("a\nb"), copied)
  }

  @Test fun otherTextIsNotNewlineLoss() {
    val field = Field(takesOn = 0).also { it.text = "zzz" }
    assertEquals("copied", runOpts(field, InsertOpts(acceptNewlineLoss = true)))
  }

  @Test fun lostOnlyNewlinesNeedsANewline() {
    assertEquals(false, Insert.lostOnlyNewlines("ab", "ab"))
    assertEquals(true, Insert.lostOnlyNewlines("a\nb", "ab"))
    assertEquals(true, Insert.lostOnlyNewlines("a\r\nb", "ab"))
    assertEquals(false, Insert.lostOnlyNewlines("a\nb", "axb"))
  }
}
