package io.github.umeranjum17.byokit.notices

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class NoticesModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ByokitNotices")
    AsyncFunction("setNoticeKey") { values: List<Int> ->
      require(values.size == 32 && values.all { it in 0..255 }) { "notices: invalid key" }
      val key = values.map { it.toByte() }.toByteArray()
      try { NoticeKeyStore(requireNotNull(appContext.reactContext)).set(key) }
      finally { key.fill(0) }
    }
    AsyncFunction("clearNoticeKey") { NoticeKeyStore(requireNotNull(appContext.reactContext)).clear() }
  }
}
