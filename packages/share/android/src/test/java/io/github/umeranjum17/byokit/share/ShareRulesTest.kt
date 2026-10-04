package io.github.umeranjum17.byokit.share

import org.junit.Assert.*
import org.junit.Test

class ShareRulesTest {
  @Test fun copyNamesCannotTraverse() {
    for (name in listOf("../../private", "", "..", "a".repeat(300), "☃/été", null)) {
      val out = ShareRules.copyName(3, name, "png")
      assertTrue(out.startsWith("3-")); assertTrue(out.length <= 100)
      assertTrue(out.matches(Regex("[A-Za-z0-9._-]+"))); assertFalse(out.contains('/'))
    }
  }
  @Test fun providerBoundary() {
    assertEquals("not_content", ShareRules.reject("file", "foreign", 2, 1))
    assertEquals("not_content", ShareRules.reject("http", "foreign", 2, 1))
    assertEquals("own_provider", ShareRules.reject("content", "0@x.y", 2, 1))
    assertEquals("own_provider", ShareRules.reject("content", null, 2, 1))
    assertEquals("own_provider", ShareRules.reject("content", "", 2, 1))
    assertEquals("own_provider", ShareRules.reject("content", "own", 1, 1))
    assertNull(ShareRules.reject("content", "foreign", 2, 1))
    assertNull(ShareRules.reject("content", "foreign", null, 1))
  }
  @Test fun branchingMatchesUpstream() {
    assertTrue(ShareRules.isTextBranch("text/plain; charset=utf-8"))
    assertTrue(ShareRules.isShare("android.intent.action.VIEW", "text/plain; charset=utf-8"))
    assertFalse(ShareRules.isShare("android.intent.action.VIEW", "image/png"))
    assertTrue(ShareRules.isShare("android.intent.action.SEND", "image/png"))
    assertTrue(ShareRules.isShare("android.intent.action.SEND_MULTIPLE", null))
    assertEquals("shared", ShareRules.kind(true, "", 0, 0))
    assertEquals("none", ShareRules.kind(true, null, 2, 0))
    assertEquals("unreadable", ShareRules.kind(false, null, 2, 0))
    assertEquals("shared", ShareRules.kind(false, null, 2, 1))
    assertEquals("none", ShareRules.kind(false, null, 0, 0))
  }
  @Test fun labelsAndMimeFallbacks() {
    assertEquals(255, ShareRules.label("a".repeat(300), "copy").length)
    assertEquals("copy", ShareRules.label(" ", "copy"))
    assertEquals("image/png", ShareRules.mime("image/png", "image/*", null))
    assertEquals("image/jpeg", ShareRules.mime(null, "image/jpeg", "image/png"))
    assertEquals("image/png", ShareRules.mime(null, "image/*", "image/png"))
    assertEquals("application/octet-stream", ShareRules.mime(null, null, null))
  }
}
