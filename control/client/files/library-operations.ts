import type { LibraryMethods, LibrarySnapshot, LibrarySource } from '../../shared/file-library';

export type LibraryMutationMethod = Exclude<
  keyof LibraryMethods,
  'library.get' | 'library.snippet' | 'library.copySnippet' | 'library.prepare' | 'library.finish'
>;
export type LibraryChange = {
  [K in LibraryMutationMethod]: { method: K; params: LibraryMethods[K]['params'] };
}[LibraryMutationMethod];
export interface PendingLibraryChange {
  change: LibraryChange;
  basketBefore?: string[];
  visible?: boolean;
}
const sameSource = (a: LibrarySource | null, b: LibrarySource) => a?.app === b.app && a.channel === b.channel;

export function projectBasket(current: string[], ids: string[], before: string[]) {
  const wanted = ids.filter((id) => current.includes(id) || !before.includes(id));
  return [...wanted, ...current.filter((id) => !before.includes(id) && !wanted.includes(id))];
}

export function projectLibrary(
  snapshot: LibrarySnapshot | undefined,
  pending: PendingLibraryChange[],
  held: string[] = [],
) {
  if (!snapshot || !pending.length) return snapshot;
  const next: LibrarySnapshot = JSON.parse(JSON.stringify(snapshot));
  for (const { change, basketBefore, visible } of pending) {
    if (visible === false) continue;
    switch (change.method) {
      case 'library.partition': {
        const { id, name, create } = change.params;
        const partition = next.partitions.find((item) => item.id === id);
        if (!create && partition) partition.name = name;
        else if (create && !partition) next.partitions.push({ id, name });
        break;
      }
      case 'library.partitionDelete':
        next.partitions = next.partitions.filter((item) => item.id !== change.params.id);
        for (const entry of next.entries)
          if (entry.partitionId === change.params.id) entry.partitionId = null;
        if (next.basketPartitionId === change.params.id) next.basketPartitionId = null;
        break;
      case 'library.move':
        for (const entry of next.entries)
          if (change.params.ids.includes(entry.id)) entry.partitionId = change.params.partitionId;
        break;
      case 'library.delete':
        next.entries = next.entries.filter((entry) => !change.params.ids.includes(entry.id));
        next.basket = next.basket.filter((id) => !change.params.ids.includes(id));
        break;
      case 'library.basket':
        next.basket = projectBasket(next.basket, change.params.ids, basketBefore ?? next.basket).filter(
          (id) => next.entries.some((entry) => entry.id === id),
        );
        break;
      case 'library.basketPartition':
        next.basketPartitionId = change.params.partitionId;
        break;
      case 'library.source':
        next.excludedSources = next.excludedSources.filter((item) => !sameSource(item, change.params.source));
        if (change.params.excluded) next.excludedSources.push(change.params.source);
        break;
      case 'library.sourcePurge':
        for (const entry of next.entries)
          if (sameSource(entry.source, change.params.source)) {
            entry.source = null;
            entry.collected = false;
          }
        break;
      case 'library.replace': {
        const { entryId, operationId, expectedRevision, ...fields } = change.params;
        const entry = next.entries.find((entry) => entry.id === entryId);
        if (entry?.kind === 'file') Object.assign(entry, fields);
        break;
      }
    }
    if (
      ['library.partitionDelete', 'library.move', 'library.sourcePurge', 'library.basket'].includes(
        change.method,
      )
    )
      next.entries = next.entries.filter(
        (entry) =>
          (entry.collected && entry.source !== null) ||
          entry.partitionId !== null ||
          next.basket.includes(entry.id) ||
          held.includes(entry.id),
      );
  }
  next.sources = next.sources.flatMap((source) => {
    const count = next.entries.filter((entry) => sameSource(entry.source, source)).length;
    return count
      ? [{ ...source, count, excluded: next.excludedSources.some((item) => sameSource(item, source)) }]
      : [];
  });
  return next;
}
