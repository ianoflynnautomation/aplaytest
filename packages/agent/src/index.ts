/**
 * @aplaytest/agent — the model tier.
 *
 * Two bounded agents, both of which propose rather than decide:
 *   · repair — ranks pre-verified locator candidates; Playwright re-runs the pick
 *   · author — plans and drafts a test; the falsifiability gate accepts or rejects it
 *
 * The model orders; Playwright decides.
 */

export { runRepairAgent, RepairChoiceSchema, REPAIR_SYSTEM_PROMPT } from './repair.js';
export type {
  RepairInput,
  RepairOutcome,
  RepairChoice,
  RepairCandidate,
  RepairOptions,
} from './repair.js';

export {
  runAuthorAgent,
  AuthorPlanSchema,
  AuthorDraftSchema,
  PLAN_SYSTEM_PROMPT,
  SYNTHESIZE_SYSTEM_PROMPT,
} from './author.js';
export type {
  AuthorInput,
  AuthorOutcome,
  AuthorPlan,
  AuthorDraft,
  AuthorGrounding,
  AuthorOptions,
} from './author.js';
