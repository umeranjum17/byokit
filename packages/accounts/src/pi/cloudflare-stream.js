// @earendil-works/pi-ai@0.87.1 (MIT, (c) 2025 Mario Zechner), bundled by @byokit/accounts with a Hermes throwIfAborted guard; see NOTICE.
import "./chunk-XD4THNNI.js";

// node_modules/@earendil-works/pi-ai/dist/providers/cloudflare-stream.js
var CLOUDFLARE_ACCOUNT_ID = "CLOUDFLARE_ACCOUNT_ID";
var CLOUDFLARE_GATEWAY_ID = "CLOUDFLARE_GATEWAY_ID";
function resolveCloudflareModel(model, env) {
  if (!env)
    return model;
  const baseUrl = model.baseUrl.replaceAll(`{${CLOUDFLARE_ACCOUNT_ID}}`, env[CLOUDFLARE_ACCOUNT_ID] ?? `{${CLOUDFLARE_ACCOUNT_ID}}`).replaceAll(`{${CLOUDFLARE_GATEWAY_ID}}`, env[CLOUDFLARE_GATEWAY_ID] ?? `{${CLOUDFLARE_GATEWAY_ID}}`);
  return baseUrl === model.baseUrl ? model : { ...model, baseUrl };
}
function cloudflareStreams(streams) {
  return {
    stream: (model, context, options) => streams.stream(resolveCloudflareModel(model, options?.env), context, options),
    streamSimple: (model, context, options) => streams.streamSimple(resolveCloudflareModel(model, options?.env), context, options)
  };
}
export {
  cloudflareStreams,
  resolveCloudflareModel
};
//# sourceMappingURL=cloudflare-stream.js.map
