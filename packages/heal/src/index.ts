/**
 * @atest/heal — selector healing.
 *
 * Tier 0 only, and entirely deterministic: candidates come from the test-id
 * index captured at failure time, and acceptance comes from re-running the
 * test. A model tier would RANK these candidates by intent; it is never the
 * thing that decides.
 *
 * Three guards hold regardless of configuration:
 *   · kinds in NEVER_HEAL are refused outright (a schema violation or an
 *     uncaught app error IS the bug — repairing it destroys the signal)
 *   · a candidate weaker than the stability floor is never generated
 *   · no patch is accepted without a full validation pass
 */

export { patchConstant, findConstant } from './patch.js';
export type { PatchInput, PatchResult, PatchStatus, TouchedConstant } from './patch.js';

export {
  generateCandidates,
  assessBundle,
  missingTestIds,
  testIdsIn,
  parseAriaSnapshot,
  DEFAULT_CANDIDATE_OPTIONS,
} from './candidates.js';
export type { HealCandidate, CandidateOptions, HealEligibility, AriaNode } from './candidates.js';

export {
  resolveSelectorSource,
  classifyHealTarget,
  globToRegExp,
  DEFAULT_HEAL_TARGET_GLOBS,
} from './resolve.js';
export type { HealTargetKind, ResolvedSelectorSource } from './resolve.js';

export { validateHeal } from './validate.js';
export type { ValidateOptions, ValidationRecord, ValidationStatus } from './validate.js';

export { proposeHeal, DEFAULT_HEAL_OPTIONS } from './propose.js';
export type { HealProposal, ProposeOptions, TierOneRecord, ProposalStatus } from './propose.js';

export {
  buildRecord,
  writeRecord,
  readRecords,
  revertHeal,
  healId,
  DEFAULT_LEDGER_DIR,
  HEAL_SCHEMA_VERSION,
} from './ledger.js';
export type { HealRecord, HealStatus, RevertResult } from './ledger.js';
