package io.github.umeranjum17.byokit.example

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.ParcelFileDescriptor
import com.facebook.react.ReactApplication
import com.facebook.react.modules.core.DeviceEventManagerModule
import kotlin.concurrent.thread

// Installed only by the explicit M6 build flag. USB shell may write a bounded pipe, never read a credential.
class ImportProvider : ContentProvider() {
  override fun onCreate() = true
  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    check(Binder.getCallingUid() == 2000 && mode == "w" && uri.path == "/key") { "USB shell write only" }
    val react = (context!!.applicationContext as ReactApplication).reactHost?.currentReactContext ?: error("Lab app is not ready")
    val pipe = ParcelFileDescriptor.createPipe()
    thread {
      ParcelFileDescriptor.AutoCloseInputStream(pipe[0]).use { input ->
        val bytes = ByteArray(8193)
        var size = 0
        while (size < bytes.size) { val n = input.read(bytes, size, bytes.size - size); if (n < 0) break; size += n }
        if (size in 0..8192) react.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit("byokitM6Key", String(bytes, 0, size, Charsets.UTF_8).trim())
        bytes.fill(0)
      }
    }
    return pipe[1]
  }
  override fun getType(uri: Uri): String? = null
  override fun query(uri: Uri, p: Array<out String>?, s: String?, a: Array<out String>?, o: String?): Cursor? = throw SecurityException("No reads")
  override fun insert(uri: Uri, v: ContentValues?): Uri? = throw SecurityException("Pipe writes only")
  override fun delete(uri: Uri, s: String?, a: Array<out String>?) = throw SecurityException("Pipe writes only")
  override fun update(uri: Uri, v: ContentValues?, s: String?, a: Array<out String>?) = throw SecurityException("Pipe writes only")
}
