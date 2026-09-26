# Proof from Session History

Every `session_id` recorded in `data/*.json`, read back from AssemblyAI's Session History (`GET /v1/sessions/{id}` and its timeline artifact) at 2026-09-26T15:29:56.290Z by `scripts/proof.ts`. None of these numbers come from interpres's own logs.

| | |
| --- | ---: |
| sessions | 93 |
| tool calls | 136 |
| tool calls answered with no error flag (Session History `is_error`) | 136 of 136 (100.0%) |
| median tool latency | 936 ms (n=135) |
| median time to first audio | 881 ms (n=14 turns that report it) |
| session time | 2307 s |
| cost, computed from the published $4.50/hr (not read from a bill) | $2.88 |

`is_error` marks a tool.result the agent received as an error. interpres hands a tool's own error back as a result the agent can speak, so a tool that answered "nothing found" or "needs a key" counts as answered here: the spoken sweep counts those separately (docs/VOICE-SWEEP.md).

Session History reports time to first audio for greetings and tool-free turns only; a turn that calls a tool carries no reply start and no time to first audio (see the README, "Measured against the docs").

## By data file

| data file | sessions | tool calls | errors | seconds |
| --- | ---: | ---: | ---: | ---: |
| `e2e-2026-09-26094611.json` | 1 | 1 | 0 | 2 |
| `e2e-2026-09-26094825.json` | 1 | 1 | 0 | 19 |
| `e2e-2026-09-26095019.json` | 3 | 4 | 0 | 78 |
| `e2e-2026-09-26095152.json` | 1 | 2 | 0 | 23 |
| `e2e-audio-afg-baseline.json` | 1 | 0 | 0 | 68 |
| `e2e-audio-afg-natural.json` | 1 | 3 | 0 | 39 |
| `e2e-audio-afg-nocarry.json` | 1 | 1 | 0 | 25 |
| `e2e-audio-afg-phase-carry.json` | 1 | 2 | 0 | 27 |
| `e2e-audio-afg-phase-nocarry.json` | 1 | 2 | 0 | 26 |
| `e2e-audio-bargein-facts.json` | 1 | 1 | 0 | 18 |
| `e2e-audio-bargein.json` | 1 | 1 | 0 | 23 |
| `e2e-audio-ended.json` | 1 | 1 | 0 | 19 |
| `e2e-audio-execmode.json` | 6 | 14 | 0 | 205 |
| `e2e-audio-gate-paste-d4.json` | 1 | 2 | 0 | 16 |
| `e2e-audio-gate-paste.json` | 1 | 2 | 0 | 16 |
| `e2e-audio-gate-spoken-d4.json` | 1 | 1 | 0 | 34 |
| `e2e-audio-gate-spoken.json` | 1 | 2 | 0 | 36 |
| `e2e-audio-ochinimus-ab.json` | 6 | 6 | 0 | 130 |
| `e2e-audio-phrase.json` | 3 | 8 | 0 | 107 |
| `e2e-audio-preset-books-3.json` | 1 | 1 | 0 | 14 |
| `e2e-audio-preset-books.json` | 1 | 2 | 0 | 40 |
| `e2e-audio-preset-recipes.json` | 1 | 3 | 0 | 40 |
| `e2e-audio-preset-weather-alerts.json` | 1 | 1 | 0 | 18 |
| `e2e-audio-preset-weather.json` | 1 | 3 | 0 | 37 |
| `e2e-audio-presets.json` | 3 | 6 | 0 | 116 |
| `e2e-audio-refine-off.json` | 3 | 8 | 0 | 111 |
| `e2e-audio-refine-on.json` | 3 | 6 | 0 | 104 |
| `e2e-audio-replycheck.json` | 1 | 1 | 0 | 21 |
| `e2e-audio-warm-off.json` | 6 | 13 | 0 | 184 |
| `e2e-audio-warm-on.json` | 6 | 13 | 0 | 179 |
| `e2e-checkpoint-a.json` | 3 | 7 | 0 | 81 |
| `e2e-text-smoke.json` | 1 | 1 | 0 | 17 |
| `voice-sweep-2026-09-26.json` | 29 | 17 | 0 | 433 |

## Every session

| session_id | data file | status | seconds | tool calls | errors | median tool ms |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| `sess_25c978efd9214a80982eb5fd7cd91010` | e2e-2026-09-26094611.json | completed | 1.9 | 1 | 0 | - |
| `sess_140f408b2a034f0ca12dfbedc67a6eb8` | e2e-2026-09-26094825.json | completed | 18.6 | 1 | 0 | 3119 |
| `sess_4cf175fc117b4fd085894ce23c43be7e` | e2e-2026-09-26095019.json | completed | 15.3 | 0 | 0 | - |
| `sess_8c9aaf3c67c6496f94b43b297ed4023f` | e2e-2026-09-26095019.json | completed | 31.6 | 2 | 0 | 1846 |
| `sess_e0416fefcb5b48d189ab62aa1645ba76` | e2e-2026-09-26095019.json | completed | 31.0 | 2 | 0 | 2301 |
| `sess_e8bb8b0f78b14b6c9b6ef6ae9ce3f42f` | e2e-2026-09-26095152.json | completed | 23.0 | 2 | 0 | 1876 |
| `sess_2d559d4f8c5f4a54a19704b7f5902895` | e2e-audio-afg-baseline.json | completed | 68.5 | 0 | 0 | - |
| `sess_545bb78a858f41bebe3b5f6135b11524` | e2e-audio-afg-natural.json | completed | 39.0 | 3 | 0 | 368 |
| `sess_72ded57c42ea46b98af12f36a90d2282` | e2e-audio-afg-nocarry.json | completed | 24.9 | 1 | 0 | 1334 |
| `sess_a22027d3092e4992a387619ba232817d` | e2e-audio-afg-phase-carry.json | completed | 27.3 | 2 | 0 | 861 |
| `sess_8f118a8d2bb145fc994d5affaa99a3f3` | e2e-audio-afg-phase-nocarry.json | completed | 26.0 | 2 | 0 | 1248 |
| `sess_572712169f594470999191b96918affb` | e2e-audio-bargein-facts.json | completed | 18.5 | 1 | 0 | 1581 |
| `sess_b3d6adc6f2594c948f817e73f900cb2b` | e2e-audio-bargein.json | completed | 22.7 | 1 | 0 | 1582 |
| `sess_11e6597b5a6a4b96945eff34cb9911cc` | e2e-audio-ended.json | completed | 18.8 | 1 | 0 | 591 |
| `sess_5fba3a877f5b4a3d9ade2532d6d7c9ba` | e2e-audio-execmode.json | completed | 43.9 | 2 | 0 | 996 |
| `sess_8215c429e4d34b08a94a272f9156cb0d` | e2e-audio-execmode.json | completed | 20.6 | 2 | 0 | 348 |
| `sess_8dfc36d82b21496781ff85d48145ad04` | e2e-audio-execmode.json | completed | 39.1 | 2 | 0 | 429 |
| `sess_ea1c89987ca14e8c962c58cfa4aaf595` | e2e-audio-execmode.json | completed | 32.0 | 2 | 0 | 434 |
| `sess_ef77c48ce29f4cc589050881f62bf9c1` | e2e-audio-execmode.json | completed | 26.1 | 2 | 0 | 317 |
| `sess_fc31e4e1ef8f4503acdda9b5e9b8b135` | e2e-audio-execmode.json | completed | 43.4 | 4 | 0 | 814 |
| `sess_5ddb040c77e24c3181d6d7cb60799b10` | e2e-audio-gate-paste-d4.json | completed | 16.5 | 2 | 0 | 1139 |
| `sess_a8124ef3931d4db29020c227d0aebe4e` | e2e-audio-gate-paste.json | completed | 16.3 | 2 | 0 | 952 |
| `sess_2762c5ea28bc4b1f99dbe0a3c2b8fe4f` | e2e-audio-gate-spoken-d4.json | completed | 33.8 | 1 | 0 | 369 |
| `sess_c7ecda9ca1ca4a3f8eebfb18378bd139` | e2e-audio-gate-spoken.json | completed | 35.5 | 2 | 0 | 800 |
| `sess_5096d3fc6b784aa58bf374fa5369e718` | e2e-audio-ochinimus-ab.json | completed | 18.9 | 1 | 0 | 3266 |
| `sess_9e26b21330564db5b3b68c8c65036c69` | e2e-audio-ochinimus-ab.json | completed | 23.8 | 1 | 0 | 5419 |
| `sess_dca021bae2074e9c9b4163b332c9ba3d` | e2e-audio-ochinimus-ab.json | completed | 20.1 | 1 | 0 | 3435 |
| `sess_dcb13300d5e24a74b037cb79e17094f0` | e2e-audio-ochinimus-ab.json | completed | 18.8 | 1 | 0 | 3255 |
| `sess_debb391ad86b4e10a3ca4893305b5c81` | e2e-audio-ochinimus-ab.json | completed | 24.8 | 1 | 0 | 5328 |
| `sess_f5d1ecbd29bc44f8bd1000e31258cdce` | e2e-audio-ochinimus-ab.json | completed | 23.8 | 1 | 0 | 4994 |
| `sess_3021cf7d0f014e1da557444da228b26e` | e2e-audio-phrase.json | completed | 40.8 | 4 | 0 | 1349 |
| `sess_bd2af132d4264dbfb1b86430c1481d5e` | e2e-audio-phrase.json | completed | 29.1 | 2 | 0 | 983 |
| `sess_d006c824c40d44d0a9ae0715e7a54130` | e2e-audio-phrase.json | completed | 37.4 | 2 | 0 | 761 |
| `sess_89290181f71448059d126d36bdd5b446` | e2e-audio-preset-books-3.json | completed | 13.5 | 1 | 0 | 611 |
| `sess_4e6cc252c2cb4754adec545d0a36824f` | e2e-audio-preset-books.json | completed | 40.0 | 2 | 0 | 929 |
| `sess_4e52b65cfa624609ac476f193dcb0bf2` | e2e-audio-preset-recipes.json | completed | 39.9 | 3 | 0 | 626 |
| `sess_881bbf9500f44fb59336c7d231aaf7a2` | e2e-audio-preset-weather-alerts.json | completed | 17.9 | 1 | 0 | 982 |
| `sess_e19fc82bc077400ab8562205b4f99ae2` | e2e-audio-preset-weather.json | completed | 37.5 | 3 | 0 | 1825 |
| `sess_0c192f37d80b4d5e988dfc441cc4022c` | e2e-audio-presets.json | completed | 43.9 | 2 | 0 | 1543 |
| `sess_21d1ed7300ff482eac00c7b2e58358fa` | e2e-audio-presets.json | completed | 38.0 | 2 | 0 | 2210 |
| `sess_7afa10015afd46198788fcc811386574` | e2e-audio-presets.json | completed | 33.7 | 2 | 0 | 1565 |
| `sess_b3eca575280b42158852c9a0d5bae644` | e2e-audio-refine-off.json | completed | 39.8 | 4 | 0 | 1361 |
| `sess_cf30a7f51b2f4442a32c551d9de2050f` | e2e-audio-refine-off.json | completed | 33.4 | 2 | 0 | 1017 |
| `sess_da2d378f267e4cacbe8cfa7e76d2e8e7` | e2e-audio-refine-off.json | completed | 38.1 | 2 | 0 | 696 |
| `sess_2d2a6ace12ee411c8bac8330493ee72b` | e2e-audio-refine-on.json | completed | 33.6 | 2 | 0 | 1530 |
| `sess_3f904f42821440638503e6c8c5cdb1b3` | e2e-audio-refine-on.json | completed | 34.9 | 2 | 0 | 1267 |
| `sess_be284d1e94b640ef8dcd7ccc3807731b` | e2e-audio-refine-on.json | completed | 35.8 | 2 | 0 | 2201 |
| `sess_dee93b825e4a41f48a0bc5a63e7059aa` | e2e-audio-replycheck.json | completed | 20.7 | 1 | 0 | 1770 |
| `sess_1041022116ca4526a74daa78f06ff836` | e2e-audio-warm-off.json | completed | 30.7 | 2 | 0 | 802 |
| `sess_31ba0f4801264ed09f582f18b17fcf71` | e2e-audio-warm-off.json | completed | 23.5 | 2 | 0 | 319 |
| `sess_42dfe7cdb5a34219ac99836d02468a42` | e2e-audio-warm-off.json | completed | 41.6 | 3 | 0 | 1893 |
| `sess_6125246dca5c4ce0b78092088bbe8d0a` | e2e-audio-warm-off.json | completed | 18.5 | 2 | 0 | 484 |
| `sess_75713d30db2342da913a9dff406f92c7` | e2e-audio-warm-off.json | completed | 34.5 | 2 | 0 | 849 |
| `sess_eed74a5adb9843519fdfef293c7d4d15` | e2e-audio-warm-off.json | completed | 35.5 | 2 | 0 | 1014 |
| `sess_5623edf76d4f4c37b81419e8372e9b42` | e2e-audio-warm-on.json | completed | 24.9 | 2 | 0 | 311 |
| `sess_5d91b31b639e450d9a6ee9bbe1f70258` | e2e-audio-warm-on.json | completed | 30.6 | 2 | 0 | 429 |
| `sess_b0a39ba6f1754c4b8799c6790bdfdfc1` | e2e-audio-warm-on.json | completed | 31.0 | 3 | 0 | 638 |
| `sess_d340e7fa9fda4f4b9aa95bc1f781a597` | e2e-audio-warm-on.json | completed | 22.7 | 2 | 0 | 361 |
| `sess_e9a40d7c718e4fe4bcf089e35c0e3e6d` | e2e-audio-warm-on.json | completed | 32.5 | 2 | 0 | 434 |
| `sess_fccb439982b848978c504e97ebdf6c33` | e2e-audio-warm-on.json | completed | 37.5 | 2 | 0 | 518 |
| `sess_06c5d355662c4b2ba5946a95935d19e5` | e2e-checkpoint-a.json | completed | 24.5 | 3 | 0 | 361 |
| `sess_2d0a2ac965374eabace6c4cdda42d1d7` | e2e-checkpoint-a.json | completed | 30.0 | 2 | 0 | 2267 |
| `sess_6f5d5ea0c2e6488b8b1946fe4bf9b305` | e2e-checkpoint-a.json | completed | 27.0 | 2 | 0 | 1664 |
| `sess_e9a348dba30146e4a2a165e21902020f` | e2e-text-smoke.json | completed | 17.2 | 1 | 0 | 1459 |
| `sess_04fd5b31faf14b18b74666b23474a023` | voice-sweep-2026-09-26.json | completed | 9.3 | 1 | 0 | 1182 |
| `sess_07a934c2d719424ab217afcd8ec78e2c` | voice-sweep-2026-09-26.json | completed | 16.9 | 0 | 0 | - |
| `sess_0d1b556eb8914c81ab1d928c1f0d4369` | voice-sweep-2026-09-26.json | completed | 15.9 | 1 | 0 | 320 |
| `sess_0f4813b71c9a4bbaa24f25c04679f721` | voice-sweep-2026-09-26.json | completed | 8.3 | 0 | 0 | - |
| `sess_1eff2f44fe8e4f19b08fe4a27a5dc64e` | voice-sweep-2026-09-26.json | completed | 12.6 | 1 | 0 | 371 |
| `sess_24cf57974b9441b5bd0f7bcfd2af50a6` | voice-sweep-2026-09-26.json | completed | 10.3 | 0 | 0 | - |
| `sess_2a76e2cf57e347699549567ed95e718f` | voice-sweep-2026-09-26.json | completed | 12.8 | 1 | 0 | 501 |
| `sess_2b0845e7a12c451ab3ebe84e4d7a8029` | voice-sweep-2026-09-26.json | completed | 9.4 | 0 | 0 | - |
| `sess_2fcfff2d3988436f9c898e5fee69f01f` | voice-sweep-2026-09-26.json | completed | 14.4 | 1 | 0 | 936 |
| `sess_37ec90c9eaad42a0bf4c66d3a91fdf51` | voice-sweep-2026-09-26.json | completed | 15.8 | 0 | 0 | - |
| `sess_3ccd4590dc7a475cae2cc713a8223091` | voice-sweep-2026-09-26.json | completed | 19.6 | 1 | 0 | 331 |
| `sess_45bae9e4038f4ae9b72ca58f9cef6550` | voice-sweep-2026-09-26.json | completed | 14.2 | 1 | 0 | 1991 |
| `sess_4ea9af2c3f824ad99ee0654f1baeb208` | voice-sweep-2026-09-26.json | completed | 10.4 | 0 | 0 | - |
| `sess_580aa6618fe04ac79bde5c77b9fd9c88` | voice-sweep-2026-09-26.json | completed | 15.5 | 1 | 0 | 609 |
| `sess_5b7e2202413d40cfa9f1cbc77e1375b0` | voice-sweep-2026-09-26.json | completed | 16.1 | 1 | 0 | 690 |
| `sess_8807b70805a946c0bc7ceac1361a56e4` | voice-sweep-2026-09-26.json | completed | 17.3 | 1 | 0 | 487 |
| `sess_8d0b6aba45c248008d9eda66b73f2fbc` | voice-sweep-2026-09-26.json | completed | 12.1 | 0 | 0 | - |
| `sess_923c2cd1e31c4fbaa74104d51d5cbc2f` | voice-sweep-2026-09-26.json | completed | 15.2 | 1 | 0 | 599 |
| `sess_a29b8e7cb6e64e7e9c61ca8601995db8` | voice-sweep-2026-09-26.json | completed | 15.4 | 1 | 0 | 327 |
| `sess_affdeee87cc1468095de2c39766aaca0` | voice-sweep-2026-09-26.json | completed | 20.4 | 1 | 0 | 509 |
| `sess_b014c2cff7e740789313aca525dd27a5` | voice-sweep-2026-09-26.json | completed | 18.1 | 1 | 0 | 556 |
| `sess_b825eb3ec2ae4a9fbaf8b7ea4943b2f8` | voice-sweep-2026-09-26.json | completed | 25.0 | 1 | 0 | 991 |
| `sess_ca0f6b1194404730962ff641530485e4` | voice-sweep-2026-09-26.json | completed | 26.4 | 1 | 0 | 5849 |
| `sess_cc23fd40e3e04ca0be74999e9e68ed5b` | voice-sweep-2026-09-26.json | completed | 22.5 | 1 | 0 | 921 |
| `sess_ced62d66116a498597be1f9643d9c469` | voice-sweep-2026-09-26.json | completed | 10.3 | 0 | 0 | - |
| `sess_d23b5a8f49704f1aa4fd2e89423903fb` | voice-sweep-2026-09-26.json | completed | 10.7 | 0 | 0 | - |
| `sess_d8fcef82946f4ba2961584fae24638b8` | voice-sweep-2026-09-26.json | completed | 11.9 | 0 | 0 | - |
| `sess_dfbc837097ad430792fe521c9708011c` | voice-sweep-2026-09-26.json | completed | 14.6 | 0 | 0 | - |
| `sess_f8950109e8bf47eabef70cb945caca6b` | voice-sweep-2026-09-26.json | completed | 11.1 | 0 | 0 | - |

