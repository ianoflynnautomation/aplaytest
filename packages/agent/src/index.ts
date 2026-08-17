/**
 * @atest/agent — the model tier.
 *
 * Deliberately narrow for now: one bounded agent that RANKS pre-verified
 * options. It is handed candidates a deterministic engine already checked
 * against a live page, and whatever it picks is re-run before anything is
 * proposed. The model orders; Playwright decides.
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
