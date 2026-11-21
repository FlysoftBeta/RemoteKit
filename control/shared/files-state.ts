import type { LibrarySource } from './file-library';

export type FilesView =
  'all' | 'recent' | 'clipboard' | 'settings' | { partition: string } | { source: LibrarySource };
export type FilesTab =
  | { id: string; kind: 'library'; view: FilesView; query: string }
  | {
      id: string;
      kind: 'document';
      entryId: string;
      from?: FilesView;
      fromQuery?: string;
      /** PDF rendered by the remote browser instead of the local reader. */
      compat?: true;
    }
  | { id: string; kind: 'photos'; entryId: string; from: FilesView; fromQuery?: string };
export interface FilesLaunch {
  requestId: string;
  entryId?: string;
  view?: FilesView;
}
export interface FilesWindowState {
  tabs: FilesTab[];
  activeTabId: string;
  layout: 'grid' | 'list';
  launch?: FilesLaunch;
}
