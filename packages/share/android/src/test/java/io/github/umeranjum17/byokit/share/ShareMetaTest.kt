package io.github.umeranjum17.byokit.share

import org.junit.Assert.*
import org.junit.Test

class ShareMetaTest {
  @Test fun orientation() {
    for (rotation in listOf(0, 180)) assertEquals(ShareMeta.M(320, 240, 1500), ShareMeta.orient(320, 240, rotation, 1500))
    for (rotation in listOf(90, 270)) assertEquals(ShareMeta.M(240, 320, 1500), ShareMeta.orient(320, 240, rotation, 1500))
    assertEquals(ShareMeta.NONE, ShareMeta.orient(null, null, 90, null))
    assertEquals(ShareMeta.M(null, 320, null), ShareMeta.orient(320, null, 270, null))
  }
}
