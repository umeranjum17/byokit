# Changelog

## Unreleased

- FIX: Report saved-sign-in failure reasons and plain remedies in advisory auth checks while preserving existing status results.

## 0.2.0 (2026-09-30)



- FIX: Make each realtime README example independently typecheck against the package exports.
- FIX: Start phone WebRTC with React Native AbortSignal implementations that have no throwIfAborted method.
- FIX: Report connected when playback has nothing to drain, and flush queued speech after audio clears while muted.
- FIX: Offer opt-in PCM capture and playback-tail retention across carrier reconnects, releasing retained media on stop.
- FIX: Apply app-supplied hangup policy on every route and end the session after the next agent transcript.
- FIX: Use the host tool watchdog and failure wording instead of a competing fixed 300-second child deadline.
- FIX: Keep ChatGPT delegations and retransmission results across ordinary user turns; explicit interruption and close still cancel them.
- FIX: Ignore empty ChatGPT transcripts instead of emitting a failure line or clearing audio.
- FIX: Drain child output before reporting process disconnection so the provider's final close reason survives.
- FIX: Preserve transcripts up to 4,000 UTF-8 bytes and bound state details by bytes without splitting Unicode characters.
- FIX: Preserve sanitized credential-error remedies and accept app-supplied auth failure wording.
- FIX: Overlap ChatGPT media preparation, child startup and access lookup, keep early offers behind credential configuration, and allow explicit app signaling identity.
- FIX: Route semantic app tool replies to the host bridge and cancel pending app requests when the session closes.
- Add structured delegation through app-supplied tools, preserving named targets and operation ids.
- Add a bounded, read-only advisory auth check that never gates session startup or initiates login.
- Add interruption fencing and tool cancellation, bounded provider and transport reconnects, and fresh-call ChatGPT subscription voice interruption.

## 0.1.0 (2026-09-30)

- Add realtime speech-to-speech sessions with injected audio and child-process provider adapters.
- Add ChatGPT subscription voice through accounts and OpenAI, Gemini and xAI with an API key (billed per use).
- live ChatGPT-plan voice proof: pending, needs the owner at the desk with a microphone.

- Initial realtime voice kit with bounded frames, WebRTC signaling, tool calls, turn events, interruption hooks and usage.
