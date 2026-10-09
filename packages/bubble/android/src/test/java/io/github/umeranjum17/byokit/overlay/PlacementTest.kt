package io.github.umeranjum17.byokit.overlay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlacementTest {
  private val screen = Size(1000, 2000)
  private val bubble = Size(100, 100)
  private val top = 100 // status bar

  @Test fun snapsToTheNearestEdge() {
    assertEquals(Edge.LEFT, Placement.snap(300, 500, screen, bubble, top, null).edge)
    assertEquals(Edge.RIGHT, Placement.snap(600, 500, screen, bubble, top, null).edge)
    // The bubble's centre decides: its left side is left of the middle, its centre is not.
    assertEquals(Edge.RIGHT, Placement.snap(460, 500, screen, bubble, top, null).edge)
    // y 0.2 of the 100..1900 band.
    assertEquals(0 to 460, Placement.toPixels(Spot(Edge.LEFT, 0.2f), screen, bubble, top, null))
    assertEquals(900 to 460, Placement.toPixels(Spot(Edge.RIGHT, 0.2f), screen, bubble, top, null))
  }

  @Test fun clampsInsideTheInsets() {
    // Usable band for the bubble's top: 100 (below the status bar) to 1900 (its bottom on the screen's).
    assertEquals(0f, Placement.snap(0, -50, screen, bubble, top, null).y)
    assertEquals(0f, Placement.snap(0, 40, screen, bubble, top, null).y)
    assertEquals(1f, Placement.snap(0, 5000, screen, bubble, top, null).y)
    assertEquals(0.5f, Placement.snap(0, 1000, screen, bubble, top, null).y)
    assertEquals(0 to 100, Placement.toPixels(Spot(Edge.LEFT, -1f), screen, bubble, top, null))
    assertEquals(0 to 1900, Placement.toPixels(Spot(Edge.LEFT, 2f), screen, bubble, top, null))
    // A spot survives the round trip.
    val spot = Placement.snap(900, 1000, screen, bubble, top, null)
    assertEquals(900 to 1000, Placement.toPixels(spot, screen, bubble, top, null))
  }

  @Test fun restsAboveTheKeyboard() {
    val ime = 1200 // the keyboard's top edge
    assertEquals(900 to 1100, Placement.toPixels(Spot(Edge.RIGHT, 1f), screen, bubble, top, ime))
    // A spot above the keyboard is left where it is.
    assertEquals(900 to 280, Placement.toPixels(Spot(Edge.RIGHT, 0.1f), screen, bubble, top, ime))
    // Dropped under the keyboard, it snaps to just above it.
    val spot = Placement.snap(900, 1600, screen, bubble, top, ime)
    assertEquals(900 to 1100, Placement.toPixels(spot, screen, bubble, top, ime))
    // The keyboard closing gives the lower rest back (the spot is kept relative to the full height).
    assertEquals(900 to 1900, Placement.toPixels(Spot(Edge.RIGHT, 1f), screen, bubble, top, null))
  }

  @Test fun dragSlopThreshold() {
    val density = 2f // 8 dp = 16 px
    assertFalse(Placement.isDrag(0f, 0f, density))
    assertFalse(Placement.isDrag(16f, 0f, density))
    assertFalse(Placement.isDrag(9f, 13f, density)) // hypot ≈ 15.8
    assertTrue(Placement.isDrag(16.1f, 0f, density))
    assertTrue(Placement.isDrag(-12f, -12f, density)) // hypot ≈ 17
    assertEquals(8, Placement.DRAG_SLOP_DP)
  }
}
