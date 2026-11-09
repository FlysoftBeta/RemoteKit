import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Close, FolderOutlined } from '@mui/icons-material';
import { ListItemIcon, Menu, MenuItem } from '@mui/material';
import type { LibraryEntry } from '../../shared/file-library';
import type { LearningCall } from '../learning/queries';
import { TabStrip } from '../app/tab-strip';
import { scaledAnchor } from '../app/ui-scale';
import { diagnostics } from '../media/diagnostics';
import { useLibrary } from './file-library-state';
import { FileTypeIcon } from './file-thumbnail';
import { LibraryTab, PhotoDialog } from './library-tab';
import { PhotoCapture } from './photo-library-capture';
import {
  applyFilesLaunch,
  backFilesTab,
  closeFilesTab,
  closeOtherFilesTabs,
  filesTabId,
  fitFilesWindowState,
  hasValidFilesTabs,
  MAX_FILES_TABS,
  newFilesTab,
  openFilesEntry,
  readFilesLaunch,
  readFilesWindowState,
  reorderFilesTab,
  sourceAppName,
  sourceChannelName,
  selectFilesTab,
  updateFilesLibraryTab,
  setFilesLayout,
  type FilesView,
  type FilesWindowState,
} from './files-app-state';
import './files-window.css';

const DocumentTab = lazy(() => import('./document-tab').then((module) => ({ default: module.DocumentTab })));

export function FilesWindow({
  windowId,
  state,
  onState,
  call,
  handle,
  launch,
}: {
  windowId: string;
  state: unknown;
  onState(state: unknown): void;
  call?: LearningCall;
  handle: ReactNode;
  launch?: unknown;
}) {
  const restored = useMemo(() => readFilesWindowState(state), [state]);
  const { snapshot, online, refresh, recordUsage, apps, photos } = useLibrary();
  const appliedLaunch = useRef<string>(undefined);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; id: string }>();
  const [photo, setPhoto] = useState<string>();
  const [camera, setCamera] = useState<LibraryEntry>();
  const write = (next: FilesWindowState) => onState(fitFilesWindowState(next, restored));
  const recordOpen = (entry: LibraryEntry) =>
    void recordUsage(entry.id, windowId).catch((failure) => diagnostics.record('file-usage', failure));
  useEffect(() => {
    if (online) void refresh().catch((failure) => diagnostics.record('my-files', failure));
  }, [online]);
  useEffect(() => {
    const request =
      readFilesLaunch(launch) ?? readFilesLaunch((state as { launch?: unknown } | null)?.launch);
    if (!request) return;
    if (appliedLaunch.current === request.requestId) {
      if (restored.launch) {
        const { launch: _, ...next } = restored;
        write(next);
      }
      return;
    }
    const entry = request.entryId
      ? snapshot?.entries.find((entry) => entry.id === request.entryId)
      : undefined;
    if (request.entryId && !entry) return;
    appliedLaunch.current = request.requestId;
    if (entry?.photo) {
      const next = applyFilesLaunch(
        restored,
        { requestId: request.requestId, view: request.view ?? 'all' },
        filesTabId(),
        hasValidFilesTabs(state),
      );
      write(next);
      setPhoto(entry.id);
      recordOpen(entry);
    } else {
      const next = applyFilesLaunch(restored, request, filesTabId(), hasValidFilesTabs(state));
      write(next);
      if (entry) recordOpen(entry);
    }
  }, [state, launch, snapshot]);
  const active = restored.tabs.find((tab) => tab.id === restored.activeTabId)!;
  const viewTitle = (view: FilesView): string =>
    typeof view === 'string'
      ? { all: '全部', recent: '最近', clipboard: '剪贴板', settings: '设置' }[view]
      : 'partition' in view
        ? (snapshot?.partitions.find((item) => item.id === view.partition)?.name ?? '分区')
        : [sourceAppName(view.source.app, apps), sourceChannelName(view.source)].filter(Boolean).join(' › ');
  const close = (id: string) => write(closeFilesTab(restored, id, filesTabId()));
  const photoEntry = snapshot?.entries.find((entry) => entry.id === photo);
  const photoJob = photos.jobs.find((job) => job.id === photo || job.replace?.id === photo);
  return (
    <>
      <div className="tab-bar">
        {handle}
        <TabStrip
          windowId={windowId}
          group={`files:${windowId}`}
          activeId={restored.activeTabId}
          items={restored.tabs.map((tab) => {
            const entry =
              tab.kind === 'document' ? snapshot?.entries.find((item) => item.id === tab.entryId) : undefined;
            return {
              id: tab.id,
              title:
                tab.kind === 'library'
                  ? viewTitle(tab.view)
                  : entry?.kind === 'snippet'
                    ? '剪贴片段'
                    : (entry?.name ?? '文件已删除'),
              icon:
                tab.kind === 'library' ? (
                  <FolderOutlined className="tab-icon" />
                ) : (
                  <span className="tab-icon">
                    {entry && <FileTypeIcon type={entry.type} name={entry.name} />}
                  </span>
                ),
            };
          })}
          disabled={!online}
          createDisabled={restored.tabs.length >= MAX_FILES_TABS}
          select={(id) => write(selectFilesTab(restored, id))}
          close={close}
          create={() => write(newFilesTab(restored, filesTabId()))}
          move={(id, target, index) => {
            if (target === windowId) write(reorderFilesTab(restored, id, index));
          }}
          menu={(anchor, id) => setMenu({ anchor, id })}
        />
        <span className="tab-bar-spacer" />
      </div>
      <div className="files-window-content">
        {active.kind === 'library' ? (
          <LibraryTab
            key={active.id}
            windowId={windowId}
            view={active.view}
            query={active.query}
            layout={restored.layout}
            onView={(view) => write(updateFilesLibraryTab(restored, active.id, { view }))}
            onQuery={(query) => write(updateFilesLibraryTab(restored, active.id, { query }))}
            onLayout={(layout) => write(setFilesLayout(restored, layout))}
            onOpen={(entry) => {
              write(openFilesEntry(restored, active.id, entry.id));
              recordOpen(entry);
            }}
          />
        ) : (
          <Suspense
            fallback={
              <div className="files-window-loading" role="status">
                正在打开文件…
              </div>
            }
          >
            <DocumentTab
              key={active.id}
              tab={active}
              windowId={windowId}
              call={call}
              onBack={() => write(backFilesTab(restored, active.id))}
              onClose={() => close(active.id)}
            />
          </Suspense>
        )}
      </div>
      <Menu
        anchorEl={scaledAnchor(menu?.anchor)}
        open={!!menu}
        onClose={() => setMenu(undefined)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ list: { dense: true } }}
      >
        <MenuItem
          disabled={!online}
          onClick={() => {
            if (menu) close(menu.id);
            setMenu(undefined);
          }}
        >
          <ListItemIcon>
            <Close fontSize="small" />
          </ListItemIcon>
          关闭标签页
        </MenuItem>
        <MenuItem
          disabled={!online || restored.tabs.length <= 1}
          onClick={() => {
            if (menu) write(closeOtherFilesTabs(restored, menu.id));
            setMenu(undefined);
          }}
        >
          关闭其他标签页
        </MenuItem>
      </Menu>
      {(photoEntry || photoJob) && (
        <PhotoDialog
          entry={photoEntry}
          job={photoJob}
          disabled={!online}
          onClose={() => setPhoto(undefined)}
          onRetake={(entry) => {
            setPhoto(undefined);
            setCamera(entry);
          }}
        />
      )}
      {camera && (
        <PhotoCapture
          windowId={windowId}
          destination="library"
          replace={camera}
          partitionId={camera.partitionId}
          onClose={() => setCamera(undefined)}
        />
      )}
    </>
  );
}
