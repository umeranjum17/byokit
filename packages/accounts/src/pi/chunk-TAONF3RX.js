// @earendil-works/pi-ai@1.3.0 (MIT, (c) 2025 Mario Zechner), bundled by @byokit/accounts with a Hermes throwIfAborted guard; see NOTICE.

// node_modules/@earendil-works/pi-ai/dist/utils/headers.js
function headersToRecord(headers) {
  const result = {};
  for (const [key, value] of headers.entries()) {
    result[key] = value;
  }
  return result;
}
function providerHeadersToRecord(...headerSources) {
  const merged = /* @__PURE__ */ new Map();
  for (const source of headerSources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      const normalizedName = name.toLowerCase();
      merged.delete(normalizedName);
      if (value !== null)
        merged.set(normalizedName, [name, value]);
    }
  }
  return merged.size > 0 ? Object.fromEntries(merged.values()) : void 0;
}

export {
  headersToRecord,
  providerHeadersToRecord
};
//# sourceMappingURL=chunk-TAONF3RX.js.map
