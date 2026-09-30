# Security policy

Report suspected vulnerabilities privately, especially credential disclosure,
unauthorized device access, or failures of the isolation boundary.

Disclosure contact: **[OWNER: replace with a monitored security email or private
reporting URL before release].** This placeholder is not a working contact. Do not
post credentials or exploit details in public issues while the contact is pending.

Include the affected kit and version, platform, reproduction steps with fake or
redacted credentials, impact, and any proposed fix. Never send a real sign-in token,
private key, device grant, or personal state directory.

Security fixes target each kit's latest release. Packages marked private are not
released; older versions may require an upgrade. Coordinate disclosure with the
maintainer once the private contact is configured; response times are not promised
until that contact is operational.

The kit-specific threat models and checklists live in
[link](packages/link/SECURITY.md), [relay](packages/relay/SECURITY.md),
[seal](packages/seal/SECURITY.md), and [secrets](packages/secrets/SECURITY.md).
A checklist records review work; its presence alone does not establish a completed
security review. Tests use fake credentials and isolated state, with outbound
network blocked by `scripts/test-egress-guard.cjs`.
