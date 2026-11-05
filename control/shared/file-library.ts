export interface Asset {
  assetId: string;
  hash: string;
  size: number;
  type: string;
  width?: number;
  height?: number;
}

export interface PhotoMetadata {
  mode: 'photo' | 'scan';
  candidateAssetIds?: string[];
  pending?: 'choice' | 'scan-error';
  warning?: string;
}

interface LibraryAssetFields {
  assetId: string;
  originalAssetId?: string;
  photo?: PhotoMetadata;
}

export interface LibraryEntry extends LibraryAssetFields {
  id: string;
  name: string;
  type: string;
  size: number;
  createdAt: number;
  groupId: string | null;
  archived: boolean;
}

export interface LibraryGroup {
  id: string;
  name: string;
}
export interface LibrarySnapshot {
  revision: number;
  entries: LibraryEntry[];
  basket: string[];
  groups: LibraryGroup[];
}
export type SelectionState = 'pending' | 'validating' | 'selected' | 'cancelled' | 'unknown';

export interface LibraryMethods {
  'library.get': { params: Record<string, never>; result: LibrarySnapshot };
  'library.import': {
    params: LibraryAssetFields & {
      operationId: string;
      name: string;
      destination: 'basket' | 'library';
      groupId: string | null;
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
  'library.group': { params: { operationId: string; id?: string; name: string }; result: LibrarySnapshot };
  'library.move': {
    params: { operationId: string; ids: string[]; groupId: string | null };
    result: LibrarySnapshot;
  };
  'library.delete': { params: { operationId: string; ids: string[] }; result: LibrarySnapshot };
  'library.prepare': {
    params: { operationId: string; requestId: string; entryIds: string[]; groupId: string | null };
    result: { selectionId: string };
  };
  'library.finish': {
    params: { selectionId: string };
    result: { state: SelectionState; snapshot: LibrarySnapshot };
  };
}
