// @earendil-works/pi-ai@0.87.1 (MIT, (c) 2025 Mario Zechner), bundled unmodified by @byokit/accounts; see NOTICE.

// node_modules/@earendil-works/pi-ai/dist/utils/headers.js
function headersToRecord(headers) {
  const result = {};
  for (const [key, value] of headers.entries()) {
    result[key] = value;
  }
  return result;
}
function providerHeadersToRecord(headers) {
  if (!headers)
    return void 0;
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== null)
      result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : void 0;
}

export {
  headersToRecord,
  providerHeadersToRecord
};
//# sourceMappingURL=chunk-5CS55XCW.js.map
