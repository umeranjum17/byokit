package io.github.umeranjum17.byokit.share

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Process
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.MimeTypeMap
import java.io.File
import java.io.IOException

class ShareReader(private val context: Context) {
  private class TooLarge : IOException()
  fun read(intent: Intent, dir: File): Map<String, Any?> {
    check(dir.mkdirs() || dir.isDirectory)
    if (ShareRules.isTextBranch(intent.type)) {
      val view = intent.action == Intent.ACTION_VIEW
      val text = if (view) intent.dataString else intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
      val title = if (view) null else intent.getCharSequenceExtra(Intent.EXTRA_TITLE)?.toString()
      return mapOf("kind" to ShareRules.kind(true, text, 0, 0), "text" to text, "title" to title,
        "files" to emptyList<Any>(), "skipReasons" to emptyList<String>())
    }
    val streams = streams(intent)
    val files = mutableListOf<Map<String, Any?>>()
    val reasons = mutableListOf<String>()
    for ((index, uri) in streams.withIndex()) {
      var out: File? = null
      try {
        val authority = uri.authority
        // Refuse user-id authorities before asking PackageManager to resolve them.
        var reason = ShareRules.reject(uri.scheme, authority, null, Process.myUid())
        if (reason == null) {
          val uid = authority?.let { context.packageManager.resolveContentProvider(it, 0)?.applicationInfo?.uid }
          reason = ShareRules.reject(uri.scheme, authority, uid, Process.myUid())
        }
        if (reason != null) { reasons += reason; continue }
        val resolver = context.contentResolver
        val displayName = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
          val column = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (column >= 0 && c.moveToFirst() && !c.isNull(column)) c.getString(column) else null
        }
        val ext = displayName?.substringAfterLast('.', "")?.lowercase()?.takeIf { it.isNotEmpty() }
        val mime = ShareRules.mime(resolver.getType(uri), intent.type,
          ext?.let { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) })
        val target = File(dir, ShareRules.copyName(index, displayName, ext))
        out = target
        check(target.canonicalFile.parentFile == dir.canonicalFile)
        resolver.openInputStream(uri)?.use { input ->
          target.outputStream().use { output ->
            val buffer = ByteArray(64 * 1024)
            var size = 0L
            while (true) {
              val n = input.read(buffer)
              if (n < 0) break
              size += n
              if (size > ShareRules.MAX_BYTES) throw TooLarge()
              output.write(buffer, 0, n)
            }
          }
        } ?: throw IOException()
        val meta = try { ShareMeta.of(target, mime) } catch (_: Exception) { ShareMeta.NONE }
        files += mapOf("contentUri" to uri.toString(), "filePath" to target.path,
          "fileName" to ShareRules.label(displayName, target.name), "fileSize" to target.length().toString(),
          "mimeType" to mime, "width" to meta.width?.toString(), "height" to meta.height?.toString(),
          "duration" to meta.durationMs?.toString())
      } catch (e: Exception) {
        out?.delete()
        reasons += if (e is TooLarge) "too_large" else "unreadable"
      }
    }
    if (reasons.isNotEmpty()) Log.w("ByokitShare", "skipped ${reasons.size}")
    return mapOf("kind" to ShareRules.kind(false, null, streams.size, files.size), "text" to null,
      "title" to null, "files" to files, "skipReasons" to reasons)
  }

  @Suppress("DEPRECATION")
  private fun streams(intent: Intent): List<Uri> = when (intent.action) {
    Intent.ACTION_SEND_MULTIPLE -> if (Build.VERSION.SDK_INT >= 33)
      intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
      else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
    Intent.ACTION_SEND -> listOfNotNull(if (Build.VERSION.SDK_INT >= 33)
      intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
      else intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
    else -> emptyList()
  }
}
