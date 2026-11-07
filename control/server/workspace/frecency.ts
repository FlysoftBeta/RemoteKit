export interface UsageEvent {
  at: number;
  item: string;
  windowId: string;
  chain: string;
  title?: string;
}

export interface FrecencyBoosts {
  favorites?: ReadonlySet<string>;
  organized?: ReadonlySet<string>;
}

export interface FrecencyScore {
  score: number;
  direct: number;
  hub: number;
  visits: number;
  weight: number;
  transitWeight: number;
}

const week = 7 * 24 * 60 * 60 * 1000;

export function computeFrecency(
  events: readonly UsageEvent[],
  now: number,
  boosts: FrecencyBoosts = {},
): Map<string, FrecencyScore> {
  const ordered = events.map((event, index) => ({ event, index }));
  ordered.sort((a, b) => a.event.at - b.event.at || a.index - b.index);
  const successors = new Map<UsageEvent, UsageEvent>();
  const tails = new Map<string, UsageEvent>();
  for (const { event } of ordered) {
    const previous = tails.get(event.chain);
    if (previous) successors.set(previous, event);
    tails.set(event.chain, event);
  }

  const scores = new Map<string, FrecencyScore>();
  const destinations = new Map<string, Map<string, number>>();
  for (const { event } of ordered) {
    const weight = 2 ** (-Math.max(0, now - event.at) / week);
    const successor = successors.get(event);
    const transit = !!successor && Math.min(10 * 60 * 1000, successor.at - event.at) < 15 * 1000;
    let score = scores.get(event.item);
    if (!score) {
      score = { score: 0, direct: 0, hub: 0, visits: 0, weight: 0, transitWeight: 0 };
      scores.set(event.item, score);
    }
    score.visits += weight * (transit ? 0.3 : 1);
    score.weight += weight;
    if (transit) {
      score.transitWeight += weight;
      let distribution = destinations.get(event.item);
      if (!distribution) {
        distribution = new Map();
        destinations.set(event.item, distribution);
      }
      distribution.set(successor.item, (distribution.get(successor.item) ?? 0) + weight);
    }
  }

  const predictability = new Map<string, number>();
  const transfers = new Map<string, number>();
  for (const [item, score] of scores) {
    const distribution = destinations.get(item);
    if (!distribution) {
      score.direct = score.visits;
      predictability.set(item, 0);
      continue;
    }
    let top = '';
    let topWeight = 0;
    for (const [destination, weight] of distribution) {
      if (weight > topWeight) [top, topWeight] = [destination, weight];
    }
    const share = topWeight / score.transitWeight;
    const transitRate = score.transitWeight / score.weight;
    const discount = score.visits * 0.8 * transitRate * share;
    score.direct = score.visits - discount;
    predictability.set(item, share);
    // A predictable pass-through is worth what it leads to, so its lost value moves there.
    transfers.set(top, (transfers.get(top) ?? 0) + discount);
  }
  for (const [item, transfer] of transfers) scores.get(item)!.direct += transfer;
  const directScores = [...scores.values()].map((score) => score.direct).sort((a, b) => b - a);
  const capacityScore = directScores.length >= 12 ? directScores[11] : 0;
  const threshold = Math.max(capacityScore, 0.5 * (directScores[0] ?? 0));
  for (const [item, score] of scores) {
    const diversity = 1 - predictability.get(item)! ** 2;
    for (const [destination, weight] of destinations.get(item) ?? []) {
      const direct = scores.get(destination)!.direct;
      const gain = threshold > 0 ? 1 - Math.min(1, direct / threshold) : 0;
      score.hub += diversity * weight * gain;
    }
    score.score = score.direct + score.hub;
    if (
      (item.startsWith('page:') && boosts.favorites?.has(item.slice(5))) ||
      (item.startsWith('file:') && boosts.organized?.has(item.slice(5)))
    )
      score.score *= 1.5;
  }
  return scores;
}

export function scoreFrecency(
  events: readonly UsageEvent[],
  now: number,
  boosts: FrecencyBoosts = {},
): Map<string, number> {
  return new Map([...computeFrecency(events, now, boosts)].map(([item, score]) => [item, score.score]));
}
