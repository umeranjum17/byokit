# Connect test endpoint overrides

Run `npm run build`, then `sh scripts/test.sh 'packages/connect/test/endpoints-emulate.test.ts'` while holding the environment's required heavy-job lock. The integration starts pinned emulate 0.12.2 and a loopback GitHub device-flow server, then drives Google OAuth code exchange and Gmail API read, GitHub device-code/token endpoints, and an app-owned GitHub `/user` API request based on the `apiBase` exposed by the built `@byokit/connect` connection. The kit itself has no GitHub REST API calls.
