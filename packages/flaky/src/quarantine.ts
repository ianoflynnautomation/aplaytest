/**
 * Quarantine policy.
 *
 * A quarantine without an expiry is a deletion with extra steps, and a
 * quarantine list without a budget becomes the default response to any red
 * build. Both limits are enforced here so the convention is mechanical rather
 * than aspirational — "fix or delete promptly" is not a thing a policy
 * document can make true.
 */

export interface QuarantineEntry {
  readonly testId: string;
  /** Null means every project. */
  readonly project: string | null;
  readonly title: string;
  readonly reason: string;
  readonly flakeScore: number;
  readonly rootCause: string;
  readonly issueUrl: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Recorded when an expiry is extended, so extensions are auditable. */
  readonly justification: string | null;
}

export interface QuarantinePolicy {
  readonly expiryDays: number;
  readonly maxTests: number;
  /** Cap as a share of the suite; the effective cap is the larger of the two. */
  readonly maxRatio: number;
}

export const DEFAULT_QUARANTINE_POLICY: QuarantinePolicy = {
  expiryDays: 14,
  maxTests: 5,
  maxRatio: 0.02,
};

export interface PolicyViolation {
  readonly kind: 'expired' | 'budget-exceeded';
  readonly message: string;
  readonly testIds: readonly string[];
}

export interface PolicyResult {
  readonly ok: boolean;
  readonly violations: readonly PolicyViolation[];
  readonly active: number;
  readonly budget: number;
  readonly expired: readonly QuarantineEntry[];
  /** Sorted soonest-first, for the "expiring shortly" warning. */
  readonly expiringSoon: readonly QuarantineEntry[];
}

const MS_PER_DAY = 86_400_000;
const EXPIRING_SOON_DAYS = 3;

export function effectiveBudget(suiteSize: number, policy: QuarantinePolicy): number {
  return Math.max(policy.maxTests, Math.floor(suiteSize * policy.maxRatio));
}

export function daysUntilExpiry(entry: QuarantineEntry, now: number = Date.now()): number {
  return (Date.parse(entry.expiresAt) - now) / MS_PER_DAY;
}

export function expiryFor(policy: QuarantinePolicy, now: number = Date.now()): string {
  return new Date(now + policy.expiryDays * MS_PER_DAY).toISOString();
}

/**
 * Evaluate the whole quarantine list. Returns violations rather than throwing,
 * so a caller can print them all at once instead of failing on the first —
 * being told about one problem at a time is how a CI gate becomes hated.
 */
export function evaluateQuarantinePolicy(
  entries: readonly QuarantineEntry[],
  suiteSize: number,
  policy: QuarantinePolicy = DEFAULT_QUARANTINE_POLICY,
  now: number = Date.now(),
): PolicyResult {
  const violations: PolicyViolation[] = [];

  const expired = entries.filter(e => daysUntilExpiry(e, now) < 0);
  if (expired.length > 0) {
    violations.push({
      kind: 'expired',
      message:
        `${expired.length} quarantine${expired.length === 1 ? '' : 's'} past expiry. ` +
        'Quarantines expire so they get fixed: release the test, extend with a written ' +
        'justification, or delete it.',
      testIds: expired.map(e => e.testId),
    });
  }

  const budget = effectiveBudget(suiteSize, policy);
  if (entries.length > budget) {
    violations.push({
      kind: 'budget-exceeded',
      message:
        `${entries.length} quarantined tests exceeds the budget of ${budget} ` +
        `(max(${policy.maxTests}, ${(policy.maxRatio * 100).toFixed(0)}% of ${suiteSize}). ` +
        'Fix one before quarantining another.',
      testIds: entries.map(e => e.testId),
    });
  }

  const expiringSoon = entries
    .filter(e => {
      const days = daysUntilExpiry(e, now);
      return days >= 0 && days <= EXPIRING_SOON_DAYS;
    })
    .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));

  return {
    ok: violations.length === 0,
    violations,
    active: entries.length,
    budget,
    expired,
    expiringSoon,
  };
}

/**
 * The tag comment written above a quarantined test.
 *
 * Self-documenting and greppable on purpose: whoever finds this in six months
 * should not have to open a dashboard to learn why it is here or when it
 * should have been dealt with.
 */
export function renderQuarantineComment(entry: QuarantineEntry, atestVersion: string): string[] {
  return [
    `@quarantine ${entry.reason}`,
    `flakeScore ${entry.flakeScore.toFixed(2)} · class ${entry.rootCause}`,
    `expires ${entry.expiresAt.slice(0, 10)}  ·  ${entry.issueUrl ?? 'no issue linked'}`,
    `added by atest ${atestVersion}`,
  ];
}
