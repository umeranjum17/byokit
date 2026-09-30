# Security

The host supplies a keystore and person identifier. Scope it to the person and app on
this device. Tokens and dynamic client credentials are written only to that store;
the kit never reads ambient accounts, environment keys or credential files. No
server pool or account sharing is provided. Connection keys are fixed-length SHA-256 names over person, provider,
resource, issuer/token endpoint and configured client ID. Long identities therefore
fit every keystore backend without exposing those identities in keyring labels.

Treat `token()` as trusted app code: never display or log its result. The kit does
not log credentials or include provider response bodies in OAuth errors. The full
MCP client can return private content and server error messages; handle those as
private app data. Close each MCP client when finished.

Remote endpoints require HTTPS, with HTTP allowed only on loopback. Requests refuse
redirects, so credentials cannot follow a server redirect. Callback addresses support
HTTPS, loopback HTTP and host-registered native app schemes. PKCE, unpredictable
state, exact callback address checks, deadlines and one-shot callbacks protect each
sign-in. The host must claim its native callback scheme or use verified app links.

Refresh is serialized across handles sharing the same store object and connection
identity. Separate processes/store objects need host coordination; do not open the
same person's writable store in multiple processes. Explicit invalid-grant refresh
responses remove the sign-in; temporary server/network failures preserve it.
