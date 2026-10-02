package io.github.umeranjum17.byokit.share

import org.junit.Assert.*
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch

class ShareInboxTest {
  private class Bench {
    val folders = mutableSetOf<Long>()
    var wipes = 0
    val inbox = ShareInbox<String, String>({ folders.toList() }, { folders.remove(it); Unit }, { folders.clear(); wipes++ })
    fun take(value: String): Pair<Long, String> { inbox.offer(value); return inbox.take()!! }
  }
  @Test fun j1TakeOnce() {
    val b = Bench(); b.inbox.offer("A")
    assertEquals(1L to "A", b.inbox.take()); assertNull(b.inbox.take())
  }
  @Test fun j2LastWins() {
    val b = Bench(); b.inbox.offer("A"); b.inbox.offer("B")
    assertEquals(2L to "B", b.inbox.take())
  }
  @Test fun j3OutOfOrder() {
    val b = Bench(); b.take("A"); b.take("B")
    assertTrue(b.inbox.done(2, "B")); assertFalse(b.inbox.done(1, "A"))
    assertEquals(2L to "B", b.inbox.current())
  }
  @Test fun j4ClearCompares() {
    val b = Bench(); b.take("A"); b.take("B"); b.inbox.done(2, "B")
    b.inbox.clear(1); assertEquals(2L to "B", b.inbox.current())
    b.inbox.clear(2); assertNull(b.inbox.current())
  }
  @Test fun j5ClearNeverTouchesPending() {
    val b = Bench(); b.take("A"); b.inbox.done(1, "A"); b.inbox.offer("B")
    b.inbox.clear(1); b.inbox.clear(2)
    assertEquals(2L to "B", b.inbox.take())
  }
  @Test fun j6PruneKeepsInFlightAndLast() {
    val b = Bench(); b.take("A"); b.folders += 1; b.inbox.done(1, "A")
    b.take("B"); b.folders += 2; b.take("C"); b.folders += 3; b.inbox.done(2, "B")
    b.take("D"); assertEquals(setOf(2L, 3L), b.folders)
  }
  @Test fun j7WipeOnce() {
    val b = Bench(); b.folders += setOf(7L, 8L); b.take("A")
    assertTrue(b.folders.isEmpty()); b.take("B"); assertEquals(1, b.wipes)
  }
  @Test fun j8Requeue() {
    val b = Bench(); val a = b.take("A"); b.inbox.requeue(a)
    assertEquals(a, b.inbox.take()); b.inbox.offer("B"); b.inbox.requeue(a)
    assertEquals(2L to "B", b.inbox.take())
  }
  @Test fun j9ConcurrentOffer() {
    val b = Bench(); val start = CountDownLatch(1)
    val seqs = Collections.synchronizedSet(mutableSetOf<Long>())
    val threads = List(8) { Thread { start.await(); repeat(500) { seqs += b.inbox.offer("A") } }.also { it.start() } }
    start.countDown(); threads.forEach { it.join() }
    assertEquals(4000, seqs.size); assertEquals(4000L, seqs.maxOrNull())
  }
  @Test fun j10SupersededFolder() {
    val b = Bench(); b.take("A"); b.folders += 1; b.take("B"); b.folders += 2
    b.inbox.done(2, "B"); b.inbox.done(1, "A"); b.take("C")
    assertEquals(setOf(2L), b.folders)
  }
  @Test fun j11WatermarkSurvivesClear() {
    val b = Bench(); b.take("A"); b.folders += 1; b.take("B"); b.folders += 2
    assertTrue(b.inbox.done(2, "B")); b.inbox.clear(2)
    assertFalse(b.inbox.done(1, "A")); assertNull(b.inbox.current())
    assertEquals(3L to "C", b.take("C")); assertFalse(1L in b.folders)
    b.inbox.clear(0); assertTrue(b.inbox.done(3, "C")); b.inbox.clear(0)
    assertEquals(3L to "C", b.inbox.current())
    b.inbox.clear(5); assertFalse(b.inbox.done(4, "D"))
  }
}
