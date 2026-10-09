package io.github.umeranjum17.byokit.overlay

import org.junit.Assert.*
import org.junit.Test

class FrameRequestTest {
  @Test fun oneShotBusyAndLateCallbacks() {
    val requests = FrameRequest()
    val seen = mutableListOf<Map<String, Any>>()
    val id = requests.begin { seen += it }!!
    assertNull(requests.begin { fail("second request accepted") })
    requests.end(id, mapOf("status" to "cancelled"))
    val next = requests.begin { seen += it }!!
    requests.end(id, mapOf("status" to "captured"))
    assertTrue(requests.active(next))
    requests.end(next, ScreenFrames.failed("timeout"))
    requests.end(next, mapOf("status" to "cancelled"))
    assertEquals(listOf(mapOf("status" to "cancelled"), ScreenFrames.failed("timeout")), seen)
    assertFalse(requests.busy())
  }
  @Test fun clearsBeforeCallbackSoItCanReenter() {
    val requests = FrameRequest()
    var next: String? = null
    val id = requests.begin { next = requests.begin {} }!!
    requests.end(id, mapOf("status" to "cancelled"))
    assertNotNull(next)
    assertTrue(requests.active(next!!))
  }
  @Test fun coordinateSpaceIncludesBarsAndDetectsRotationResizeDensityAndDisplayChanges() {
    val s = ScreenSpace(1080, 2400, 3f, 480, 0, 0)
    assertEquals("physical-pixels", s.toMap()["unit"])
    assertEquals(2400, s.toMap()["height"])
    assertNotEquals(s, s.copy(rotation = 1))
    assertNotEquals(s, s.copy(width = 2400, height = 1080))
    assertNotEquals(s, s.copy(density = 2f))
    assertNotEquals(s, s.copy(displayId = 1))
  }
}
