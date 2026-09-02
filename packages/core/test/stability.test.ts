import { describe, expect, it } from 'vitest';

import {
  parseLocator,
  stabilityDelta,
  testIdDistance,
  STABILITY_RANK,
} from '../src/locator/stability.js';

describe('parseLocator', () => {
  it('given getByTestId, getByRole with and without a name, and a data-testid selector -> when parseLocator runs -> then each durable strategy and its value are recognised', { tags: ['@unit', '@locator-stability'] }, () => {
    expect(parseLocator("getByTestId('gym-card-name')")).toMatchObject({
      strategy: 'testid',
      value: 'gym-card-name',
    });
    expect(parseLocator("getByRole('heading', { name: 'Gyms' })")).toMatchObject({
      strategy: 'role',
      value: 'heading',
      accessibleName: 'Gyms',
    });
    expect(parseLocator("getByRole('button')")).toMatchObject({
      strategy: 'role',
      value: 'button',
      accessibleName: null,
    });
    expect(parseLocator('[data-testid="gyms-list-item"]')).toMatchObject({
      strategy: 'testid',
      value: 'gyms-list-item',
    });
  });

  it('given an unparsed css selector -> when parseLocator runs -> then the strategy falls back to css rather than a guessed durable one', { tags: ['@unit', '@locator-stability'] }, () => {
    // An unparsed locator must never be mistaken for a stable one, so the
    // fallback is deliberately the low-ranked strategy.
    expect(parseLocator('div.card > span:nth-child(2)')?.strategy).toBe('css');
  });

  it('given null, undefined or blank input -> when parseLocator runs -> then it returns null instead of a fabricated locator', { tags: ['@unit', '@locator-stability'] }, () => {
    expect(parseLocator(null)).toBeNull();
    expect(parseLocator(undefined)).toBeNull();
    expect(parseLocator('   ')).toBeNull();
  });
});

describe('stabilityDelta', () => {
  it('given a testid replaced by another testid -> when stabilityDelta runs -> then the delta is 0', { tags: ['@unit', '@locator-stability'] }, () => {
    expect(stabilityDelta('testid', 'testid')).toBe(0);
  });

  it('given a testid replaced by text -> when stabilityDelta runs -> then the delta is negative, marking the heal as a weakening', { tags: ['@unit', '@locator-stability'] }, () => {
    // testid → text is the classic "makes it pass, makes it worse" heal.
    expect(stabilityDelta('testid', 'text')).toBeLessThan(0);
  });

  it('given a css locator replaced by a testid -> when stabilityDelta runs -> then the delta is positive', { tags: ['@unit', '@locator-stability'] }, () => {
    expect(stabilityDelta('css', 'testid')).toBeGreaterThan(0);
  });

  it('given the STABILITY_RANK table -> when its ranks are compared -> then xpath is the least durable option and testid the most', { tags: ['@unit', '@locator-stability'] }, () => {
    const ranks = Object.values(STABILITY_RANK);
    expect(STABILITY_RANK.xpath).toBe(Math.max(...ranks));
    expect(STABILITY_RANK.testid).toBe(Math.min(...ranks));
  });
});

describe('testIdDistance', () => {
  it('given two identical test ids -> when testIdDistance runs -> then the distance is 0', { tags: ['@unit', '@locator-stability'] }, () => {
    expect(testIdDistance('gym-card-name', 'gym-card-name')).toBe(0);
  });

  it('given a plausible rename and an unrelated id -> when testIdDistance runs -> then the rename scores far nearer than the unrelated id and below 0.5', { tags: ['@unit', '@locator-stability'] }, () => {
    const rename = testIdDistance('gym-card-name', 'gym-card-title');
    const unrelated = testIdDistance('gym-card-name', 'checkout-submit-button');
    expect(rename).toBeLessThan(unrelated);
    expect(rename).toBeLessThan(0.5);
  });

  it('given a same-container rename and a same-element move to another feature -> when testIdDistance runs -> then the rename scores nearer, because prefix disagreement costs more', { tags: ['@unit', '@locator-stability'] }, () => {
    // Elements are renamed far more often than they move between features,
    // so prefix disagreement must cost more than suffix disagreement.
    const sameContainer = testIdDistance('gym-card-name', 'gym-card-title');
    const otherFeature = testIdDistance('gym-card-name', 'event-card-name');
    expect(sameContainer).toBeLessThan(otherFeature);
  });

  it('given a rename and a sibling field of the same container -> when testIdDistance runs -> then both score identically, because the string cannot tell them apart', { tags: ['@unit', '@locator-stability'] }, () => {
    // Honest tie. Separating these is the Tier-1 ranker's job, using the
    // failing assertion's domain arguments — not the string metric's.
    expect(testIdDistance('gym-card-name', 'gym-card-title')).toBe(
      testIdDistance('gym-card-name', 'gym-card-county'),
    );
  });

  it('given the canonical gym-card-name to gym-card-title rename -> when testIdDistance runs -> then the score stays under the 0.4 candidate-filter threshold', { tags: ['@unit', '@locator-stability'] }, () => {
    // The heal engine discards candidates above 0.4; the canonical rename
    // case must comfortably survive that filter.
    expect(testIdDistance('gym-card-name', 'gym-card-title')).toBeLessThan(0.4);
  });

  it('given two entirely unrelated ids -> when testIdDistance runs -> then the distance never exceeds 1', { tags: ['@unit', '@locator-stability'] }, () => {
    expect(testIdDistance('a', 'completely-different-thing-entirely')).toBeLessThanOrEqual(1);
  });
});
