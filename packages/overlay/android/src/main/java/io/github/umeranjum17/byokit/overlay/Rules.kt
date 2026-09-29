package io.github.umeranjum17.byokit.overlay

/**
 * Per-app visibility for the Kotlin-driven bubble (docs/capability-kits.md 7.3): the same decision as
 * `src/rules.ts` shownFor, so the app's service decides without JS. The app layers its own allowances on top.
 */
data class Rules(
  val paused: Boolean = false,
  val on: List<String> = emptyList(),
  val off: List<String> = emptyList(),
  val defaults: List<String> = emptyList(),
) {
  /** Whether the bubble shows over [app] (the foreground app's package name, null when unknown). */
  fun shows(app: String?): Boolean = !paused && app != null && app !in off && (app in on || app in defaults)
}
