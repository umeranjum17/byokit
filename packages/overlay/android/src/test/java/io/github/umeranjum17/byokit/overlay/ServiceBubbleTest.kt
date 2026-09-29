package io.github.umeranjum17.byokit.overlay

import android.view.View
import org.junit.Assert.assertEquals
import org.junit.Test

class ServiceBubbleTest {
  private class FakeBubble : BubbleControl {
    val shown = mutableListOf<String>()
    var hides = 0
    val said = mutableListOf<String>()
    var lastAnnounce = false
    val moods = mutableListOf<String>()
    val labels = mutableListOf<String?>()
    override var spotKey = SpotStore.GLOBAL
    override var imeTopPx: Int? = null
    override val events = Listeners<OverlayEvent>()
    override fun show(mood: String) { shown += mood }
    override fun hide() { hides++ }
    override fun say(text: String, mood: String?, ms: Long, announce: Boolean) {
      said += text
      lastAnnounce = announce
    }
    override fun setMood(mood: String) { moods += mood }
    override fun setLabel(label: String?) { labels += label }
  }

  private class FakeHost : OverlayHost {
    override fun add(view: View, x: Int, y: Int) {}
    override fun move(x: Int, y: Int) {}
    override fun remove() {}
    override val attached = true
  }

  private class FakeSpots : SpotStore {
    val map = mutableMapOf<String, Spot>()
    override fun get(key: String) = map[key]
    override fun put(key: String, spot: Spot) { map[key] = spot }
  }

  private class FakeForeground(var now: String?) : ForegroundApp {
    private val listeners = Listeners<String?>()
    override val current: String? get() = now
    override fun onChange(fn: (String?) -> Unit): () -> Unit = listeners.add(fn)
    fun emit(app: String?) = listeners.emit(app)
  }

  private class FakeKeyboard(var top: Int?) : KeyboardInset {
    private val listeners = Listeners<Int?>()
    override val imeTopPx: Int? get() = top
    override fun onChange(fn: (Int?) -> Unit): () -> Unit = listeners.add(fn)
  }

  private val host = FakeHost()
  private val hosts = Listeners<OverlayHost?>()
  private var attached: OverlayHost? = null
  private val foreground = FakeForeground("com.app")
  private val keyboard = FakeKeyboard(null)
  private val made = mutableListOf<FakeBubble>()
  private val topRules = Rules(defaults = listOf("com.app"))

  private fun service() = ServiceBubble(
    moods = { null },
    spots = FakeSpots(),
    bubbles = { FakeBubble().also { made += it } },
    hosts = hosts,
    hostNow = { attached },
    foregroundNow = { foreground },
    keyboardNow = { keyboard },
  )

  @Test fun showsOnAttachWithMoodAndLabel() {
    val s = service()
    s.start(ServiceBubble.Config(mood = "calm", label = "Voice", rules = topRules))
    assertEquals(emptyList<FakeBubble>(), made)
    hosts.emit(host)
    assertEquals(listOf("calm"), made.single().shown)
    assertEquals(listOf("Voice"), made.single().labels)
    assertEquals(SpotStore.GLOBAL, made.single().spotKey)
  }

  @Test fun showsAtOnceWhenAlreadyAttached() {
    attached = host
    val s = service()
    s.start(ServiceBubble.Config(mood = "calm", rules = topRules))
    assertEquals(listOf("calm"), made.single().shown)
    assertEquals(null, made.single().imeTopPx)
  }

  @Test fun rulesHideOverOtherAppsUntilSetRules() {
    attached = host
    val s = service()
    s.start(ServiceBubble.Config(mood = "calm", rules = Rules(defaults = listOf("com.other"))))
    val b = made.single()
    assertEquals(emptyList<String>(), b.shown)
    assertEquals(1, b.hides)
    s.setRules(Rules(defaults = listOf("com.app")))
    assertEquals(listOf("calm"), b.shown)
  }

  @Test fun detachHidesAndReattachRestores() {
    attached = host
    val s = service()
    s.start(ServiceBubble.Config(mood = "calm", label = "Voice", rules = topRules))
    s.setMood("happy")
    hosts.emit(null)
    assertEquals(1, made.single().hides)
    hosts.emit(host)
    assertEquals(2, made.size)
    assertEquals(listOf("happy"), made.last().shown)
    assertEquals(listOf("Voice"), made.last().labels)
  }

  @Test fun perAppSpotsFollowTheForegroundApp() {
    attached = host
    val s = service()
    s.start(ServiceBubble.Config(mood = "calm", rules = Rules(on = listOf("com.a", "com.b")), perAppSpots = true))
    foreground.now = "com.a"
    foreground.emit("com.a")
    assertEquals("app:com.a", made.single().spotKey)
    foreground.now = "com.b"
    foreground.emit("com.b")
    assertEquals("app:com.b", made.single().spotKey)
  }

  @Test fun saySettersAndEventsReachTheBubble() {
    attached = host
    val s = service()
    s.start(ServiceBubble.Config(mood = "calm", rules = topRules))
    val b = made.single()
    s.say("Hi", announce = true)
    assertEquals(listOf("Hi"), b.said)
    assertEquals(true, b.lastAnnounce)
    s.setMood("happy")
    s.setLabel("Voice")
    assertEquals(listOf("happy"), b.moods)
    assertEquals(listOf(null, "Voice"), b.labels)
    val seen = mutableListOf<OverlayEvent>()
    s.events.add(seen::add)
    b.events.emit(OverlayEvent.Tap)
    assertEquals(listOf(OverlayEvent.Tap), seen)
  }

  @Test fun stopHidesAndIgnoresLaterAttaches() {
    attached = host
    val s = service()
    s.start(ServiceBubble.Config(mood = "calm", rules = topRules))
    s.stop()
    assertEquals(1, made.single().hides)
    hosts.emit(host)
    assertEquals(1, made.size)
  }
}
