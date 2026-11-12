import type { WireError } from './errors';
export interface Asset {
  assetId: string;
  size: number;
  type: string;
  width?: number;
  height?: number;
}

export interface PhotoMetadata {
  mode: 'photo' | 'scan';
  quarterTurns?: 1 | 2 | 3;
  candidateAssetIds?: string[];
  pending?: 'choice' | 'scan-error';
  advisory?: 'low-quality';
  processingFailure?: WireError;
}

export interface LibraryAssetFields {
  assetId: string;
  originalAssetId?: string;
  photo?: PhotoMetadata;
}

interface LibraryEntryFields {
  available: boolean;
  detail?: string;
  id: string;
  name: string;
  type: string;
  size: number;
  createdAt: number;
  source: LibrarySource | null;
  partitionId: string | null;
  collected: boolean;
}

export type SnippetOrigin =
  | { kind: 'page'; url: string; title?: string; app: string }
  | { kind: 'app'; app: string }
  | { kind: 'device' };

export interface LibraryFileEntry extends LibraryEntryFields, LibraryAssetFields {
  kind: 'file';
}

export interface LibrarySnippetEntry extends LibraryEntryFields {
  kind: 'snippet';
  preview: string;
  origin: SnippetOrigin;
  assetId?: never;
  originalAssetId?: never;
  photo?: never;
}

export type LibraryEntry = LibraryFileEntry | LibrarySnippetEntry;
export type StoredLibraryEntry = Omit<LibraryFileEntry, 'available'> | Omit<LibrarySnippetEntry, 'available'>;

export interface LibrarySource {
  app: string;
  channel: string;
}

export interface LibraryPartition {
  id: string;
  name: string;
}
export interface LibrarySnapshot {
  revision: number;
  entries: LibraryEntry[];
  basket: string[];
  partitions: LibraryPartition[];
  sources: (LibrarySource & { count: number; excluded: boolean })[];
  excludedSources: LibrarySource[];
  basketPartitionId: string | null;
}
export type SelectionState = 'pending' | 'validating' | 'selected' | 'cancelled' | 'unknown';

export interface LibraryMethods {
  'library.get': { params: Record<string, never>; result: LibrarySnapshot };
  'library.snippet': { params: { id: string }; result: { text: string } };
  'library.copySnippet': { params: { id: string }; result: { revision: string; text: string } };
  'library.import': {
    params: LibraryAssetFields & {
      operationId: string;
      name: string;
      destination: 'basket' | 'library';
      origin:
        | { kind: 'request'; requestId: string }
        | { kind: 'files'; channel: 'upload' | 'camera'; partitionId: string | null };
      afterId?: string;
    };
    result: LibrarySnapshot;
  };
  'library.replace': {
    params: LibraryAssetFields & { operationId: string; entryId: string; expectedRevision: number };
    result: LibrarySnapshot;
  };
  'library.basket': {
    params: { operationId: string; expectedRevision: number; ids: string[] };
    result: LibrarySnapshot;
  };
  'library.partition': {
    params: { operationId: string; id?: string; name: string };
    result: LibrarySnapshot;
  };
  'library.partitionDelete': { params: { operationId: string; id: string }; result: LibrarySnapshot };
  'library.source': {
    params: { operationId: string; source: LibrarySource; excluded: boolean };
    result: LibrarySnapshot;
  };
  'library.sourcePurge': {
    params: { operationId: string; source: LibrarySource };
    result: LibrarySnapshot;
  };
  'library.basketPartition': {
    params: { operationId: string; partitionId: string | null };
    result: LibrarySnapshot;
  };
  'library.move': {
    params: { operationId: string; ids: string[]; partitionId: string | null };
    result: LibrarySnapshot;
  };
  'library.delete': { params: { operationId: string; ids: string[] }; result: LibrarySnapshot };
  'library.prepare': {
    params: { operationId: string; requestId: string; entryIds: string[] };
    result: { selectionId: string };
  };
  'library.finish': {
    params: { selectionId: string };
    result: { state: SelectionState; snapshot: LibrarySnapshot };
  };
}
