package io.github.umeranjum17.byokit.overlay

import org.junit.Assert.assertEquals
import org.junit.Test

class ListenersTest {
  @Test fun twoListenersAndARemove() {
    val set = Listeners<OverlayEvent>()
    val a = mutableListOf<OverlayEvent>()
    val b = mutableListOf<OverlayEvent>()
    val removeA = set.add { a += it }
    set.add { b += it }
    set.emit(OverlayEvent.Tap)
    assertEquals(listOf<OverlayEvent>(OverlayEvent.Tap), a)
    assertEquals(listOf<OverlayEvent>(OverlayEvent.Tap), b)
    removeA()
    set.emit(OverlayEvent.LongPress)
    assertEquals(1, a.size)
    assertEquals(listOf(OverlayEvent.Tap, OverlayEvent.LongPress), b)
  }

  @Test fun aThrowingListenerDoesNotStopTheRest() {
    val set = Listeners<Int>()
    val seen = mutableListOf<Int>()
    set.add { throw IllegalStateException("boom") }
    set.add { seen += it }
    set.emit(1)
    assertEquals(listOf(1), seen)
  }

  @Test fun theSameFunctionAddedTwiceIsRemovedOncePerRemover() {
    val set = Listeners<Int>()
    var calls = 0
    val fn: (Int) -> Unit = { calls++ }
    val first = set.add(fn)
    set.add(fn)
    first()
    set.emit(1)
    assertEquals(1, calls)
  }
}
