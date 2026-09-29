package io.github.umeranjum17.byokit.overlay

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Expo module 'ByokitOverlay': the NativeOverlay seam (docs/capability-kits.md 7.3, 7.5). BK-O1 stub: state()
// resolves 'off' and everything else rejects until BK-O2 lands the bubble.
class OverlayModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ByokitOverlay")
    Events("overlay")

    AsyncFunction("state") { "off" }
    AsyncFunction("openPermission") { notBuilt() }
    AsyncFunction("start") { _: Map<String, Any?> -> notBuilt() }
    AsyncFunction("stop") { notBuilt() }
    Function("say") { _: String, _: String?, _: Double -> notBuilt() }
    Function("setMood") { _: String -> notBuilt() }
    Function("setRules") { _: Map<String, Any?> -> notBuilt() }
    AsyncFunction("openPanel") { _: Map<String, String> -> notBuilt() }
    AsyncFunction("closePanel") { notBuilt() }
    AsyncFunction("logTap") { _: String, _: String -> notBuilt() }
    AsyncFunction("taps") { _: Double -> notBuilt() }
    AsyncFunction("clearTaps") { notBuilt() }
  }

  private fun notBuilt() { throw CodedException("not built: BK-O2") }
}
