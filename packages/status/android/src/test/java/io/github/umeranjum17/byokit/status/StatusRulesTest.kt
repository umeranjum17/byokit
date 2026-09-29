package io.github.umeranjum17.byokit.status

import io.github.umeranjum17.byokit.status.StatusRules.Decision
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StatusRulesTest {
  private val post = Post("Scribe is working", "2 need you", "2 busy", "2 working", true,
    listOf("needs" to "See what needs you", "ask" to "Ask Chief"), 900_000, "ic_crew")
  private val sig = StatusRules.signature(post)
  private val LOW = 2
  private val MIN = 1

  @Test fun eligibility() {
    assertTrue(StatusRules.promotable(post, LOW))
    assertFalse("not asked", StatusRules.promotable(post.copy(promote = false), LOW))
    assertFalse("no title", StatusRules.promotable(post.copy(title = " "), LOW))
    assertFalse("chip too long", StatusRules.promotable(post.copy(chip = "8 chars!"), LOW))
    assertFalse("MIN channel", StatusRules.promotable(post, MIN))
    assertFalse("blocked channel", StatusRules.promotable(post, 0))
    assertTrue(StatusRules.channelPromotable(LOW))
    assertFalse(StatusRules.channelPromotable(MIN))
  }

  @Test fun chipIsSevenCodePointsAtMost() {
    assertTrue(StatusRules.chipFits(""))
    assertTrue(StatusRules.chipFits("1234567"))
    assertFalse(StatusRules.chipFits("12345678"))
    // Seven emoji are 14 UTF-16 units but seven characters.
    assertTrue(StatusRules.chipFits("😀".repeat(7)))
    assertFalse(StatusRules.chipFits("😀".repeat(8)))
  }

  @Test fun check() {
    assertNull(StatusRules.check(post))
    assertNull(StatusRules.check(post.copy(icon = null, actions = emptyList(), chip = "")))
    val bad = listOf(
      post.copy(title = "") to "title",
      post.copy(chip = "12345678") to "chip",
      post.copy(timeoutMs = 999) to "timeoutMs",
      post.copy(icon = "Bad-Icon") to "icon",
      post.copy(actions = List(4) { "a$it" to "A" }) to "at most 3",
      post.copy(actions = listOf("Open" to "Open")) to "action id",
      post.copy(actions = listOf("open" to " ")) to "label",
      post.copy(actions = listOf("open" to "Open", "open" to "Again")) to "unique",
    )
    for ((p, why) in bad) assertTrue(why, StatusRules.check(p)!!.contains(why))
  }

  @Test fun signatureIsTheVisibleContentNotTheTimeout() {
    assertEquals(sig, StatusRules.signature(post.copy(timeoutMs = 60_000)))
    for (other in listOf(post.copy(title = "x"), post.copy(text = "x"), post.copy(chip = "Needs"), post.copy(publicText = "x"),
      post.copy(promote = false), post.copy(icon = null), post.copy(actions = post.actions.take(1)),
      post.copy(actions = listOf("needs" to "x", "ask" to "Ask Chief")))) {
      assertNotEquals(other.toString(), sig, StatusRules.signature(other))
    }
    // Fields cannot bleed into each other.
    assertNotEquals(StatusRules.signature(post.copy(title = "a", text = "b")), StatusRules.signature(post.copy(title = "ab", text = "")))
  }

  @Test fun firstPostShows() {
    assertEquals(Decision.Show, StatusRules.decide(sig, 0, null, false))
  }

  @Test fun unchangedIsDroppedUntilHalfTheTimeoutThenRearms() {
    val last = Last(sig, 10_000, 900_000)
    assertEquals(Decision.Drop, StatusRules.decide(sig, 10_500, last, false))
    assertEquals(Decision.Drop, StatusRules.decide(sig, 10_000 + 449_999, last, false))
    assertEquals(Decision.Show, StatusRules.decide(sig, 10_000 + 450_000, last, false))
  }

  @Test fun changesAreThrottledToOnePerOneAndAHalfSeconds() {
    val last = Last(sig, 10_000, 900_000)
    assertEquals(Decision.Later(1500), StatusRules.decide("other", 10_000, last, false))
    assertEquals(Decision.Later(1), StatusRules.decide("other", 11_499, last, false))
    assertEquals(Decision.Show, StatusRules.decide("other", 11_500, last, false))
  }

  @Test fun aDismissalDropsEveryPost() {
    val last = Last(sig, 10_000, 900_000)
    assertEquals(Decision.Drop, StatusRules.decide("other", 20_000, last, true))
    assertEquals(Decision.Drop, StatusRules.decide(sig, 10_000_000, last, true))
    assertEquals(Decision.Drop, StatusRules.decide(sig, 0, null, true))
  }

  @Test fun timeoutIsNotADismissal() {
    val last = Last(sig, 10_000, 60_000)
    assertTrue("a swipe", StatusRules.userDismissed(20_000, last))
    assertTrue("a swipe just before the slack", StatusRules.userDismissed(68_999, last))
    assertFalse("the timeout", StatusRules.userDismissed(69_000, last))
    assertFalse("the timeout, late", StatusRules.userDismissed(80_000, last))
    assertTrue("nothing posted", StatusRules.userDismissed(0, null))
  }
}
