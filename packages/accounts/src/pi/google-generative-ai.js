// @earendil-works/pi-ai@0.87.1 (MIT, (c) 2025 Mario Zechner), bundled by @byokit/accounts with a Hermes throwIfAborted guard; see NOTICE.
import {
  formatProviderError,
  normalizeProviderError
} from "./chunk-W3IKEFGN.js";
import {
  retryProviderRequest
} from "./chunk-3TVGBGLJ.js";
import {
  buildBaseOptions,
  getJsonSchemaToolParameters,
  getPiUserAgent,
  resolveJsonSchemaStrictSampling,
  sanitizeSurrogates,
  transformMessages
} from "./chunk-VUCNMX7O.js";
import {
  calculateCost,
  clampThinkingLevel,
  collapseSystemMessages,
  getCurrentTools,
  getInitialSystemMessage,
  getSystemMessageText,
  withoutInitialSystemMessage
} from "./chunk-PDUG4NYC.js";
import {
  providerHeadersToRecord
} from "./chunk-MIDDHJH2.js";
import {
  AssistantMessageEventStream
} from "./chunk-JTGIYXAQ.js";
import "./chunk-XD4THNNI.js";

// node_modules/@earendil-works/pi-ai/dist/api/google-generative-ai.js
import { GoogleGenAI } from "@google/genai";

// node_modules/@earendil-works/pi-ai/dist/api/google-shared.js
import { FinishReason, FunctionCallingConfigMode, ThinkingLevel as GoogleSdkThinkingLevel } from "@google/genai";
var GOOGLE_SDK_THINKING_LEVEL_MAP = {
  THINKING_LEVEL_UNSPECIFIED: GoogleSdkThinkingLevel.THINKING_LEVEL_UNSPECIFIED,
  MINIMAL: GoogleSdkThinkingLevel.MINIMAL,
  LOW: GoogleSdkThinkingLevel.LOW,
  MEDIUM: GoogleSdkThinkingLevel.MEDIUM,
  HIGH: GoogleSdkThinkingLevel.HIGH
};
function resolveGoogleThinkingLevel(model, level) {
  const mapped = model.thinkingLevelMap?.[level];
  const resolvedLevel = typeof mapped === "string" ? mapped.toLowerCase() : level;
  switch (resolvedLevel) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
      return resolvedLevel;
    default:
      throw new Error(`Unsupported Google thinking level mapping for ${model.provider}/${model.id}: ${level} -> ${String(mapped)}`);
  }
}
function usesGoogleThinkingLevel(model) {
  const id = model.id.toLowerCase();
  return (
    // Match Gemini 3 Pro/Flash IDs with or without a minor version, such as
    // gemini-3-flash-preview, gemini-3.1-pro-preview, and gemini-3.8-flash.
    /gemini-3(?:\.\d+)?-(?:pro|flash)/.test(id) || id === "gemini-flash-latest" || id === "gemini-flash-lite-latest" || // Match both hosted Gemma 4 naming forms: gemma-4-* and gemma4-*.
    /gemma-?4/.test(id)
  );
}
function toGoogleThinkingLevel(level) {
  switch (level) {
    case "minimal":
      return "MINIMAL";
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    case "high":
      return "HIGH";
  }
}
function toGoogleSdkThinkingLevel(level) {
  return GOOGLE_SDK_THINKING_LEVEL_MAP[level];
}
function getDisabledGoogleThinkingConfig(model) {
  if (!usesGoogleThinkingLevel(model))
    return { thinkingBudget: 0 };
  const fallback = clampThinkingLevel(model, "off");
  if (fallback === "off")
    return { thinkingBudget: 0 };
  const resolvedLevel = resolveGoogleThinkingLevel(model, fallback);
  const apiLevel = toGoogleThinkingLevel(resolvedLevel);
  return { thinkingLevel: toGoogleSdkThinkingLevel(apiLevel) };
}
function isThinkingPart(part) {
  return part.thought === true;
}
function retainThoughtSignature(existing, incoming) {
  if (typeof incoming === "string" && incoming.length > 0)
    return incoming;
  return existing;
}
var base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;
function isValidThoughtSignature(signature) {
  if (!signature)
    return false;
  if (signature.length % 4 !== 0)
    return false;
  return base64SignaturePattern.test(signature);
}
function resolveThoughtSignature(isSameProviderAndModel, signature) {
  return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : void 0;
}
function requiresToolCallId(modelId) {
  const geminiMajorVersion = getGeminiMajorVersion(modelId);
  return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-") || geminiMajorVersion !== void 0 && geminiMajorVersion >= 3;
}
function getGeminiMajorVersion(modelId) {
  const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
  if (!match)
    return void 0;
  return Number.parseInt(match[1], 10);
}
function supportsMultimodalFunctionResponse(modelId) {
  const geminiMajorVersion = getGeminiMajorVersion(modelId);
  if (geminiMajorVersion !== void 0) {
    return geminiMajorVersion >= 3;
  }
  return true;
}
function convertMessages(model, context) {
  const conversation = withoutInitialSystemMessage(collapseSystemMessages(context).messages);
  const contents = [];
  const normalizeToolCallId = (id) => {
    if (!requiresToolCallId(model.id))
      return id;
    return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  };
  const transformedMessages = transformMessages(conversation, model, normalizeToolCallId);
  for (const msg of transformedMessages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        contents.push({
          role: "user",
          parts: [{ text: sanitizeSurrogates(msg.content) }]
        });
      } else {
        const parts = msg.content.map((item) => {
          if (item.type === "text") {
            return { text: sanitizeSurrogates(item.text) };
          } else {
            return {
              inlineData: {
                mimeType: item.mimeType,
                data: item.data
              }
            };
          }
        });
        if (parts.length === 0)
          continue;
        contents.push({
          role: "user",
          parts
        });
      }
    } else if (msg.role === "assistant") {
      const parts = [];
      const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;
      for (const block of msg.content) {
        if (block.type === "text") {
          const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.textSignature);
          if ((!block.text || block.text.trim() === "") && !thoughtSignature)
            continue;
          parts.push({
            text: sanitizeSurrogates(block.text),
            ...thoughtSignature && { thoughtSignature }
          });
        } else if (block.type === "thinking") {
          if (isSameProviderAndModel) {
            const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thinkingSignature);
            if ((!block.thinking || block.thinking.trim() === "") && !thoughtSignature)
              continue;
            parts.push({
              thought: true,
              text: sanitizeSurrogates(block.thinking),
              ...thoughtSignature && { thoughtSignature }
            });
          } else {
            if (!block.thinking || block.thinking.trim() === "")
              continue;
            parts.push({
              text: sanitizeSurrogates(block.thinking)
            });
          }
        } else if (block.type === "toolCall") {
          const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature);
          const part = {
            functionCall: {
              name: block.name,
              args: block.arguments ?? {},
              ...requiresToolCallId(model.id) ? { id: block.id } : {}
            },
            ...thoughtSignature && { thoughtSignature }
          };
          parts.push(part);
        }
      }
      if (parts.length === 0)
        continue;
      contents.push({
        role: "model",
        parts
      });
    } else if (msg.role === "toolResult") {
      const textContent = msg.content.filter((c) => c.type === "text");
      const textResult = textContent.map((c) => c.text).join("\n");
      const imageContent = model.input.includes("image") ? msg.content.filter((c) => c.type === "image") : [];
      const hasText = textResult.length > 0;
      const hasImages = imageContent.length > 0;
      const modelSupportsMultimodalFunctionResponse = supportsMultimodalFunctionResponse(model.id);
      const responseValue = hasText ? sanitizeSurrogates(textResult) : hasImages ? "(see attached image)" : "";
      const imageParts = imageContent.map((imageBlock) => ({
        inlineData: {
          mimeType: imageBlock.mimeType,
          data: imageBlock.data
        }
      }));
      const includeId = requiresToolCallId(model.id);
      const functionResponsePart = {
        functionResponse: {
          name: msg.toolName,
          response: msg.isError ? { error: responseValue } : { output: responseValue },
          ...hasImages && modelSupportsMultimodalFunctionResponse && { parts: imageParts },
          ...includeId ? { id: msg.toolCallId } : {}
        }
      };
      const lastContent = contents[contents.length - 1];
      if (lastContent?.role === "user" && lastContent.parts?.some((p) => p.functionResponse)) {
        lastContent.parts.push(functionResponsePart);
      } else {
        contents.push({
          role: "user",
          parts: [functionResponsePart]
        });
      }
      if (hasImages && !modelSupportsMultimodalFunctionResponse) {
        contents.push({
          role: "user",
          parts: [{ text: "Tool result image:" }, ...imageParts]
        });
      }
    }
  }
  return contents;
}
var JSON_SCHEMA_META_DECLARATIONS = /* @__PURE__ */ new Set([
  "$schema",
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$vocabulary",
  "$comment",
  "$defs",
  "definitions"
  // pre-draft-2019-09 equivalent of $defs
]);
function sanitizeForOpenApi(schema) {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return schema;
  }
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (JSON_SCHEMA_META_DECLARATIONS.has(key))
      continue;
    result[key] = sanitizeForOpenApi(value);
  }
  return result;
}
function convertTools(tools, useParameters = false, supportsStrictMode = true) {
  if (tools.length === 0)
    return void 0;
  return [
    {
      functionDeclarations: tools.map((tool) => {
        const strict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
        const parameters = getJsonSchemaToolParameters(tool, strict);
        return {
          name: tool.name,
          description: tool.description,
          ...useParameters ? { parameters: sanitizeForOpenApi(parameters) } : { parametersJsonSchema: parameters }
        };
      })
    }
  ];
}
function supportsGoogleStrictToolSampling(modelId) {
  const majorVersion = getGeminiMajorVersion(modelId);
  return majorVersion !== void 0 && majorVersion >= 3;
}
function mapToolChoice(choice) {
  switch (choice) {
    case "auto":
      return FunctionCallingConfigMode.AUTO;
    case "none":
      return FunctionCallingConfigMode.NONE;
    case "any":
      return FunctionCallingConfigMode.ANY;
    default:
      return FunctionCallingConfigMode.AUTO;
  }
}
function resolveGoogleFunctionCallingMode(tools, toolChoice, supportsStrictMode) {
  const useStrictMode = tools.some((tool) => resolveJsonSchemaStrictSampling(tool, supportsStrictMode) === true);
  if (toolChoice === "none" || toolChoice === "any") {
    return mapToolChoice(toolChoice);
  }
  if (useStrictMode) {
    return FunctionCallingConfigMode.VALIDATED;
  }
  return toolChoice ? mapToolChoice(toolChoice) : void 0;
}
function mapStopReason(reason) {
  switch (reason) {
    case FinishReason.STOP:
      return "stop";
    case FinishReason.MAX_TOKENS:
      return "length";
    case FinishReason.BLOCKLIST:
    case FinishReason.PROHIBITED_CONTENT:
    case FinishReason.SPII:
    case FinishReason.SAFETY:
    case FinishReason.IMAGE_SAFETY:
    case FinishReason.IMAGE_PROHIBITED_CONTENT:
    case FinishReason.IMAGE_RECITATION:
    case FinishReason.IMAGE_OTHER:
    case FinishReason.RECITATION:
    case FinishReason.FINISH_REASON_UNSPECIFIED:
    case FinishReason.OTHER:
    case FinishReason.LANGUAGE:
    case FinishReason.MALFORMED_FUNCTION_CALL:
    case FinishReason.UNEXPECTED_TOOL_CALL:
    case FinishReason.TOO_MANY_TOOL_CALLS:
    case FinishReason.NO_IMAGE:
      return "error";
    default: {
      const _exhaustive = reason;
      throw new Error(`Unhandled stop reason: ${_exhaustive}`);
    }
  }
}
function retryGoogleRequest(request, options) {
  return retryProviderRequest(async () => {
    try {
      return await request();
    } catch (error) {
      if (error instanceof Error && "status" in error && !("headers" in error)) {
        error.headers = void 0;
      }
      throw error;
    }
  }, {
    maxRetries: options?.maxRetries,
    maxRetryDelayMs: options?.maxRetryDelayMs,
    signal: options?.signal
  });
}

// node_modules/@earendil-works/pi-ai/dist/api/google-generative-ai.js
var toolCallCounter = 0;
var stream = (model, context, options) => {
  const stream2 = new AssistantMessageEventStream();
  const normalizedContext = collapseSystemMessages(context);
  (async () => {
    const output = {
      role: "assistant",
      content: [],
      api: "google-generative-ai",
      provider: model.provider,
      model: model.id,
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
      if (options?.fetch && options.fetch !== globalThis.fetch) {
        throw new Error("Custom fetch is not supported by the Google Generative AI adapter");
      }
      const apiKey = options?.apiKey;
      if (!apiKey) {
        throw new Error(`No API key for provider: ${model.provider}`);
      }
      const client = createClient(model, apiKey, options?.headers);
      let params = buildParams(model, normalizedContext, options);
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== void 0) {
        params = nextParams;
      }
      const googleStream = await retryGoogleRequest(() => client.models.generateContentStream(params), options);
      stream2.push({ type: "start", partial: output });
      let currentBlock = null;
      const blocks = output.content;
      const blockIndex = () => blocks.length - 1;
      for await (const chunk of googleStream) {
        output.responseId ||= chunk.responseId;
        const candidate = chunk.candidates?.[0];
        if (candidate?.content?.parts) {
          for (const part of candidate.content.parts) {
            if (part.text !== void 0) {
              const isThinking = isThinkingPart(part);
              if (!currentBlock || isThinking && currentBlock.type !== "thinking" || !isThinking && currentBlock.type !== "text") {
                if (currentBlock) {
                  if (currentBlock.type === "text") {
                    stream2.push({
                      type: "text_end",
                      contentIndex: blocks.length - 1,
                      content: currentBlock.text,
                      partial: output
                    });
                  } else {
                    stream2.push({
                      type: "thinking_end",
                      contentIndex: blockIndex(),
                      content: currentBlock.thinking,
                      partial: output
                    });
                  }
                }
                if (isThinking) {
                  currentBlock = { type: "thinking", thinking: "", thinkingSignature: void 0 };
                  output.content.push(currentBlock);
                  stream2.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
                } else {
                  currentBlock = { type: "text", text: "" };
                  output.content.push(currentBlock);
                  stream2.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
                }
              }
              if (currentBlock.type === "thinking") {
                currentBlock.thinking += part.text;
                currentBlock.thinkingSignature = retainThoughtSignature(currentBlock.thinkingSignature, part.thoughtSignature);
                stream2.push({
                  type: "thinking_delta",
                  contentIndex: blockIndex(),
                  delta: part.text,
                  partial: output
                });
              } else {
                currentBlock.text += part.text;
                currentBlock.textSignature = retainThoughtSignature(currentBlock.textSignature, part.thoughtSignature);
                stream2.push({
                  type: "text_delta",
                  contentIndex: blockIndex(),
                  delta: part.text,
                  partial: output
                });
              }
            }
            if (part.functionCall) {
              if (currentBlock) {
                if (currentBlock.type === "text") {
                  stream2.push({
                    type: "text_end",
                    contentIndex: blockIndex(),
                    content: currentBlock.text,
                    partial: output
                  });
                } else {
                  stream2.push({
                    type: "thinking_end",
                    contentIndex: blockIndex(),
                    content: currentBlock.thinking,
                    partial: output
                  });
                }
                currentBlock = null;
              }
              const providedId = part.functionCall.id;
              const needsNewId = !providedId || output.content.some((b) => b.type === "toolCall" && b.id === providedId);
              const toolCallId = needsNewId ? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}` : providedId;
              const toolCall = {
                type: "toolCall",
                id: toolCallId,
                name: part.functionCall.name || "",
                arguments: part.functionCall.args ?? {},
                ...part.thoughtSignature && { thoughtSignature: part.thoughtSignature }
              };
              output.content.push(toolCall);
              stream2.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
              stream2.push({
                type: "toolcall_delta",
                contentIndex: blockIndex(),
                delta: JSON.stringify(toolCall.arguments),
                partial: output
              });
              stream2.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
            }
          }
        }
        if (candidate?.finishReason) {
          output.rawStopReason = candidate.finishReason;
          output.stopReason = mapStopReason(candidate.finishReason);
          if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
            output.stopReason = "toolUse";
          }
        }
        if (chunk.usageMetadata) {
          output.usage = {
            input: (chunk.usageMetadata.promptTokenCount || 0) - (chunk.usageMetadata.cachedContentTokenCount || 0),
            output: (chunk.usageMetadata.candidatesTokenCount || 0) + (chunk.usageMetadata.thoughtsTokenCount || 0),
            cacheRead: chunk.usageMetadata.cachedContentTokenCount || 0,
            cacheWrite: 0,
            reasoning: chunk.usageMetadata.thoughtsTokenCount || 0,
            totalTokens: chunk.usageMetadata.totalTokenCount || 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0
            }
          };
          calculateCost(model, output.usage);
        }
      }
      if (currentBlock) {
        if (currentBlock.type === "text") {
          stream2.push({
            type: "text_end",
            contentIndex: blockIndex(),
            content: currentBlock.text,
            partial: output
          });
        } else {
          stream2.push({
            type: "thinking_end",
            contentIndex: blockIndex(),
            content: currentBlock.thinking,
            partial: output
          });
        }
      }
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "pending") {
        throw new Error("Google stream ended without a finish reason");
      }
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        const errorMessage = output.rawStopReason ? `Provider stopped with: ${output.rawStopReason}` : "An unknown error occurred";
        throw new Error(errorMessage);
      }
      stream2.push({ type: "done", reason: output.stopReason, message: output });
      stream2.end();
    } catch (error) {
      for (const block of output.content) {
        if ("index" in block) {
          delete block.index;
        }
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatProviderError(normalizeProviderError(error));
      stream2.push({ type: "error", reason: output.stopReason, error: output });
      stream2.end();
    }
  })();
  return stream2;
};
var streamSimple = (model, context, options) => {
  const apiKey = options?.apiKey;
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }
  const base = {
    ...buildBaseOptions(model, context, options, apiKey),
    toolChoice: options?.toolChoice
  };
  if (!options?.reasoning) {
    return stream(model, context, { ...base, thinking: { enabled: false } });
  }
  const clampedReasoning = clampThinkingLevel(model, options.reasoning);
  if (clampedReasoning === "off") {
    return stream(model, context, { ...base, thinking: { enabled: false } });
  }
  const resolvedLevel = resolveGoogleThinkingLevel(model, clampedReasoning);
  if (usesGoogleThinkingLevel(model)) {
    return stream(model, context, {
      ...base,
      thinking: {
        enabled: true,
        level: toGoogleThinkingLevel(resolvedLevel)
      }
    });
  }
  return stream(model, context, {
    ...base,
    thinking: {
      enabled: true,
      budgetTokens: getGoogleBudget(model, resolvedLevel, options.thinkingBudgets)
    }
  });
};
function createClient(model, apiKey, optionsHeaders) {
  const httpOptions = {};
  if (model.baseUrl) {
    httpOptions.baseUrl = model.baseUrl;
    httpOptions.apiVersion = "";
  }
  const headers = providerHeadersToRecord({ "User-Agent": getPiUserAgent(), ...model.headers, ...optionsHeaders });
  if (headers) {
    httpOptions.headers = headers;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : void 0
  });
}
function buildParams(model, context, options = {}) {
  const contents = convertMessages(model, context);
  const initialSystemMessage = getInitialSystemMessage(context.messages);
  const currentTools = getCurrentTools(context.messages);
  const generationConfig = {};
  if (options.temperature !== void 0) {
    generationConfig.temperature = options.temperature;
  }
  if (options.maxTokens !== void 0) {
    generationConfig.maxOutputTokens = options.maxTokens;
  }
  const supportsStrictMode = supportsGoogleStrictToolSampling(model.id);
  const functionCallingMode = currentTools.length > 0 ? resolveGoogleFunctionCallingMode(currentTools, options.toolChoice, supportsStrictMode) : void 0;
  const systemInstruction = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
  const config = {
    ...Object.keys(generationConfig).length > 0 && generationConfig,
    ...systemInstruction && { systemInstruction: sanitizeSurrogates(systemInstruction) },
    ...currentTools.length > 0 && {
      tools: convertTools(currentTools, false, supportsStrictMode)
    },
    ...functionCallingMode !== void 0 && {
      toolConfig: { functionCallingConfig: { mode: functionCallingMode } }
    }
  };
  if (options.thinking?.enabled && model.reasoning) {
    const thinkingConfig = { includeThoughts: true };
    if (options.thinking.level !== void 0) {
      thinkingConfig.thinkingLevel = toGoogleSdkThinkingLevel(options.thinking.level);
    } else if (options.thinking.budgetTokens !== void 0) {
      thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
    }
    config.thinkingConfig = thinkingConfig;
  } else if (model.reasoning && options.thinking && !options.thinking.enabled) {
    config.thinkingConfig = getDisabledGoogleThinkingConfig(model);
  }
  if (options.signal) {
    if (options.signal.aborted) {
      throw new Error("Request aborted");
    }
    config.abortSignal = options.signal;
  }
  const params = {
    model: model.id,
    contents,
    config
  };
  return params;
}
function getGoogleBudget(model, level, customBudgets) {
  if (customBudgets?.[level] !== void 0) {
    return customBudgets[level];
  }
  if (model.id.includes("2.5-pro")) {
    const budgets = {
      minimal: 128,
      low: 2048,
      medium: 8192,
      high: 32768
    };
    return budgets[level];
  }
  if (model.id.includes("2.5-flash-lite")) {
    const budgets = {
      minimal: 512,
      low: 2048,
      medium: 8192,
      high: 24576
    };
    return budgets[level];
  }
  if (model.id.includes("2.5-flash")) {
    const budgets = {
      minimal: 128,
      low: 2048,
      medium: 8192,
      high: 24576
    };
    return budgets[level];
  }
  return -1;
}
export {
  stream,
  streamSimple
};
//# sourceMappingURL=google-generative-ai.js.map
