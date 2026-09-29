package io.github.umeranjum17.byokit.overlay

/** What drives the bubble's view: the Bubble itself, or a fake in the JVM tests (docs/capability-kits.md 7.5). */
interface BubbleControl {
  var spotKey: String
  /** The keyboard's top in screen pixels while it is open; the bubble rests above it and returns when it closes. */
  var imeTopPx: Int?
  val events: Listeners<OverlayEvent>
  fun show(mood: String)
  fun hide()
  fun say(text: String, mood: String?, ms: Long, announce: Boolean = false)
  fun setMood(mood: String)
  /** The TalkBack label; null clears it back to no label. */
  fun setLabel(label: String?)
}
