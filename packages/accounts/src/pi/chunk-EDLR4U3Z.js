// @earendil-works/pi-ai@0.87.1 (MIT, (c) 2025 Mario Zechner), bundled unmodified by @byokit/accounts; see NOTICE.

// node_modules/@earendil-works/pi-ai/dist/api/openai-prompt-cache.js
var OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
function clampOpenAIPromptCacheKey(key) {
  if (key === void 0)
    return void 0;
  const chars = Array.from(key);
  if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH)
    return key;
  return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

export {
  clampOpenAIPromptCacheKey
};
//# sourceMappingURL=chunk-EDLR4U3Z.js.map
