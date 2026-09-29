package io.github.umeranjum17.byokit.overlay

import org.junit.Assert.assertEquals
import org.junit.Test

class RulesTest {
  private val rules = Rules(on = listOf("com.on"), off = listOf("com.off"), defaults = listOf("com.app"))

  @Test fun onAndDefaultsShow() {
    assertEquals(true, rules.shows("com.on"))
    assertEquals(true, rules.shows("com.app"))
  }

  @Test fun offHidesEvenWhenAlsoOn() {
    assertEquals(false, Rules(on = listOf("com.a"), off = listOf("com.a")).shows("com.a"))
    assertEquals(false, rules.shows("com.off"))
  }

  @Test fun unknownAppsStayHidden() {
    assertEquals(false, rules.shows("com.other"))
  }

  @Test fun pausedOrUnknownAppHides() {
    assertEquals(false, rules.copy(paused = true).shows("com.on"))
    assertEquals(false, rules.shows(null))
  }
}
