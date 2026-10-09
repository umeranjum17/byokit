package io.github.umeranjum17.byokit.overlay

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Test

class TapLogTest {
  private val day = 24L * 60 * 60 * 1000
  private fun log() = TapLog(File(Files.createTempDirectory("taplog").toFile(), "taps"))

  @Test fun prunesAtThirtyDays() {
    val log = log()
    val now = 100 * day
    log.add("com.old", "tap", now - 31 * day)
    log.add("com.edge", "tap", now - 30 * day)
    log.add("com.recent", "tap", now - 29 * day)
    log.prune(now)
    assertEquals(listOf("com.recent"), log.since(0).map { it.app })
  }

  @Test fun addPrunesAndSinceFilters() {
    val log = log()
    log.add("com.a", "open", 0)
    log.add("com.b", "tap", 31 * day)
    assertEquals(listOf(TapEntry("com.b", 31 * day, "tap")), log.since(0))
    log.add("com.c", "tap", 32 * day)
    assertEquals(listOf("com.c"), log.since(32 * day).map { it.app })
    log.clear()
    assertEquals(emptyList<TapEntry>(), log.since(0))
  }

  @Test fun entryHasNoTextField() {
    val fields = TapEntry::class.java.declaredFields.filterNot { java.lang.reflect.Modifier.isStatic(it.modifiers) }
    assertEquals(setOf("app", "at", "action"), fields.map { it.name }.toSet())
  }
}
