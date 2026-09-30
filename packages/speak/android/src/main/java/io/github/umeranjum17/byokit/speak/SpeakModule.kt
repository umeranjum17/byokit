package io.github.umeranjum17.byokit.speak

import android.content.Context
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Locale

/**
 * Expo module 'ByokitSpeak': the NativeSpeak seam over Android's own TextToSpeech. No network, no keys.
 * Each speak carries a numeric id; progress for that id goes out as a 'speak' event.
 */
class SpeakModule : Module() {
  private var tts: TextToSpeech? = null
  private var ready = false
  private val waiting = mutableListOf<() -> Unit>()

  private val context: Context get() = appContext.reactContext?.applicationContext ?: throw IllegalStateException("speak: no context")

  private fun engine(run: (TextToSpeech) -> Unit) {
    tts?.let { if (ready) { run(it); return } else { waiting += { run(it) }; return } }
    val fresh = TextToSpeech(context) { status ->
      ready = status == TextToSpeech.SUCCESS
      val pending = waiting.toList()
      waiting.clear()
      if (ready) pending.forEach { it() }
    }
    fresh.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(id: String) { sendEvent("speak", mapOf("id" to id.toInt(), "type" to "start")) }
      override fun onDone(id: String) { sendEvent("speak", mapOf("id" to id.toInt(), "type" to "end")) }
      @Deprecated("Deprecated in Java")
      override fun onError(id: String) { sendEvent("speak", mapOf("id" to id.toInt(), "type" to "error")) }
      override fun onError(id: String, code: Int) { sendEvent("speak", mapOf("id" to id.toInt(), "type" to "error")) }
    })
    tts = fresh
    waiting += { run(fresh) }
  }

  override fun definition() = ModuleDefinition {
    Name("ByokitSpeak")
    Events("speak")

    Function("speak") { id: Int, text: String, voice: String?, rate: Double, pitch: Double ->
      engine { tts ->
        if (voice != null) {
          tts.voices.firstOrNull { it.name == voice }?.let { tts.voice = it }
        }
        tts.setSpeechRate(rate.toFloat().coerceIn(0.25f, 4f))
        tts.setPitch(pitch.toFloat().coerceIn(0f, 2f))
        val params = Bundle()
        tts.speak(text, TextToSpeech.QUEUE_ADD, params, id.toString())
      }
    }

    Function("cancel") { id: Int ->
      // Android stops the whole queue; the JS side settles only the cancelled handle.
      tts?.stop()
      Unit
    }

    Function("stopAll") {
      tts?.stop()
      Unit
    }

    AsyncFunction("voices") {
      val t = tts
      (t?.voices ?: emptyList()).map { mapOf("id" to it.name, "name" to it.name, "lang" to (it.locale ?: Locale.getDefault()).toLanguageTag()) }
    }

    OnDestroy { tts?.shutdown(); tts = null }
  }
}
