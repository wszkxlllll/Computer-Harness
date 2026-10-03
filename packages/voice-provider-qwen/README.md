# Qwen Realtime Voice Provider

`@computer-harness/voice-provider-qwen` implements the Qwen3-ASR-Flash-Realtime WebSocket protocol behind the provider-neutral `StreamingVoiceInputProvider` contract from `@computer-harness/voice`.

The Host supplies the workspace-scoped `wss` endpoint and credentials. The package sends `Authorization: Bearer …`, `OpenAI-Beta: realtime=v1`, and an optional `X-DashScope-WorkSpace` header. It negotiates 16 kHz PCM input with manual turn detection, appends ordered audio chunks, and on finish sends `input_audio_buffer.commit` then `session.finish`. The session remains open until `session.finished` arrives.

The WebSocket factory can be injected to test protocol messages without network access. Provider errors are reduced to fixed safe error codes; provider response text is not logged by this package. Audio and transcript events are transient session data.

The adapter publishes `providerId` and input capabilities for Host discovery (16 kHz mono PCM16, 3,200-byte recommended chunk, 60-second maximum). The Host enforces the duration/byte budget independently; this local capability report is not a remote connectivity probe.

This package currently has offline protocol tests only. A successful mock test does not verify API credentials, workspace routing, real audio recognition quality, or mobile latency.
