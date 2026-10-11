// @earendil-works/pi-ai@0.87.1 (MIT, (c) 2025 Mario Zechner), bundled by @byokit/accounts with a Hermes throwIfAborted guard; see NOTICE.

// node_modules/@earendil-works/pi-ai/dist/api/github-copilot-headers.js
function inferCopilotInitiator(messages) {
  const last = messages[messages.length - 1];
  return last && last.role !== "user" ? "agent" : "user";
}
function hasCopilotVisionInput(messages) {
  return messages.some((msg) => {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      return msg.content.some((c) => c.type === "image");
    }
    if (msg.role === "toolResult" && Array.isArray(msg.content)) {
      return msg.content.some((c) => c.type === "image");
    }
    return false;
  });
}
function buildCopilotDynamicHeaders(params) {
  const headers = {
    "X-Initiator": inferCopilotInitiator(params.messages),
    "Openai-Intent": "conversation-edits"
  };
  if (params.hasImages) {
    headers["Copilot-Vision-Request"] = "true";
  }
  return headers;
}

export {
  hasCopilotVisionInput,
  buildCopilotDynamicHeaders
};
//# sourceMappingURL=chunk-FJMJCJSO.js.map
