package io.github.umeranjum17.byokit.overlay

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Expo module 'ByokitFocusedField' (docs/capability-kits.md 7.4, 7.5). BK-O1 stub: never available, and read and
// insert reject until BK-O3 lands the accessibility side.
class FocusedFieldModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ByokitFocusedField")

    AsyncFunction("available") { false }
    AsyncFunction("read") { notBuilt() }
    AsyncFunction("insert") { _: String, _: Map<String, Any?>? -> notBuilt() }
  }

  private fun notBuilt() { throw CodedException("not built: BK-O3") }
}
