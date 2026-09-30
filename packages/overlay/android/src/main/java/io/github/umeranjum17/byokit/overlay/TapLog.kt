package io.github.umeranjum17.byokit.overlay

import android.content.Context
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.io.File
import java.io.FileOutputStream

/** One tap: which app, when, and the app's action name. No text field, by design (docs/capability-kits.md D-O). */
data class TapEntry(val app: String, val at: Long, val action: String)

/** The tap log in the app's files dir. Entries older than 30 days are pruned on every add. */
class TapLog internal constructor(private val file: File) {
  /** The log in [context]'s files dir. */
  constructor(context: Context) : this(File(context.filesDir, "byokit-overlay-taps"))

  /** Records a tap on [app] with the app's [action] name at [at] (epoch ms). */
  @Synchronized
  fun add(app: String, action: String, at: Long) {
    prune(at)
    DataOutputStream(FileOutputStream(file, true).buffered()).use { write(it, TapEntry(app, at, action)) }
  }

  /** The taps at or after [at] (epoch ms), oldest first. */
  @Synchronized
  fun since(at: Long): List<TapEntry> = read().filter { it.at >= at }

  /** Forgets every tap. */
  @Synchronized
  fun clear() { file.delete() }

  /** Drops the taps older than [KEEP_MS] before [now]. */
  @Synchronized
  fun prune(now: Long) {
    val all = read()
    val kept = all.filter { it.at > now - KEEP_MS }
    if (kept.size == all.size) return
    DataOutputStream(FileOutputStream(file).buffered()).use { out -> kept.forEach { write(out, it) } }
  }

  private fun write(out: DataOutputStream, e: TapEntry) {
    out.writeLong(e.at); out.writeUTF(e.app); out.writeUTF(e.action)
  }

  private fun read(): List<TapEntry> {
    if (!file.exists()) return emptyList()
    val entries = mutableListOf<TapEntry>()
    DataInputStream(file.inputStream().buffered()).use { input ->
      // A torn last record (the process died mid-write) ends the log rather than failing it.
      try { while (true) entries.add(TapEntry(at = input.readLong(), app = input.readUTF(), action = input.readUTF())) }
      catch (_: EOFException) {}
    }
    return entries
  }

  companion object {
    /** How long a tap is kept: 30 days. */
    const val KEEP_MS = 30L * 24 * 60 * 60 * 1000
  }
}
