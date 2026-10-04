package io.github.umeranjum17.byokit.share

object ShareRules {
  const val CONSUMED = "io.github.umeranjum17.byokit.share.CONSUMED"
  const val MAX_BYTES = 100L * 1024 * 1024
  fun isTextBranch(type: String?) = type?.startsWith("text/plain") == true
  fun isShare(action: String?, type: String?) = action == "android.intent.action.SEND" ||
    action == "android.intent.action.SEND_MULTIPLE" || (action == "android.intent.action.VIEW" && isTextBranch(type))
  fun reject(scheme: String?, authority: String?, providerUid: Int?, myUid: Int): String? = when {
    scheme != "content" -> "not_content"
    authority.isNullOrEmpty() || '@' in authority || providerUid == myUid -> "own_provider"
    else -> null
  }
  fun copyName(index: Int, displayName: String?, ext: String?): String {
    val safe = displayName.orEmpty().replace(Regex("[^A-Za-z0-9._-]"), "_")
      .take(90).takeUnless { it.isBlank() || it == "." || it == ".." }
      ?: ("shared" + (ext?.replace(Regex("[^A-Za-z0-9]"), "")?.take(12)?.takeIf { it.isNotEmpty() }?.let { ".$it" } ?: ""))
    return "$index-$safe".take(100)
  }
  fun label(displayName: String?, fallback: String) = displayName?.take(255)?.ifBlank { null } ?: fallback
  fun mime(provider: String?, intentType: String?, extGuess: String?) =
    provider ?: intentType?.takeUnless { '*' in it } ?: extGuess ?: "application/octet-stream"
  fun kind(textBranch: Boolean, text: String?, streams: Int, read: Int) = when {
    textBranch -> if (text != null) "shared" else "none"
    read > 0 -> "shared"
    streams > 0 -> "unreadable"
    else -> "none"
  }
}
