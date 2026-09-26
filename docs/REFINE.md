# What Gateway refinement costs a spoken turn

The A/B is `data/e2e-audio-refine-off.json` against `data/e2e-audio-refine-on.json`: the same six questions to the same presets. The last two rows count every spoken run in `data/e2e-audio*.json` (26 files). Recounted by `scripts/refine-report.ts`.

| | refinement off | refinement on |
| --- | ---: | ---: |
| tool-calling turns | 6 | 6 |
| calls the Gateway refined | 0 | 4 |
| Gateway time per refined call | - | 775 ms to 857 ms |
| median voice-to-voice | 4,016 ms | 4,678 ms |
| every spoken run: tool-calling turns with any audio before the tool result | 1 of 72 | |
| every spoken run: Gateway time per refined call | | 775 ms to 1,133 ms (12 calls) |
