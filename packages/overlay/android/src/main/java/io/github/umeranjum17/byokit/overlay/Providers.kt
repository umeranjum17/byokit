package io.github.umeranjum17.byokit.overlay

/** The app in the foreground, from the app's own accessibility service (BK-O3 supplies it). */
interface ForegroundApp {
  val current: String?
  fun onChange(fn: (String?) -> Unit): () -> Unit
}

/** The keyboard's top edge in screen pixels while it is open (BK-O3 supplies it). */
interface KeyboardInset {
  val imeTopPx: Int?
  fun onChange(fn: (Int?) -> Unit): () -> Unit
}
