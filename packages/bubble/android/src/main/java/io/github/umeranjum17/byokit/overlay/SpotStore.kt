package io.github.umeranjum17.byokit.overlay

import android.content.Context

/** The remembered rest spot, keyed by [SpotStore.key]. */
interface SpotStore {
  /** The spot stored under [key], or null. */
  fun get(key: String): Spot?
  /** Stores [spot] under [key]. */
  fun put(key: String, spot: Spot)

  companion object {
    /** The key of the one spot shared by every app. */
    const val GLOBAL = "global"

    /** One spot for every app, or one per foreground app (`spots: 'per-app'`); an unknown app uses the global one. */
    fun key(perApp: Boolean, app: String?): String = if (perApp && app != null) "app:$app" else GLOBAL
  }
}

/** Spots kept in the app's own shared preferences. */
class PrefsSpotStore(context: Context) : SpotStore {
  private val prefs = context.getSharedPreferences("byokit.overlay.spots", Context.MODE_PRIVATE)

  override fun get(key: String): Spot? {
    val (edge, y) = prefs.getString(key, null)?.split(',')?.takeIf { it.size == 2 } ?: return null
    return Spot(Edge.entries.firstOrNull { it.name == edge } ?: return null, y.toFloatOrNull() ?: return null)
  }

  override fun put(key: String, spot: Spot) {
    prefs.edit().putString(key, "${spot.edge.name},${spot.y}").apply()
  }
}
