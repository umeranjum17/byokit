// @earendil-works/pi-ai@1.3.0 (MIT, (c) 2025 Mario Zechner), bundled by @byokit/accounts with a Hermes throwIfAborted guard; see NOTICE.
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream
} from "./chunk-55ILOTBA.js";
import {
  clampOpenAIPromptCacheKey
} from "./chunk-NA5244EX.js";
import {
  buildCopilotDynamicHeaders,
  hasCopilotVisionInput
} from "./chunk-NVYPJUI2.js";
import {
  formatProviderError,
  normalizeProviderError
} from "./chunk-RDJUIRLA.js";
import {
  retryProviderRequest
} from "./chunk-RZGFK6O6.js";
import "./chunk-VAPZ7LCI.js";
import {
  buildBaseOptions,
  createGrammarToolInputProperties,
  getPiUserAgent,
  resolveSamplingParams
} from "./chunk-FT4IFEZ5.js";
import {
  clampThinkingLevel,
  getDeclaredTools,
  resolveTranscript,
  resolveTranscriptTools
} from "./chunk-N24NYBSM.js";
import {
  getProviderEnvValue
} from "./chunk-HFF7HWFJ.js";
import "./chunk-7Z5MAJVW.js";
import {
  headersToRecord
} from "./chunk-TAONF3RX.js";
import {
  AssistantMessageEventStream
} from "./chunk-XHKJTHE7.js";
import "./chunk-KWV666JL.js";

// node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js
import OpenAI from "openai";
var OPENAI_TOOL_CALL_PROVIDERS = /* @__PURE__ */ new Set(["openai", "openai-codex", "opencode"]);
var OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
var CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
var CONFIGURATION_UPDATE_REQUEST_EFFORT = "medium";
function isChatGPTSignIn(model, apiKey) {
  return model.provider === "openai" && model.baseUrl === "https://api.openai.com/v1" && apiKey !== void 0 && !apiKey.startsWith("sk-");
}
function hasHeader(headers, name) {
  if (!headers)
    return false;
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected && value !== null && value.trim().length > 0)
      return true;
  }
  return false;
}
function getClientApiKey(provider, apiKey, headers) {
  if (apiKey)
    return apiKey;
  if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization"))
    return "unused";
  throw new Error(`No API key for provider: ${provider}`);
}
function detectSessionAffinityFormat(model) {
  return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai";
}
function resolveCacheRetention(cacheRetention, env) {
  if (cacheRetention) {
    return cacheRetention;
  }
  if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
    return "long";
  }
  return "short";
}
function getCompat(model) {
  return {
    supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
    supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
    sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? detectSessionAffinityFormat(model),
    supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
    supportsStrictMode: model.compat?.supportsStrictMode ?? false,
    supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
    supportsAdditionalTools: model.compat?.supportsAdditionalTools ?? false,
    supportsToolSearch: model.compat?.supportsToolSearch ?? false,
    supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
    supportsMaxOutputTokens: model.compat?.supportsMaxOutputTokens ?? true,
    supportsMidConvoEffort: model.compat?.supportsMidConvoEffort ?? false
  };
}
function getConfigurationUpdateEffort(model, options, compat) {
  if (!compat.supportsMidConvoEffort || !options?.reasoningEffort || // Sign in with ChatGPT rejects configuration_update items.
  isChatGPTSignIn(model, options.apiKey)) {
    return void 0;
  }
  return model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
}
function getPromptCacheRetention(compat, cacheRetention) {
  return cacheRetention === "long" && compat.supportsLongCacheRetention && !compat.supportsExplicitPromptCacheMode ? "24h" : void 0;
}
function getPromptCacheOptions(compat, cacheRetention) {
  if (!compat.supportsExplicitPromptCacheMode)
    return void 0;
  if (cacheRetention === "none")
    return { mode: "explicit" };
  if (cacheRetention === "long" && compat.supportsLongCacheRetention)
    return { ttl: "30m" };
  return void 0;
}
var stream = (model, context, options) => {
  const stream2 = new AssistantMessageEventStream();
  const normalizedContext = resolveTranscript(context, getCompat(model).supportsMidConvoSystemMessages);
  (async () => {
    const compat = getCompat(model);
    const configurationUpdateEffort = getConfigurationUpdateEffort(model, options, compat);
    const output = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      ...configurationUpdateEffort === void 0 ? {} : { providerThinkingLevel: configurationUpdateEffort },
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "pending",
      timestamp: Date.now()
    };
    try {
      const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
      const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
      const cacheSessionId = cacheRetention === "none" ? void 0 : options?.sessionId;
      const grammarToolInputProperties = createGrammarToolInputProperties(getDeclaredTools(normalizedContext.messages), compat.supportsOpenAIGrammarTools);
      const client = createClient(model, normalizedContext, apiKey, options?.headers, options?.fetch, cacheSessionId);
      let params = buildParams(model, normalizedContext, options, compat, grammarToolInputProperties, configurationUpdateEffort);
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== void 0) {
        params = nextParams;
      }
      const requestOptions = {
        ...options?.signal ? { signal: options.signal } : {},
        ...options?.timeoutMs !== void 0 ? { timeout: options.timeoutMs } : {},
        maxRetries: 0
      };
      const { data: openaiStream, response } = await retryProviderRequest(() => client.responses.create(params, requestOptions).withResponse(), {
        maxRetries: options?.maxRetries,
        maxRetryDelayMs: options?.maxRetryDelayMs,
        signal: options?.signal
      });
      await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
      stream2.push({ type: "start", partial: output });
      await processResponsesStream(openaiStream, output, stream2, model, {
        onProviderStreamEvent: options?.onProviderStreamEvent,
        serviceTier: options?.serviceTier,
        grammarToolInputProperties,
        applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model)
      });
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "pending") {
        throw new Error("OpenAI Responses stream ended without a stop reason");
      }
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error(output.errorMessage || "An unknown error occurred");
      }
      stream2.push({ type: "done", reason: output.stopReason, message: output });
      stream2.end();
    } catch (error) {
      for (const block of output.content) {
        delete block.index;
        delete block.partialJson;
        delete block.customInput;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      const errorMessage = formatProviderError(normalizeProviderError(error), `${model.provider === "openai" ? "OpenAI" : model.provider} API error`);
      output.errorMessage = errorMessage.includes("subscription_sharing_usage_limit_exceeded") ? `${errorMessage}
Check your ChatGPT usage: ${CHATGPT_USAGE_URL}` : errorMessage;
      stream2.push({ type: "error", reason: output.stopReason, error: output });
      stream2.end();
    }
  })();
  return stream2;
};
var streamSimple = (model, context, options) => {
  getClientApiKey(model.provider, options?.apiKey, options?.headers);
  const base = {
    ...buildBaseOptions(model, context, options, options?.apiKey),
    toolChoice: options?.toolChoice
  };
  const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : void 0;
  const reasoningEffort = clampedReasoning === "off" ? void 0 : clampedReasoning;
  return stream(model, context, {
    ...base,
    reasoningEffort
  });
};
function createClient(model, context, apiKey, optionsHeaders, fetch, sessionId) {
  const compat = getCompat(model);
  const headers = { "User-Agent": getPiUserAgent(), ...model.headers };
  if (model.provider === "github-copilot") {
    const hasImages = hasCopilotVisionInput(context.messages);
    const copilotHeaders = buildCopilotDynamicHeaders({
      messages: context.messages,
      hasImages
    });
    Object.assign(headers, copilotHeaders);
  }
  if (sessionId) {
    if (compat.sessionAffinityFormat === "openrouter") {
      headers["x-session-id"] = sessionId;
    } else {
      if (compat.sessionAffinityFormat === "openai") {
        headers.session_id = sessionId;
      }
      headers["x-client-request-id"] = sessionId;
    }
  }
  if (optionsHeaders) {
    Object.assign(headers, optionsHeaders);
  }
  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    fetch,
    defaultHeaders: headers
  });
}
function buildParams(model, context, options, compat, grammarToolInputProperties, configurationUpdateEffort) {
  const transcriptTools = resolveTranscriptTools(context.messages, compat.supportsAdditionalTools || compat.supportsToolSearch);
  const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
    grammarToolInputProperties,
    supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages,
    supportsAdditionalTools: compat.supportsAdditionalTools,
    supportsToolSearch: compat.supportsToolSearch,
    toolOptions: {
      supportsStrictMode: compat.supportsStrictMode,
      supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools
    },
    configurationUpdateEffort
  });
  const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
  const omitUnsupportedFields = isChatGPTSignIn(model, options?.apiKey);
  const params = {
    model: model.id,
    input: messages,
    stream: true,
    prompt_cache_key: cacheRetention === "none" ? void 0 : clampOpenAIPromptCacheKey(options?.sessionId),
    prompt_cache_retention: omitUnsupportedFields ? void 0 : getPromptCacheRetention(compat, cacheRetention),
    prompt_cache_options: omitUnsupportedFields ? void 0 : getPromptCacheOptions(compat, cacheRetention),
    store: false
  };
  if (options?.maxTokens && compat.supportsMaxOutputTokens && !omitUnsupportedFields) {
    params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
  }
  if (options?.temperature !== void 0 && !omitUnsupportedFields) {
    params.temperature = options?.temperature;
  }
  if (options?.serviceTier !== void 0) {
    params.service_tier = options.serviceTier;
  }
  if (transcriptTools.requestTools.length > 0) {
    params.tools = convertResponsesTools(transcriptTools.requestTools, {
      supportsStrictMode: compat.supportsStrictMode,
      supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools
    });
  }
  if (options?.toolChoice !== void 0) {
    params.tool_choice = options.toolChoice;
  }
  const reasoningEffort = options?.reasoningEffort ?? (options?.reasoningSummary ? "medium" : void 0);
  if (model.reasoning) {
    if (reasoningEffort) {
      const requestedEffort = options?.reasoningEffort ? model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort : reasoningEffort;
      const effort = configurationUpdateEffort === void 0 ? requestedEffort : CONFIGURATION_UPDATE_REQUEST_EFFORT;
      params.reasoning = {
        effort,
        summary: options?.reasoningSummary || "auto"
      };
      params.include = ["reasoning.encrypted_content"];
    } else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {
      params.reasoning = {
        effort: model.thinkingLevelMap?.off ?? "none"
      };
    }
    if (model.provider === "xai")
      params.include = ["reasoning.encrypted_content"];
  }
  const samplingParams = resolveSamplingParams(model, reasoningEffort ?? "off", options?.samplingParams);
  if (samplingParams) {
    Object.assign(params, samplingParams);
  }
  return params;
}
function getServiceTierCostMultiplier(model, serviceTier) {
  switch (serviceTier) {
    case "flex":
      return 0.5;
    case "priority":
    case "fast":
      return model.id === "gpt-5.5" ? 2.5 : 2;
    default:
      return 1;
  }
}
function applyServiceTierPricing(usage, serviceTier, model) {
  const multiplier = getServiceTierCostMultiplier(model, serviceTier);
  if (multiplier === 1)
    return;
  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
export {
  stream,
  streamSimple
};
//# sourceMappingURL=openai-responses.js.map
