package io.github.umeranjum17.byokit.overlay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SpotStoreTest {
  private class MapStore : SpotStore {
    val spots = mutableMapOf<String, Spot>()
    override fun get(key: String) = spots[key]
    override fun put(key: String, spot: Spot) { spots[key] = spot }
  }

  @Test fun globalVersusPerAppKeys() {
    assertEquals("global", SpotStore.key(perApp = false, app = "com.a"))
    assertEquals("global", SpotStore.key(perApp = false, app = null))
    assertEquals("app:com.a", SpotStore.key(perApp = true, app = "com.a"))
    assertEquals("global", SpotStore.key(perApp = true, app = null))

    val store = MapStore()
    store.put(SpotStore.key(true, "com.a"), Spot(Edge.LEFT, 0.25f))
    store.put(SpotStore.key(false, "com.a"), Spot(Edge.RIGHT, 0.75f))
    assertEquals(Spot(Edge.LEFT, 0.25f), store.get(SpotStore.key(true, "com.a")))
    assertEquals(Spot(Edge.RIGHT, 0.75f), store.get(SpotStore.key(false, "com.b")))
    assertNull(store.get(SpotStore.key(true, "com.b")))
  }
}
