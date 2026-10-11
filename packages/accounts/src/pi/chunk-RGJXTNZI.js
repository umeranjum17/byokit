// @earendil-works/pi-ai@0.87.1 (MIT, (c) 2025 Mario Zechner), bundled by @byokit/accounts with a Hermes throwIfAborted guard; see NOTICE.
import {
  __require
} from "./chunk-XD4THNNI.js";

// node_modules/@earendil-works/pi-ai/dist/utils/provider-env.js
var procEnvCache = null;
function getBunSandboxEnvValue(name) {
  if (typeof process === "undefined" || !process.versions?.bun || Object.keys(process.env).length > 0) {
    return void 0;
  }
  if (procEnvCache === null) {
    procEnvCache = /* @__PURE__ */ new Map();
    try {
      const { readFileSync } = __require("node:fs");
      const data = readFileSync("/proc/self/environ", "utf-8");
      for (const entry of data.split("\0")) {
        const idx = entry.indexOf("=");
        if (idx > 0) {
          procEnvCache.set(entry.slice(0, idx), entry.slice(idx + 1));
        }
      }
    } catch {
    }
  }
  return procEnvCache.get(name);
}
function getProviderEnvValue(name, env) {
  return env?.[name] || (typeof process !== "undefined" ? process.env[name] : void 0) || getBunSandboxEnvValue(name) || void 0;
}

export {
  getProviderEnvValue
};
//# sourceMappingURL=chunk-RGJXTNZI.js.map
