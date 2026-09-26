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
    blurb: '15 tools, so find_tools has to swap the set. Test money only.',
    asks: [
      // afg_about is NOT in the opening phase, so answering this needs
      // find_tools first. "from the service itself" is what stops the agent
      // paraphrasing the server description already in its system prompt.
      'Look up the official job flow and the limits from the service itself.',
      'What is the reputation of wallet 0x0000000000000000000000000000000000000001?',
      'What does the contract template for a passing test suite look like?',
    ],
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
];

export function presetFor(url: string): Preset | undefined {
  return PRESETS.find((p) => p.url === url);
}
