import { describe, expect, it } from 'vitest';

import {
  parseLocator,
  stabilityDelta,
  testIdDistance,
  STABILITY_RANK,
} from '../src/locator/stability.js';

describe('parseLocator', () => {
  it('recognises the durable strategies', () => {
    expect(parseLocator("getByTestId('gym-card-name')")).toMatchObject({
      strategy: 'testid',
      value: 'gym-card-name',
    });
    expect(parseLocator("getByRole('heading', { name: 'Gyms' })")).toMatchObject({
      strategy: 'role',
      value: 'heading',
    });
    expect(parseLocator('[data-testid="gyms-list-item"]')).toMatchObject({
      strategy: 'testid',
      value: 'gyms-list-item',
    });
  });

  it('falls back to css rather than guessing a durable strategy', () => {
    // An unparsed locator must never be mistaken for a stable one, so the
    // fallback is deliberately the low-ranked strategy.
    expect(parseLocator('div.card > span:nth-child(2)')?.strategy).toBe('css');
  });

  it('returns null for absent input instead of a fabricated locator', () => {
    expect(parseLocator(null)).toBeNull();
    expect(parseLocator(undefined)).toBeNull();
    expect(parseLocator('   ')).toBeNull();
  });
});

describe('stabilityDelta', () => {
  it('is zero for a like-for-like test id rename', () => {
    expect(stabilityDelta('testid', 'testid')).toBe(0);
  });

  it('is negative when a heal would weaken the locator', () => {
    // testid → text is the classic "makes it pass, makes it worse" heal.
    expect(stabilityDelta('testid', 'text')).toBeLessThan(0);
  });

  it('is positive when a heal strengthens the locator', () => {
    expect(stabilityDelta('css', 'testid')).toBeGreaterThan(0);
  });

  it('ranks xpath as the least durable option', () => {
    const ranks = Object.values(STABILITY_RANK);
    expect(STABILITY_RANK.xpath).toBe(Math.max(...ranks));
    expect(STABILITY_RANK.testid).toBe(Math.min(...ranks));
  });
});

describe('testIdDistance', () => {
  it('is zero for identical ids', () => {
    expect(testIdDistance('gym-card-name', 'gym-card-name')).toBe(0);
  });

  it('scores a plausible rename far closer than an unrelated id', () => {
    const rename = testIdDistance('gym-card-name', 'gym-card-title');
    const unrelated = testIdDistance('gym-card-name', 'checkout-submit-button');
    expect(rename).toBeLessThan(unrelated);
    expect(rename).toBeLessThan(0.5);
  });

  it('ranks a same-container rename ahead of a same-element move to another feature', () => {
    // Elements are renamed far more often than they move between features,
    // so prefix disagreement must cost more than suffix disagreement.
    const sameContainer = testIdDistance('gym-card-name', 'gym-card-title');
    const otherFeature = testIdDistance('gym-card-name', 'event-card-name');
    expect(sameContainer).toBeLessThan(otherFeature);
  });

  it('scores a rename and a sibling field identically, because the string cannot tell them apart', () => {
    // Honest tie. Separating these is the Tier-1 ranker's job, using the
    // failing assertion's domain arguments — not the string metric's.
    expect(testIdDistance('gym-card-name', 'gym-card-title')).toBe(
      testIdDistance('gym-card-name', 'gym-card-county'),
    );
  });

  it('keeps a plausible rename under the 0.4 candidate-filter threshold', () => {
    // The heal engine discards candidates above 0.4; the canonical rename
    // case must comfortably survive that filter.
    expect(testIdDistance('gym-card-name', 'gym-card-title')).toBeLessThan(0.4);
  });

  it('never exceeds 1', () => {
    expect(testIdDistance('a', 'completely-different-thing-entirely')).toBeLessThanOrEqual(1);
  });
});
