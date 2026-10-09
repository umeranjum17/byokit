package io.github.umeranjum17.byokit.overlay

import android.content.Context
import org.json.JSONObject

internal object Words {
  fun get(context: Context, key: String): String = context.assets.open("byokit-overlay-words.json").bufferedReader().use {
    JSONObject(it.readText()).getString(key)
  }
}
