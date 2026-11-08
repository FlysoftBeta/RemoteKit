import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFrecency, type FrecencyBoosts, type UsageEvent } from '../server/workspace/frecency';

const scoreFrecency = (events: UsageEvent[], now: number, boosts?: FrecencyBoosts) =>
  new Map([...computeFrecency(events, now, boosts)].map(([item, score]) => [item, score.score]));

const now = 30 * 24 * 60 * 60 * 1000;

function chain(items: string[], id: string, at = now - 60 * 1000): UsageEvent[] {
  return items.map((item, index) => ({ item, at: at + index * 1000, windowId: id, chain: id }));
}

function destinations(): UsageEvent[] {
  return Array.from({ length: 12 }, (_, index) =>
    Array.from({ length: 20 }, (_unused, visit) => chain([`popular:${index}`], `${index}:${visit}`)).flat(),
  ).flat();
}

test('predictable intermediary A is discounted far below B and its raw visits', () => {
  const scores = computeFrecency(
    [...chain(['A', 'B', 'C'], 'first'), ...chain(['A', 'B', 'D'], 'second')],
    now,
  );
  assert.ok(scores.get('A')!.score < scores.get('B')!.score / 2);
  assert.ok(scores.get('A')!.score < scores.get('A')!.weight / 10);
  assert.ok(Math.abs(scores.get('A')!.direct / scores.get('A')!.weight - 0.06) < 0.000001);
});

test('a distributed hub gains credit from low-frequency successors', () => {
  const events = [
    ...destinations(),
    ...chain(['B', 'C'], 'bc'),
    ...chain(['B', 'D'], 'bd'),
    ...chain(['B', 'E'], 'be'),
    ...chain(['other'], 'other1'),
    ...chain(['other'], 'other2'),
    ...chain(['other'], 'other3'),
  ];
  const scores = computeFrecency(events, now);
  for (const item of ['C', 'D', 'E']) assert.ok(scores.get('B')!.score > scores.get(item)!.score);
  // Both have three raw visits; B also stands in for three successors too rare for tiles.
  assert.ok(scores.get('B')!.hub > 0);
  assert.ok(scores.get('B')!.score > scores.get('other')!.score);
});

test('a successor at or above the threshold grants no hub credit', () => {
  const events = [
    ...destinations(),
    ...chain(['B', 'C'], 'bc'),
    ...Array.from({ length: 30 }, (_, index) => chain(['C'], `c:${index}`)).flat(),
  ];
  assert.equal(computeFrecency(events, now).get('B')!.hub, 0);
});

test('a distributed hub outranks equal raw visits without successors when those visits are older', () => {
  const events = [
    ...destinations(),
    ...chain(['B', 'C'], 'bc'),
    ...chain(['B', 'D'], 'bd'),
    ...chain(['B', 'E'], 'be'),
    ...chain(['older'], 'older1', now - 7 * 24 * 60 * 60 * 1000),
    ...chain(['older'], 'older2', now - 7 * 24 * 60 * 60 * 1000),
    ...chain(['older'], 'older3', now - 7 * 24 * 60 * 60 * 1000),
  ];
  const scores = computeFrecency(events, now);
  assert.ok(scores.get('B')!.score > scores.get('older')!.score);
});

test('launcher chain boundaries prevent intermediary credit across launcher opens', () => {
  const events = [...chain(['A'], 'before-launcher'), ...chain(['B'], 'launcher', now - 59 * 1000)];
  const scores = computeFrecency(events, now);
  assert.equal(scores.get('A')!.transitWeight, 0);
  assert.equal(scores.get('A')!.direct, scores.get('A')!.weight);
});

test('decay halves all scores every seven days and applies item boosts last', () => {
  const events = [...chain(['page:https://example.com'], 'page'), ...chain(['file:photo'], 'file')];
  const first = scoreFrecency(events, now);
  const later = scoreFrecency(events, now + 7 * 24 * 60 * 60 * 1000);
  const boosted = scoreFrecency(events, now, {
    favorites: new Set(['https://example.com']),
    organized: new Set(['photo']),
  });
  for (const [item, score] of first) {
    assert.ok(Math.abs(later.get(item)! - score / 2) < 1e-12);
    assert.equal(boosted.get(item), score * 1.5);
  }
});

test('dwell at fifteen seconds and chain tails count as destinations', () => {
  const events = chain(['A', 'B'], 'slow');
  events[1].at = events[0].at + 15000;
  for (const score of computeFrecency(events, now).values()) {
    assert.equal(score.transitWeight, 0);
    assert.equal(score.direct, score.weight);
  }
});

test('returns count distinct chains where an item was a destination, not a pass-through', () => {
  const now = 1_000_000_000;
  const at = (minutes: number) => now - minutes * 60_000;
  const events: UsageEvent[] = [
    { at: at(60), item: 'page:login', windowId: 'w', chain: 'a' },
    { at: at(60) + 5_000, item: 'page:app', windowId: 'w', chain: 'a' },
    { at: at(30), item: 'page:login', windowId: 'w', chain: 'b' },
    { at: at(30) + 5_000, item: 'page:app', windowId: 'w', chain: 'b' },
    { at: at(10), item: 'page:once', windowId: 'w', chain: 'c' },
    { at: at(9), item: 'page:once', windowId: 'w', chain: 'c' },
  ];
  const scores = computeFrecency(events, now);
  assert.equal(scores.get('page:login')!.returns, 0);
  assert.equal(scores.get('page:app')!.returns, 2);
  assert.equal(scores.get('page:once')!.returns, 1);
});
