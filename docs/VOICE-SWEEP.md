# Spoken sweep

Run 2026-09-26T15:03:22.545Z to 2026-09-26T15:27:04.964Z by `scripts/voice-sweep.ts`, from `sweep-2026-09-26T1148Z.json.gz`.

The first 30 servers of the registry sweep, in registry order, that listed their tools without auth, declare no auth, and have at least one read-only tool (`readOnlyHint: true`, or unannotated and not a write by the gate's classifier). Nothing was picked by hand.

Each server was connected afresh and asked the first of its starter questions (task 5: written by the LLM Gateway, or templates when it could not answer), spoken in a macOS `say` voice (Samantha) through a real Voice Agent session that could see only that server's read-only tools. No state-changing tool was exposed and no credential was sent. Sessions ran one at a time, each capped at 90 s, under a $5 budget.

Every starter was written before any session ran. When the Gateway rate-limited (this account's free plan answers 429 to more than a couple of calls a minute), the batch waited out its 60 s breaker and asked again, up to three tries; templates built from the tools' own descriptions were the fallback. A first run that did not wait got templates for 5 of its first 6 servers, and was stopped.

## Counts

| | count |
| --- | ---: |
| servers attempted | 30 |
| connected | 30 |
| starter from the LLM Gateway / from templates | 29 / 1 |
| voice sessions run | 29 |
| session failed to open (the API's own session.error) | 1 |
| a tool was called | 17 |
| MCP call succeeded / tool answered with an error / held by the gate | 14 / 3 / 0 |
| the agent answered out loud | 29 |
| median voice-to-voice, answered turns | 2597 ms |
| median voice-to-voice, turns that called a tool | 3540 ms (17 turns) |
| session time, and its cost at $4.50/hr | 482 s, $0.60 |

## Every server

| # | server | read-only tools | starter | tool called | MCP | answer | voice-to-voice | session_id |
| ---: | --- | ---: | --- | --- | --- | --- | ---: | --- |
| 1 | ac.tandem/docs-mcp | 13 of 13 | How do I install Tandem on my server? (gateway) | answer_how_to | ok | The best way to start is by installing the official CLI, engine, and TUI binaries using npm. You can find the step-by-step instructions on t | 3522 | `sess_3ccd4590dc7a475cae2cc713a8223091` |
| 2 | ad.inside/inside-ads | 2 of 3 | What is the status of my campaign draft? (gateway) | - | none | I can check that for you, but I'll need the draft ID. Do you have it handy or did you paste it in the box? | 1317 | `sess_ced62d66116a498597be1f9643d9c469` |
| 3 | ag.hood/name-service | 5 of 5 | What address does my hood name point to? (gateway, 2 tries) | - | none | I can look that up for you. What is your hood name? | 1809 | `sess_0f4813b71c9a4bbaa24f25c04679f721` |
| 4 | agency.goji/goji | 8 of 9 | What is SEO in plain English? (gateway) | goji_explain_term | ok | SEO is the work of making your website the result search engines choose to show. You do this by creating content that answers what people ar | 3967 | `sess_cc23fd40e3e04ca0be74999e9e68ed5b` |
| 5 | agency.ottobot/business-contact-finder | 1 of 1 | How do I contact the business at example.com? (gateway, 2 tries) | check_contact_path | ok | I'm sorry, I couldn't determine how to contact them because their contact form appears to be built with JavaScript, which I can't access. | 4298 | `sess_0d1b556eb8914c81ab1d928c1f0d4369` |
| 6 | agency.ottobot/contractor-license-changes | 2 of 2 | Did my contractor license change recently? (gateway) | - | none | I can check that for you. Please paste the license number and the state into the box. | 1783 | `sess_4ea9af2c3f824ad99ee0654f1baeb208` |
| 7 | agency.ottobot/licensed-house-painters | 2 of 3 | Find licensed house painters in Los Angeles (gateway, 2 tries) | search_painters | ok | I found a few licensed painters in Los Angeles, including 19346 Painting, 38th Parallel LLC, and 3M Painting Services. Would you like more d | 3951 | `sess_affdeee87cc1468095de2c39766aaca0` |
| 8 | ai.adoraads/beauty | 5 of 6 | What sponsored beauty products are available? (gateway) | - | none | I can certainly help you find some sponsored beauty products. To get started, could you tell me what kind of products you are looking for, l | 1334 | `sess_dfbc837097ad430792fe521c9708011c` |
| 9 | ai.advisorsai/service-navigator | 5 of 5 | What services do you offer? (gateway, 2 tries) | advisors_catalog_list_services | ok | We offer five main services, including Agent Governance Audits, measuring your share of AI answers, and our Decision Signal Engine. I can al | 2685 | `sess_b014c2cff7e740789313aca525dd27a5` |
| 10 | ai.advisorsai/store-readiness | 1 of 1 | Can you check the readiness of this store page? (gateway) | - | none | I can certainly help with that. Please paste the URL in the box under the Talk button so I can run the check. | 1238 | `sess_f8950109e8bf47eabef70cb945caca6b` |
| 11 | ai.afg/afg | 6 of 15 | What is the Agent Fulfillment Guarantee? (gateway, 2 tries) | afg_about | ok | The Agent Fulfillment Guarantee is a sandbox marketplace where AI agents hire other AI agents for verified outcomes. It uses a machine-check | 4584 | `sess_b825eb3ec2ae4a9fbaf8b7ea4943b2f8` |
| 12 | ai.afmr/discovery | 4 of 4 | What are the AFMR failure modes? (gateway) | lookup_failure_mode | error | I couldn't find a list of all failure modes with that search. Could you please tell me a specific failure mode name or an ID, like AFMR-F ze | 2597 | `sess_a29b8e7cb6e64e7e9c61ca8601995db8` |
| 13 | ai.agentberg/agentberg | 7 of 11 | What is my current reputation score? (gateway, 2 tries) | get_agent_status | ok | You don't have a reputation score yet. You'll need to publish a finding first, but there are six hundred sixty-three unrated findings in you | 3173 | `sess_5b7e2202413d40cfa9f1cbc77e1375b0` |
| 14 | ai.agenticfabricationnetwork/ufp | 10 of 13 | What is the price to 3D print my design? (gateway) | - | - | session failed to open: Internal service error | - | - |
| 15 | ai.agenticterminal/directory | 6 of 6 | What merchants accept cash in my area? (gateway, 2 tries) | - | none | I don't have access to your location. If you can tell me your city or zip code, I can search for merchants that way. | 1773 | `sess_d8fcef82946f4ba2961584fae24638b8` |
| 16 | ai.agentlookups/counterscript | 1 of 1 | What is the fair price for Tylenol? (gateway) | drug_price | ok | I couldn't find a price match for Tylenol in the database. This doesn't mean there isn't a fair price, but Tylenol is a brand name, and the | 3308 | `sess_8807b70805a946c0bc7ceac1361a56e4` |
| 17 | ai.agentlookups/greenlight | 2 of 2 | What is the solar law status for California? (gateway, 2 tries) | solar_law | ok | California is not currently in the GreenLight registry, so I don't have any information on its balcony solar laws. | 3846 | `sess_2a76e2cf57e347699549567ed95e718f` |
| 18 | ai.agentlookups/groundtruth | 3 of 3 | What can you do? (template) | - | none | I can check for federal environmental records like Superfund sites and toxic release facilities near a US location. I can also look up drink | 1359 | `sess_07a934c2d719424ab217afcd8ec78e2c` |
| 19 | ai.agentlookups/overassessed | 1 of 1 | Is my Maryland property assessment fair? (gateway, 2 tries) | - | none | I can check that for you, but I'll need an address and a zip code to get started. Please paste the address into the box or tell me what it i | 1356 | `sess_8d0b6aba45c248008d9eda66b73f2fbc` |
| 20 | ai.agentlookups/plumbline | 1 of 1 | Is this contractor licensed in my state? (gateway) | - | none | I can check that for you. Please tell me the name of the contractor or their license number, and which state you are in. | 1262 | `sess_d23b5a8f49704f1aa4fd2e89423903fb` |
| 21 | ai.agentrapay/agentra | 2 of 6 | What is my current trust score? (gateway, 2 tries) | agentra_get_wallet | ok | Your current trust score is 65. | 3540 | `sess_04fd5b31faf14b18b74666b23474a023` |
| 22 | ai.agentroam/agentroam | 8 of 11 | What travel gift cards are available for Airbnb? (gateway) | search_products | ok | You can get Airbnb gift cards for amounts between fifty and five hundred dollars. | 5438 | `sess_45bae9e4038f4ae9b72ca58f9cef6550` |
| 23 | ai.ai-akari/agent-trust-receipt | 1 of 2 | Can I check the AI trust receipt? (gateway, 2 tries) | get_agent_trust_receipt | ok | Yes, the trust receipt for the AIﾉアカリ☆ Result Receipt Auditor shows it has multi-provider conformance verified with development attestation. | 8306 | `sess_ca0f6b1194404730962ff641530485e4` |
| 24 | ai.ai-akari/one-minute-akari | 2 of 4 | What can I do in one minute? (gateway) | - | none | I am sorry, I am having trouble running that function right now. I will try to look into it for you. | 2211 | `sess_24cf57974b9441b5bd0f7bcfd2af50a6` |
| 25 | ai.ai-portal/ai-portal | 4 of 4 | When did the latest AI model ship? (gateway, 2 tries) | list_releases | ok | The latest model is GPT-6 Astra from OpenAI, which shipped on September third, twenty twenty-six. | 4508 | `sess_2fcfff2d3988436f9c898e5fee69f01f` |
| 26 | ai.aient/mcp | 2 of 2 | Create an Aient account with my email (gateway) | - | none | I can help with that. What email address should I use to create your account? | 1786 | `sess_2b0845e7a12c451ab3ebe84e4d7a8029` |
| 27 | ai.airshelf/catalog | 6 of 8 | What are the best laptops for data science? (gateway, 2 tries) | - | none | I can help you source hardware, but I don't have a catalog for consumer laptops. I specialize in professional equipment like printers, mecha | 1366 | `sess_37ec90c9eaad42a0bf4c66d3a91fdf51` |
| 28 | ai.aislabs/cve | 4 of 4 | What are the top CVEs today? (gateway) | top_cves_today | error | I'm sorry, I can't access that list right now because it requires a small payment of two cents or an AIS Gateway key. Would you like to see | 3191 | `sess_580aa6618fe04ac79bde5c77b9fd9c88` |
| 29 | ai.aislabs/gateway | 3 of 3 | What buildings are available? (gateway, 2 tries) | list_buildings | ok | There are two buildings available. First is ais-cve, which handles daily CVE prioritization, and second is ais-recorder, which provides the | 2337 | `sess_923c2cd1e31c4fbaa74104d51d5cbc2f` |
| 30 | ai.aislabs/recorder | 3 of 5 | Is my monitor still alive? (gateway) | fleet_status | error | I am unable to check your monitor because I do not have the required access key. Please paste the Gateway key into the box and I will try ag | 2026 | `sess_1eff2f44fe8e4f19b08fe4a27a5dc64e` |

Every `session_id` above can be looked up in AssemblyAI Session History; `data/voice-sweep-2026-09-26.json` holds each run in full.

