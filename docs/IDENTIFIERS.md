# Spoken wallet addresses

Every recorded attempt to speak a wallet address, from every source in `data/`, recounted by `scripts/spoken-identifiers.ts`. "Ran" is whether the address reached an MCP server: a misheard value ran in 5 of them, all from before the gate held spoken identifiers (decision D4).

Exact: 0 of 9.

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

## Files in data/ that hold an address but are not counted

| file | why |
| --- | --- |
| `e2e-audio-gate-paste-d4.json` | the address was pasted, not spoken |
| `e2e-audio-gate-paste.json` | the address was pasted, not spoken |
| `e2e-checkpoint-a.json` | text injected with conversation.message (scripts/e2e.ts), not speech |
| `qa-audio/clips.json` | the clip texts themselves, counted through the QA record |
| `sweep-2026-09-26T1148Z-summary.json` | an address inside a registry server description; nothing was spoken |
| `sweep-2026-09-26T1252Z-recheck-summary.json` | an address inside a registry server description; nothing was spoken |
