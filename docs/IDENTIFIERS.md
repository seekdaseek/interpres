# Spoken wallet addresses

Every recorded attempt to speak a wallet address, from every source in `data/`, recounted by `scripts/spoken-identifiers.ts`. "Ran" is whether the address reached an MCP server: a misheard value ran in 5 of them, all from before the gate held spoken identifiers (decision D4).

Exact: 13 of 23.

Misheard and reached a server: 5.

The 13 exact hearings came from 1 distinct clip: michael's Q5 clip (sha256 9bd03d7469cc…), heard exactly in 2 video takes and 5 rehearsals and 6 round H1 A/B sessions.

| source | session | spoken | heard | exact | ran |
| --- | --- | --- | --- | --- | --- |
| e2e-audio-afg-baseline.json | `sess_2d559d4f8c5f4a54a19704b7f5902895` | `0x00000000…000001` (42) | `0x00000000…000000` (695) | no | nothing ran |
| e2e-audio-afg-natural.json | `sess_545bb78a858f41bebe3b5f6135b11524` | `0x3f9a1c7e…4d6f09` (42) | `0x3f9a1c7e…4d6f09` (42) | no | ran with `0x3f9a1c7e…4d6f09` (42) |
| e2e-audio-afg-nocarry.json | `sess_72ded57c42ea46b98af12f36a90d2282` | `0x5aaeb605…1beaed` (42) | `0x5aeb6053…f1bead` (40) | no | ran with `0x5aeb6053…f1bead` (40) |
| e2e-audio-afg-phase-carry.json | `sess_a22027d3092e4992a387619ba232817d` | `0x3f9a1c7e…4d6f09` (42) | `0x3f9a1c7e…4d6f09` (44) | no | ran with `0x3f9a1c7e…4d6f09` (44) |
| e2e-audio-afg-phase-nocarry.json | `sess_8f118a8d2bb145fc994d5affaa99a3f3` | `0x3f9a1c7e…4d6f09` (42) | `0x3f9a1c7e…4d6f09` (42) | no | ran with `0x3f9a1c7e…4d6f09` (42) |
| e2e-audio-gate-spoken-d4.json | `sess_2762c5ea28bc4b1f99dbe0a3c2b8fe4f` | `0x3f9a1c7e…4d6f09` (42) | `0x3f91c7e5…4d6f09` (41) | no | nothing ran |
| e2e-audio-gate-spoken.json | `sess_c7ecda9ca1ca4a3f8eebfb18378bd139` | `0x3f9a1c7e…4d6f09` (42) | `0x3f9a1c7e…4d6f09` (42) | no | ran with `0x3f9a1c7e…4d6f09` (42) |
| qa-public-round-e.json (desktop) | `sess_144a98f5fd3f434f94f2d1628f21d984` | `0x5aaeb605…1beaed` (42) | `0x5aeb6053…f1b8ed` (40) | no | nothing ran |
| qa-public-round-e.json (mobile375) | `sess_ee5881f4b8074acdabe6137482a8327b` | `0x5aaeb605…1beaed` (42) | `0x5aeb6053…f1b8ed` (40) | no | nothing ran |
| video/capture-C-20260927T064547.json | `sess_3fcf411e656145b0a5b487036ce05e38` | `0x5aaeb605…1beaed` (42) | `0x5aaeb605…1beaed` (42) | yes | nothing ran |
| video/capture-C-20260927T091639.json | `sess_bad159e000e9412ba713b9dfb8389cf2` | `0x5aaeb605…1beaed` (42) | `0x5aaeb605…1beaed` (42) | yes | nothing ran |
| video/rehearsals-c.json (brief) | `sess_7207e8d4878241fca8de881aaad6b9f9` | `0x5aaeb605…1beaed` (42) | `0x5aaeb605…1beaed` (42) | yes | nothing ran |
| video/rehearsals-c.json (brief) | `sess_5d116e8491ce41f894d2dd99061aed65` | `0x5aaeb605…1beaed` (42) | `0x5aaeb605…1beaed` (42) | yes | ran with the spoken value |
| video/rehearsals-c.json (brief) | `sess_01ca2a290e594b2981fd9b60e845a6ae` | `0x5aaeb605…1beaed` (42) | `0x5aaeb605…1beaed` (42) | yes | ran with the spoken value |
| video/rehearsals-c.json (brief) | `sess_492217eebd9f4144a7e09a53bba6d4e2` | `0x5aaeb605…1beaed` (42) | `0x5aaeb605…1beaed` (42) | yes | ran with the spoken value |
| video/rehearsals-c.json (other-address) | `sess_025ae7e96be84cdb97b39cb823a11d98` | `0x3f9a1c7e…4d6f09` (42) | `0x3f9a1c7e…4d6f09` (42) | no | nothing ran |
| video/rehearsals-c.json (spoken-first) | `sess_ba2e2e5b1e384e098834b6adfc23a189` | `0x5aaeb605…1beaed` (42) | `0x5aaeb605…1beaed` (42) | yes | nothing ran |
| latency-ab-h1-2026-09-27.json (balanced, run 1) | `sess_04deb70191094b82a7b2894d877ce224` | `0x5aaeb605…1beaed` (42) | `0x5aaeb605…1beaed` (42) | yes | nothing ran |
| latency-ab-h1-2026-09-27.json (min_latency, run 1) | `sess_3f9193f7624342c3b3c753fe80364b73` | `0x5aaeb605…1beaed` (42) | `0x5aaeb605…1beaed` (42) | yes | nothing ran |
| latency-ab-h1-2026-09-27.json (min_latency, run 2) | `sess_6b539ba0b8644186ba515aa294c44468` | `0x5aaeb605…1beaed` (42) | `0x5aaeb605…1beaed` (42) | yes | nothing ran |
| latency-ab-h1-2026-09-27.json (balanced, run 2) | `sess_15a6297c84d54989a18f767dbcf5cd7e` | `0x5aaeb605…1beaed` (42) | `0x5aaeb605…1beaed` (42) | yes | nothing ran |
| latency-ab-h1-2026-09-27.json (balanced, run 3) | `sess_a82c06b9e3374014be77ddedf64d8cd7` | `0x5aaeb605…1beaed` (42) | `0x5aaeb605…1beaed` (42) | yes | nothing ran |
| latency-ab-h1-2026-09-27.json (min_latency, run 3) | `sess_0a06f45f3411429ebf0b03ea8463f743` | `0x5aaeb605…1beaed` (42) | `0x5aaeb605…1beaed` (42) | yes | nothing ran |

## Files in data/ that hold an address but are not counted

| file | why |
| --- | --- |
| `e2e-audio-gate-paste-d4.json` | the address was pasted, not spoken |
| `e2e-audio-gate-paste.json` | the address was pasted, not spoken |
| `e2e-checkpoint-a.json` | text injected with conversation.message (scripts/e2e.ts), not speech |
| `latency-ab-2026-09-27.json` | the transcription-mode A/B (round G1): no clip speaks an address; the only one was pasted for Q4 |
| `latency-ab-clips.json` | the A/B clip manifest: Q5's text itself; the round H1 sessions that spoke it are counted |
| `qa-audio/clips.json` | the clip texts themselves, counted through the QA record |
| `sweep-2026-09-26T1148Z-summary.json` | an address inside a registry server description; nothing was spoken |
| `sweep-2026-09-26T1252Z-recheck-summary.json` | an address inside a registry server description; nothing was spoken |
| `video/caller-gate.json` | the F2a hearing gate: its only address was pasted for Q4, not spoken |
| `video/transcripts/C-20260927T064547-caller.json` | a capture stem transcript; that take is counted from its capture log |
| `video/transcripts/C-20260927T091639-caller.json` | a capture stem transcript; that take is counted from its capture log |
| `video/voices.json` | the caller clip texts themselves; the sessions that spoke them are counted |
