package io.github.umeranjum17.byokit.share

import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import java.io.File

object ShareMeta {
  data class M(val width: Int?, val height: Int?, val durationMs: Long?)
  val NONE = M(null, null, null)
  fun orient(w: Int?, h: Int?, rot: Int, d: Long?) = if (rot == 90 || rot == 270) M(h, w, d) else M(w, h, d)
  fun of(f: File, mime: String): M = when {
    mime.startsWith("image/") -> BitmapFactory.Options().apply { inJustDecodeBounds = true }
      .also { BitmapFactory.decodeFile(f.path, it) }
      .let { if (it.outWidth > 0 && it.outHeight > 0) M(it.outWidth, it.outHeight, null) else NONE }
    mime.startsWith("video/") -> {
      val r = MediaMetadataRetriever()
      try {
        r.setDataSource(f.path)
        orient(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull(),
          r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull(),
          r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0,
          r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull())
      } finally { try { r.release() } catch (_: Exception) {} }
    }
    else -> NONE
  }
}
