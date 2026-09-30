package io.github.umeranjum17.byokit.overlay

import android.content.Context
import android.os.Build
import android.util.DisplayMetrics
import android.view.WindowManager
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** The image and marker share full default-display physical pixels, never dp or app-window bounds. */
class ScreenSpaceRecord : Record {
  @Field val width: Int = 0
  @Field val height: Int = 0
  @Field val density: Double = 0.0
  @Field val densityDpi: Int = 0
  @Field val rotation: Int = 0
  @Field val displayId: Int = 0
  @Field val origin: String = "top-left"
  @Field val unit: String = "physical-pixels"
}

internal data class ScreenSpace(
  val width: Int, val height: Int, val density: Float, val densityDpi: Int, val rotation: Int, val displayId: Int,
) {
  fun toMap(): Map<String, Any> = mapOf(
    "width" to width, "height" to height, "density" to density.toDouble(), "densityDpi" to densityDpi,
    "rotation" to rotation, "displayId" to displayId, "origin" to "top-left", "unit" to "physical-pixels",
  )
  fun matches(o: ScreenSpaceRecord): Boolean = width == o.width && height == o.height &&
    kotlin.math.abs(density - o.density) < 0.001 && densityDpi == o.densityDpi && rotation == o.rotation &&
    displayId == o.displayId && o.origin == "top-left" && o.unit == "physical-pixels"

  companion object {
    @Suppress("DEPRECATION")
    fun current(context: Context): ScreenSpace {
      val windows = context.getSystemService(WindowManager::class.java)
      val display = windows.defaultDisplay
      val m = DisplayMetrics().also { display.getRealMetrics(it) }
      val bounds = if (Build.VERSION.SDK_INT >= 30) windows.maximumWindowMetrics.bounds else null
      return ScreenSpace(bounds?.width() ?: m.widthPixels, bounds?.height() ?: m.heightPixels,
        m.density, m.densityDpi, display.rotation, display.displayId)
    }
  }
}
