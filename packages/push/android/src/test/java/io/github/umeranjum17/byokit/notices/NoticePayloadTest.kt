package io.github.umeranjum17.byokit.notices
import org.junit.Test
import org.junit.Assert.*

class NoticePayloadTest {
  private val envelope = """{"v":1,"sealed":"RrGICg3Kl64WGNPYwEzFGxD9CMHNiDnBu_S9f-AUAF0pKissLS4vMDEyMzQ1Njc4OTo7PD0-P0Dsgbnm6qATdCXyr-WkXnSwIToizfHg5EoTyJSRFMbE8a9SKPFIOYg5LR4-0yfdc8DtPGA-CJB7aOHq-zym7L8IdphxkgwL7NDp65f8Y6AhiShy3yE8zU2MUCkaepG4UpKQ5aG39JnwylpVJz97v35TjkK-Zf9g7uhZY4Q6a9MGpukQ_FyOuhzDBgDO7bJcHCb-KUjk6hk"}"""
  private val key = ByteArray(32) { (it + 1).toByte() }
  @Test fun sealFixtureAndFallback() {
    val opened = NoticePayload.open(envelope, key)!!
    assertEquals("Build ready ☀️", opened.title)
    assertEquals("The task finished.", opened.body)
    assertEquals("s-1", opened.data!!.getString("sessionId"))
    val fallback = NoticeContent("New update", "Open the app.", null)
    assertEquals(fallback, NoticePayload.display(envelope, ByteArray(32), fallback))
    assertEquals(fallback, NoticePayload.display(envelope, null, fallback))
    assertEquals(fallback, NoticePayload.display("broken", key, fallback))
    assertNull(NoticePayload.open(envelope.replace("\"v\":1", "\"v\":2"), key))
    assertNull(NoticePayload.open(envelope.replace("sealed\":\"", "sealed\":\"A"), key))
    assertNull(NoticePayload.open(envelope, ByteArray(31)))
  }
}
