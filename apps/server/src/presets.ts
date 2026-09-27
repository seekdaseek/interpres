/**
 * Demo presets: public MCP servers that need no auth.
 *
 * Every entry was probed live; `docs/SWEEP.md` records when and what came back.
 * interpres sends no auth header to anything, so an auth-walled server has
 * nothing to show here.
 */
export type Preset = {
  label: string;
  url: string;
  /** One line under the button. */
  blurb: string;
  /** Questions that are known to exercise a tool. */
  asks: string[];
  /** True when the catalog is over the 10-tool limit, so find_tools engages. */
  exercisesPhases?: boolean;
  /** Tools that change state. Shown as a warning; never auto-called. */
  writeTools?: string[];
  /** A value a judge can copy into the paste box to try the identifier flow. */
  sampleValue?: { label: string; value: string };
};

export const PRESETS: Preset[] = [
  {
    label: "AssemblyAI's own docs",
    url: 'https://www.assemblyai.com/docs/mcp',
    blurb: "3 tools. Ask it about the Voice Agent API you are talking through.",
    asks: [
      'What audio format does the Voice Agent API expect?',
      'How many tools can an agent have per phase?',
      'What happens if I change the greeting mid-session?',
    ],
    writeTools: ['submit_feedback'],
  },
  {
    label: 'AFG marketplace (sandbox)',
    url: 'https://afg.ai/mcp',
    // No count: the server grew from 15 to 18 tools; the point is only that it is over ten.
    blurb: 'More than ten tools, so find_tools has to swap the set. Test money only.',
    asks: [
      // Paste the sample address first: identifiers go by keyboard, intent by voice.
      'Check the reputation of the wallet I pasted.',
      // afg_speccheck is NOT in the opening phase, so this needs find_tools.
      // Verified spoken on 2026-09-26: the agent calls find_tools itself.
      'I want to run a spec check on a job contract.',
      'What does the contract template for a passing test suite look like?',
    ],
    // The EIP-55 test vector: a valid checksummed address, nobody's wallet.
    sampleValue: { label: 'Copy sample address', value: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' },
    // Not suggested in the UI: a spoken 40-character hex address. Speech-to-text
    // mis-hears it (see BUILDLOG, e2e-audio), so it makes a bad first impression.
    exercisesPhases: true,
    writeTools: ['afg_create_wallet', 'afg_post_job', 'afg_sign_contract', 'afg_fund', 'afg_submit', 'afg_dispute', 'afg_appeal', 'afg_upload_artifact', 'afg_discard_wallet'],
  },
  {
    label: 'AdvisorsAI service navigator',
    url: 'https://advisorsai.ai/mcp',
    blurb: '5 tools with enum and example hints on every argument.',
    asks: [
      'What services do you have?',
      'I need an audit trail for my agents - what fits?',
      'Check the basics of my site.',
    ],
  },
  // The three below were picked from the Sep 26 registry sweep (docs/SWEEP.md):
  // no auth declared or met, ok in both passes an hour apart, and every ask
  // answered when spoken through scripts/e2e-audio.ts.
  {
    label: 'Most Recommended Books',
    url: 'https://mostrecommendedbooks.com/api/mcp',
    blurb: '6 read-only tools: who recommends what, and series reading orders.',
    asks: [
      'What books does Bill Gates recommend?',
      'What is the reading order for the Dune series?',
      'Who recommends Sapiens?',
    ],
  },
  {
    label: 'Recipes Daily',
    url: 'https://recipes-daily.com/mcp',
    blurb: '3 read-only tools. Say what is in your fridge.',
    asks: ['What can I cook with chicken, rice and spinach?'],
  },
  {
    label: 'US weather and earthquakes',
    url: 'https://weather.datakoot.com/mcp',
    blurb: '6 tools over National Weather Service and USGS data.',
    // Not suggested: a city forecast. It chains geocode, which took 9.3 s spoken.
    asks: [
      'Are there any weather alerts in Florida right now?',
      'Were there any earthquakes above magnitude five in the last week?',
    ],
  },
];

export function presetFor(url: string): Preset | undefined {
  return PRESETS.find((p) => p.url === url);
}
