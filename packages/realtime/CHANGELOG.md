# Changelog

## Unreleased

- FIX: Route semantic app tool replies to the host bridge and cancel pending app requests when the session closes.
- Add structured delegation through app-supplied tools, preserving named targets and operation ids.
- Add a bounded, read-only advisory auth check that never gates session startup or initiates login.
- Add interruption fencing and tool cancellation, bounded provider and transport reconnects, and fresh-call ChatGPT subscription voice interruption.

## 0.1.0 (2026-09-30)

- Add realtime speech-to-speech sessions with injected audio and child-process provider adapters.
- Add ChatGPT subscription voice through accounts and OpenAI, Gemini and xAI with an API key (billed per use).
- live ChatGPT-plan voice proof: pending, needs the owner at the desk with a microphone.

- Initial realtime voice kit with bounded frames, WebRTC signaling, tool calls, turn events, interruption hooks and usage.
