// Adapted from FlysoftBeta/talos-ng packages/virtual/src/core/{sizes,scroller}.ts.
import type { DocumentProgress } from './document-source';

import { SizeIndex } from '../ui/virtual-scroll';

export const PAGE_TOP = 16;
export const PAGE_GAP = 24;

function fraction(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function normalizeProgress(progress: DocumentProgress, count: number): DocumentProgress {
  return {
    page: Math.max(0, Math.min(count - 1, Math.trunc(progress.page) || 0)),
    offset: fraction(progress.offset),
  };
}

export function progressAt(sizes: SizeIndex, top: number): DocumentProgress {
  if (!sizes.length) return { page: 0, offset: 0 };
  const page = sizes.find(Math.max(0, top));
  return {
    page,
    offset: fraction((top - sizes.prefix(page) - PAGE_TOP) / (sizes.size(page) - PAGE_GAP)),
  };
}

export function progressTop(sizes: SizeIndex, progress: DocumentProgress): number {
  if (!sizes.length) return 0;
  const { page, offset } = normalizeProgress(progress, sizes.length);
  return sizes.prefix(page) + PAGE_TOP + offset * (sizes.size(page) - PAGE_GAP);
}
