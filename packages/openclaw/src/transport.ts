// The real GatewayTransport over @openclaw/gateway-client (5.4, O4).
import type { GatewayTransport } from './types.ts';

export function gatewayTransport(ctx: {
  port: number;
  token: string;
  identityPath: string;
  bridgeSock: string;
}): GatewayTransport {
  throw new Error('not built: O4');
}
