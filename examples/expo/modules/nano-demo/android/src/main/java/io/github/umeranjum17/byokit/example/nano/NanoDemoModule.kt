package io.github.umeranjum17.byokit.example.nano

import android.os.SystemClock
import android.util.Log
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.common.StreamingCallback
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.GenerativeModel
import com.google.mlkit.genai.prompt.SystemInstruction
import com.google.mlkit.genai.prompt.TextPart
import com.google.mlkit.genai.prompt.generateContentRequest
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext

class NanoRequestRecord : Record {
  @Field val text: String = ""
  @Field val systemInstruction: String? = null
  @Field val temperature: Double? = null
  @Field val topK: Int? = null
  @Field val seed: Int? = null
  @Field val maxOutputTokens: Int? = null
}

// Lab-only ML Kit GenAI Prompt module ('ByokitNanoDemo') shaped as @byokit/infer's NanoBinding (docs/infer-kit.md I9),
// so the lab app asks AICore itself whether Gemini Nano is available and times it. Each generation streams internally
// to stamp the first text; `lastTiming()` returns those stamps. Never logs prompt or answer text.
class NanoDemoModule : Module() {
  private var client: GenerativeModel? = null
  private var running: Job? = null
  private var timing: Map<String, Any?> = emptyMap()

  private fun model() = client ?: Generation.getClient().also { client = it }

  private fun build(r: NanoRequestRecord) = if (r.systemInstruction != null)
    generateContentRequest(SystemInstruction(r.systemInstruction), TextPart(r.text)) { tune(r) }
  else generateContentRequest(TextPart(r.text)) { tune(r) }

  private fun com.google.mlkit.genai.prompt.GenerateContentRequest.Builder.tune(r: NanoRequestRecord) {
    r.temperature?.let { temperature = it.toFloat() }
    r.topK?.let { topK = it }
    r.seed?.let { seed = it }
    r.maxOutputTokens?.let { maxOutputTokens = it }
  }

  /** GenAiException.errorCode travels as the JS error code `GENAI_<n>`; the message stays fixed. */
  private suspend fun <T> native(block: suspend () -> T): T = try { block() } catch (e: GenAiException) {
    throw CodedException("GENAI_${e.errorCode}", "Gemini Nano error ${e.errorCode}", null)
  }

  override fun definition() = ModuleDefinition {
    Name("ByokitNanoDemo")

    AsyncFunction("checkStatus") Coroutine { -> native { model().checkStatus() } }
    AsyncFunction("getBaseModelName") Coroutine { -> native { model().getBaseModelName() } }
    AsyncFunction("getTokenLimit") Coroutine { -> native { model().getTokenLimit() } }
    AsyncFunction("countTokens") Coroutine { r: NanoRequestRecord -> mapOf("totalTokens" to native { model().countTokens(build(r)).totalTokens }) }

    AsyncFunction("generateContent") Coroutine { r: NanoRequestRecord ->
      running = currentCoroutineContext()[Job]
      val started = SystemClock.elapsedRealtime()
      var first = -1L
      var pieces = 0
      try {
        val response = native {
          model().generateContent(build(r), StreamingCallback { _ ->
            if (first < 0) first = SystemClock.elapsedRealtime() - started
            pieces++
          })
        }
        val total = SystemClock.elapsedRealtime() - started
        timing = mapOf("firstTextMs" to first, "totalMs" to total, "pieces" to pieces)
        Log.i("ByokitNanoDemo", "nano-timing firstTextMs=$first totalMs=$total pieces=$pieces")
        mapOf("candidates" to response.candidates.map { mapOf("text" to it.text, "finishReason" to it.finishReason) })
      } finally { running = null }
    }

    Function("lastTiming") { timing }
    Function("cancel") { running?.cancel() }
    Function("close") { client?.close(); client = null }
  }
}
