package io.github.umeranjum17.byokit.overlay

import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.ImageView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class BubbleTest {
  @Test fun accessibilityClickAndTouchTapEachEmitExactlyOneTap() {
    val context = RuntimeEnvironment.getApplication()
    val bubble = Bubble(WindowOverlayHost(context), PrefsSpotStore(context), { null }, { true })
    val seen = mutableListOf<OverlayEvent>()
    bubble.events.add(seen::add)
    bubble.show("calm")
    try {
      val image = Bubble::class.java.getDeclaredField("image").apply { isAccessible = true }.get(bubble) as ImageView
      assertTrue(image.performAccessibilityAction(AccessibilityNodeInfo.ACTION_CLICK, null))
      assertEquals(listOf(OverlayEvent.Tap), seen)
      for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
        val event = MotionEvent.obtain(0, 10, action, 10f, 10f, 0)
        try { assertTrue(image.dispatchTouchEvent(event)) } finally { event.recycle() }
      }
      assertEquals(listOf(OverlayEvent.Tap, OverlayEvent.Tap), seen)
    } finally { bubble.hide() }
  }
}
