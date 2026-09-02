/**
 * @aplaytest/author — deterministic verification for generated tests.
 *
 * The model tier lives in @aplaytest/agent and only ever PROPOSES. This package
 * decides, and it decides without consulting a model: a generated test is
 * trustworthy when it passes reliably and fails when the world breaks.
 */

export { falsifiabilityGate, evaluateGate } from './gate.js';
export type {
  GateOptions,
  GateResult,
  GateCheck,
  CheckName,
  MutantOutcome,
  EvaluateInput,
} from './gate.js';

export { buildMutants, applyMutant, stripMutant, hasMutant, MEANINGFUL_CLASSES } from './mutants.js';
export type { Mutant, MutantName, MutantClass, MutantOptions } from './mutants.js';

export { ground } from './ground.js';
export type { GroundingBundle, GroundOptions, ExemplarSpec } from './ground.js';
