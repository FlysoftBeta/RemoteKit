import { useAutoFocus } from '../editing/local-autofocus';
import { diagnostics } from '../media/diagnostics';
import {
  ArrowDropDown,
  CheckBoxOutlined,
  Close,
  CloudUploadOutlined,
  DeleteOutline,
  DriveFileMoveOutlined,
  MoreVert,
  PhotoCameraOutlined,
  Search,
  ShoppingBasket,
  ShoppingBasketOutlined,
  UploadFileOutlined,
} from '@mui/icons-material';
import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  LinearProgress,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  TextField,
  Tooltip,
  Typography,
  Snackbar,
} from '@mui/material';
import React, {
  type JSX,
  memo,
  useMemo,
  useLayoutEffect,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { canonicalJson } from '../util/canonical-json';
import { VirtualScroller, type VirtualViewport } from '../ui/virtual-list';
import { SizeIndex } from '../ui/virtual-scroll';
import type { LibraryEntry } from '../../shared/file-library';
import { scaledAnchor } from '../app/ui-scale';
import { operationId } from '../control/product-operations';
import { photoStatus } from './basket-items';
import { FileBasketDialog } from './file-chooser-dialog';
import { dayLabel, formatFileSize, formatTime } from './file-format';
import { FileEntryMenu } from './file-entry-menu';
import './library-tab.css';
import {
  basketEntries,
  fileError,
  FileDropZone,
  PartitionPicker,
  useDeviceImport,
} from './file-library-controls';
import { useLibrary } from './file-library-state';
import { FileRow, FileTile } from './file-tile';
import { FileViewToggle } from './file-view';
import { PhotoCapture } from './photo-library-capture';
import type { PhotoJob } from './photo-job-store';
import { PhotoOptions } from './photo-options';
import { filesInView, sourceAppName, sourceChannelName, type FilesView } from './files-app-state';
import { FilesOrganization } from './files-organization';
import { SnippetView, snippetOriginLabel, snippetRelativeTime, snippetSearchText } from './snippet-view';

const MAX_BASKET = 64;

export function LibraryTab({
  windowId,
  view: filter,
  query,
  layout,
  onView,
  onQuery,
  onLayout,
  onOpen,
}: {
  windowId: string;
  view: FilesView;
  query: string;
  layout: 'grid' | 'list';
  onView(view: FilesView): void;
  onQuery(query: string): void;
  onLayout(layout: 'grid' | 'list'): void;
  onOpen(entry: LibraryEntry): void;
}): JSX.Element {
  const { snapshot, online, refresh, mutate, photos, recordUsage, apps, copySnippet } = useLibrary();
  const [copied, setCopied] = useState(false);
  const pane = useRef<HTMLDivElement>(null);
  const [paneWidth, setPaneWidth] = useState(Infinity);
  // narrow: chips replace the side navigation; compact: header actions become icons.
  const narrow = paneWidth < 600;
  const compact = paneWidth < 900;
  const setQuery = (query: string) => onQuery(query.slice(0, 256));
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>();
  const [menu, setMenu] = useState<{ anchor: HTMLElement; id: string }>();
  const [uploadMenu, setUploadMenu] = useState<HTMLElement>();
  const [camera, setCamera] = useState<{ partitionId?: string | null; replace?: LibraryEntry }>();
  const [showBasket, setShowBasket] = useState(false);
  const [photo, setPhoto] = useState<string>();
  const [move, setMove] = useState<string[]>();
  const [deletion, setDeletion] = useState<{ ids: string[]; operationId: string }>();

  const partitions = snapshot?.partitions ?? [];
  const basket = basketEntries(snapshot);
  const inBasket = new Set(basket.map((entry) => entry.id));
  const catalog = snapshot?.entries ?? [];
  const needle = query.trim().toLowerCase();
  const entries = (snapshot ? filesInView(snapshot, filter, Date.now(), !!needle) : []).filter(
    (entry) =>
      !needle ||
      (entry.kind === 'snippet' && snippetSearchText(entry, apps).toLowerCase().includes(needle)) ||
      [
        entry.name,
        entry.detail,
        entry.source ? `${sourceAppName(entry.source.app, apps)} › ${sourceChannelName(entry.source)}` : '',
      ].some((value) => value?.toLowerCase().includes(needle)),
  );
  const currentPartition =
    typeof filter === 'object' && 'partition' in filter
      ? partitions.find((item) => item.id === filter.partition)
      : undefined;
  const pending = needle
    ? []
    : photos.jobs.filter(
        (job) =>
          job.destination === 'library' &&
          !job.replace &&
          (filter === 'all' ||
            filter === 'recent' ||
            (currentPartition &&
              job.origin.kind === 'files' &&
              job.origin.partitionId === currentPartition.id)),
      );
  const effectiveLayout = filter === 'clipboard' ? 'list' : layout;
  const view = {
    mode: effectiveLayout === 'grid' ? ('cards' as const) : ('list' as const),
    set: (mode: 'cards' | 'list') => onLayout(mode === 'cards' ? 'grid' : 'list'),
  };
  const partitionOf = (id: string | null) => partitions.find((item) => item.id === id)?.name ?? '';
  const disabled = !online || busy || !snapshot;
  const selecting = selected !== undefined;
  const chosen = new Set(selected);
  const menuEntry = catalog.find((entry) => entry.id === menu?.id);
  const photoEntry = catalog.find((entry) => entry.id === photo);
  const photoJob = photos.jobs.find((job) => job.id === photo || job.replace?.id === photo);
  const reportError = useCallback((message: string) => setError(message), []);
  const upload = useDeviceImport({
    destination: 'library',
    windowId,
    disabled,
    partitionId: currentPartition?.id ?? null,
    onError: reportError,
  });

  useEffect(() => {
    const node = pane.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const resize = new ResizeObserver(([entry]) => setPaneWidth(entry.contentRect.width));
    resize.observe(node);
    return () => resize.disconnect();
  }, []);
  // Drop selections of entries that disappeared (deleted elsewhere, filtered out).
  useEffect(() => {
    if (!selected) return;
    const present = selected.filter((id) => entries.some((entry) => entry.id === id));
    if (present.length !== selected.length) setSelected(present);
  });

  async function run(action: () => Promise<unknown>) {
    setError('');
    setBusy(true);
    try {
      await action();
    } catch (failure) {
      setError(fileError(failure));
    } finally {
      setBusy(false);
    }
  }
  const selectFilter = (next: FilesView) => {
    onView(next);
    setSelected(undefined);
  };
  const toggleSelected = (id: string) =>
    setSelected((current = []) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  const saveBasket = (ids: string[]) =>
    run(async () => {
      if (snapshot)
        await mutate('library.basket', {
          operationId: operationId(),
          ids,
          expectedRevision: snapshot.revision,
        });
    });
  const addToBasket = (ids: string[]) => {
    const order = basket.map((entry) => entry.id);
    const fresh = ids.filter((id) => !inBasket.has(id));
    if (order.length + fresh.length > MAX_BASKET) {
      setError(`文件篮最多放 ${MAX_BASKET} 项，还能再放 ${MAX_BASKET - order.length} 项`);
      return;
    }
    if (fresh.length)
      void run(async () => {
        if (!snapshot) return;
        await mutate(
          'library.basket',
          {
            operationId: operationId(),
            ids: [...order, ...fresh],
            expectedRevision: snapshot.revision,
          },
          windowId,
        );
      });
  };
  const removeFromBasket = (id: string) =>
    void saveBasket(basket.map((entry) => entry.id).filter((value) => value !== id));
  const startCamera = () => setCamera({ partitionId: currentPartition?.id ?? null });
  const sections = new Map<string, { entries: LibraryEntry[]; jobs: PhotoJob[] }>();
  if (pending.length) sections.set('今天', { entries: [], jobs: pending });
  for (const entry of entries) {
    const key = dayLabel(entry.createdAt);
    const section = sections.get(key) ?? { entries: [], jobs: [] };
    section.entries.push(entry);
    sections.set(key, section);
  }
  const heading = needle
    ? `搜索“${query.trim()}”`
    : filter === 'settings'
      ? '设置'
      : filter === 'clipboard'
        ? '剪贴板'
        : filter === 'recent'
          ? '最近'
          : filter === 'all'
            ? '全部'
            : 'partition' in filter
              ? (currentPartition?.name ?? '分区')
              : [sourceAppName(filter.source.app, apps), sourceChannelName(filter.source)]
                  .filter(Boolean)
                  .join(' › ');
  const openPreview = (entry: LibraryEntry) => {
    if (entry.photo) {
      setPhoto(entry.id);
      void recordUsage(entry.id, windowId).catch((failure) => diagnostics.record('file-usage', failure));
    } else onOpen(entry);
  };
  const openEntry = (entry: LibraryEntry, anchor: HTMLElement) => {
    if (selecting) toggleSelected(entry.id);
    else if (entry.kind === 'snippet')
      void run(async () => {
        await copySnippet(entry.id);
        setCopied(true);
      });
    else if (entry.photo?.pending) openPreview(entry);
    else setMenu({ anchor, id: entry.id });
  };
  const entryMeta = (entry: LibraryEntry) =>
    entry.kind === 'snippet'
      ? `${snippetOriginLabel(entry.origin, apps)} · ${snippetRelativeTime(entry.createdAt)}`
      : [
          formatFileSize(entry.size),
          formatTime(entry.createdAt),
          entry.source
            ? [sourceAppName(entry.source.app, apps), sourceChannelName(entry.source)]
                .filter(Boolean)
                .join(' › ')
            : '已整理',
          partitions.length && (!currentPartition || needle) ? partitionOf(entry.partitionId) : '',
        ]
          .filter(Boolean)
          .join(' · ');

  const latestActions = useRef({ openEntry, toggleSelected, addToBasket, removeFromBasket, catalog });
  latestActions.current = { openEntry, toggleSelected, addToBasket, removeFromBasket, catalog };
  const entryActions = useMemo(
    () => ({
      open: (id: string, anchor: HTMLElement) => {
        const entry = latestActions.current.catalog.find((entry) => entry.id === id);
        if (entry) latestActions.current.openEntry(entry, anchor);
      },
      select: (id: string) => latestActions.current.toggleSelected(id),
      longPress: (id: string) =>
        setSelected((current = []) => (current.includes(id) ? current : [...current, id])),
      basket: (id: string) =>
        latestActions.current.catalog.some((entry) => entry.id === id) &&
        (basketRef.current.has(id)
          ? latestActions.current.removeFromBasket(id)
          : latestActions.current.addToBasket([id])),
      menu: (id: string, anchor: HTMLElement) => setMenu({ id, anchor }),
    }),
    [],
  );
  const basketRef = useRef(inBasket);
  basketRef.current = inBasket;
  const listViewport = useRef<VirtualViewport>(null);
  const [listWidth, setListWidth] = useState(0);
  const columns =
    effectiveLayout === 'list' ? 1 : Math.max(1, Math.floor((listWidth + 12) / ((narrow ? 136 : 160) + 12)));
  const cardHeight = ((listWidth - (columns - 1) * 12) / columns) * 0.75 + 46;
  const virtualRows: LibraryRow[] = [];
  for (const [label, section] of sections) {
    virtualRows.push({ key: label, label, header: true, entries: [], jobs: [] });
    const items = [...section.jobs.map((job) => ({ job })), ...section.entries.map((entry) => ({ entry }))];
    for (let index = 0; index < items.length; index += columns) {
      const group = items.slice(index, index + columns);
      virtualRows.push({
        key: label + ':' + index,
        label,
        header: false,
        entries: group.flatMap((item) => ('entry' in item ? [item.entry] : [])),
        jobs: group.flatMap((item) => ('job' in item ? [item.job] : [])),
      });
    }
  }
  const rowSizes = new SizeIndex(
    virtualRows.map((row) =>
      row.header
        ? 38
        : effectiveLayout === 'list'
          ? row.entries[0]?.kind === 'snippet'
            ? 48
            : 74
          : cardHeight + 12,
    ),
  );
  useLayoutEffect(() => listViewport.current?.scrollTo(0), [query, filter, layout]);

  const header = selecting ? (
    <Box sx={{ display: 'flex', alignItems: 'center', columnGap: 1, minHeight: 40 }}>
      <Tooltip title="退出选择">
        <IconButton aria-label="退出选择" onClick={() => setSelected(undefined)}>
          <Close />
        </IconButton>
      </Tooltip>
      <Typography variant="subtitle1" sx={{ fontWeight: 600, mr: 'auto' }}>
        已选 {chosen.size} 项
      </Typography>
      <Button
        size="small"
        onClick={() => setSelected(chosen.size === entries.length ? [] : entries.map((entry) => entry.id))}
      >
        {chosen.size === entries.length && entries.length ? '全不选' : '全选'}
      </Button>
      {(
        [
          [
            '加入文件篮',
            <ShoppingBasketOutlined fontSize="small" />,
            () => addToBasket([...chosen]),
            entries.some((entry) => chosen.has(entry.id) && entry.kind === 'snippet'),
          ],
          ['移到分区', <DriveFileMoveOutlined fontSize="small" />, () => setMove([...chosen]), false],
          [
            '删除',
            <DeleteOutline fontSize="small" />,
            () => setDeletion({ ids: [...chosen], operationId: operationId() }),
            false,
          ],
        ] as const
      ).map(([label, icon, action, unavailable]) =>
        narrow ? (
          <Tooltip key={label} title={label}>
            <span>
              <IconButton
                aria-label={label}
                color={label === '删除' ? 'error' : 'default'}
                disabled={disabled || !chosen.size || unavailable}
                onClick={action}
              >
                {icon}
              </IconButton>
            </span>
          </Tooltip>
        ) : (
          <Button
            key={label}
            size="small"
            variant="outlined"
            color={label === '删除' ? 'error' : 'primary'}
            startIcon={icon}
            disabled={disabled || !chosen.size || unavailable}
            onClick={action}
          >
            {label}
          </Button>
        ),
      )}
    </Box>
  ) : (
    <Box sx={{ display: 'flex', alignItems: 'center', columnGap: 1, minHeight: 40 }}>
      <Box sx={{ mr: 'auto', minWidth: 0, display: 'flex', alignItems: 'baseline', columnGap: 1 }}>
        <Typography variant="h6" sx={{ fontWeight: 600, lineHeight: 1.3, minWidth: 0 }} noWrap>
          {heading}
        </Typography>
        {snapshot && filter !== 'settings' && (
          <Typography variant="body2" color="text.secondary" sx={{ flex: 'none' }}>
            {entries.length} 项
          </Typography>
        )}
      </Box>
      {narrow ? (
        <Tooltip title="搜索">
          <IconButton
            aria-label="搜索"
            aria-pressed={searching}
            onClick={() => setSearching((value) => !value)}
          >
            <Search />
          </IconButton>
        </Tooltip>
      ) : (
        <SearchField value={query} onChange={setQuery} />
      )}
      {!narrow && filter !== 'clipboard' && <FileViewToggle mode={view.mode} onChange={view.set} />}
      {compact ? (
        <Tooltip title="文件篮">
          <span>
            <IconButton
              aria-label={`文件篮（${basket.length}）`}
              disabled={!snapshot}
              onClick={() => setShowBasket(true)}
            >
              <Badge badgeContent={basket.length} color="primary">
                <ShoppingBasketOutlined />
              </Badge>
            </IconButton>
          </span>
        </Tooltip>
      ) : (
        <Button
          variant="outlined"
          startIcon={<ShoppingBasketOutlined />}
          disabled={!snapshot}
          onClick={() => setShowBasket(true)}
        >
          文件篮（{basket.length}）
        </Button>
      )}
      <Button
        variant="contained"
        startIcon={<CloudUploadOutlined />}
        endIcon={compact ? undefined : <ArrowDropDown />}
        disabled={disabled}
        aria-haspopup="menu"
        onClick={(event) => setUploadMenu(event.currentTarget)}
        sx={{
          flex: 'none',
          whiteSpace: 'nowrap',
          ...(compact && { minWidth: 0, px: 1.25, '& .MuiButton-startIcon': { m: 0 } }),
        }}
        aria-label="添加文件"
      >
        {compact ? '' : '添加文件'}
      </Button>
    </Box>
  );

  return (
    <Box
      ref={pane}
      className="library-tab"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        bgcolor: 'background.paper',
        // Selection boxes appear on hover where hovering exists, always while selecting.
        '@media (hover: hover)': {
          '& [data-file-card]:hover .library-check, & [data-file-row]:hover .library-check': { opacity: 1 },
        },
        '& .library-check': { opacity: selecting ? 1 : 0, transition: 'opacity 120ms' },
        '& .library-check.Mui-checked, & .library-check.Mui-focusVisible': { opacity: 1 },
      }}
    >
      <Box
        sx={{
          flex: 'none',
          px: narrow ? 1.5 : 3,
          pt: 1.5,
          pb: 1,
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        {header}
        {narrow && searching && !selecting && (
          <Box sx={{ pt: 1 }}>
            <SearchField value={query} onChange={setQuery} autoFocus fullWidth />
          </Box>
        )}
        {narrow && <FilesOrganization mode="chips" view={filter} onView={selectFilter} />}
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {!narrow && <FilesOrganization mode="nav" view={filter} onView={selectFilter} />}
        <FileDropZone
          label="松开以上传到我的文件"
          disabled={disabled || filter === 'settings'}
          onFiles={upload.add}
          sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}
        >
          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              overflowY: filter === 'settings' ? 'auto' : undefined,
              px: narrow ? 1.5 : 3,
              pb: 3,
            }}
          >
            {(busy || upload.busy) && <LinearProgress sx={{ mt: 1, borderRadius: 1 }} />}
            {error && (
              <Alert severity="warning" onClose={() => setError('')} sx={{ mt: 1.5 }}>
                {error}
              </Alert>
            )}
            {!online && (
              <Alert severity="info" sx={{ mt: 1.5 }}>
                等待连接恢复
              </Alert>
            )}
            {!snapshot && online && (
              <Box sx={{ py: 6, textAlign: 'center' }}>
                <Button disabled={busy} onClick={() => void run(refresh)}>
                  加载我的文件
                </Button>
              </Box>
            )}
            <Box sx={{ '&:not(:empty)': { pt: 1.5 } }}>{upload.view}</Box>
            {snapshot && filter !== 'settings' && (
              <Box sx={{ display: 'flex', alignItems: 'center', columnGap: 1, pt: 1.5, pb: 0.5 }}>
                <FilesOrganization mode="source" view={filter} onView={selectFilter} />
                <Box sx={{ flex: 1 }} />
                {narrow && filter !== 'clipboard' && <FileViewToggle mode={view.mode} onChange={view.set} />}
                {!selecting && !!entries.length && !narrow && (
                  <Button size="small" startIcon={<CheckBoxOutlined />} onClick={() => setSelected([])}>
                    选择
                  </Button>
                )}
              </Box>
            )}
            {snapshot && filter === 'clipboard' && !entries.length && (
              <Typography color="text.secondary" sx={{ py: 6, textAlign: 'center' }}>
                还没有剪贴片段
              </Typography>
            )}
            {snapshot &&
              filter !== 'settings' &&
              filter !== 'clipboard' &&
              !entries.length &&
              !pending.length && (
                <EmptyLibrary
                  kind={needle ? 'search' : catalog.length ? 'partition' : 'none'}
                  disabled={disabled}
                  onUpload={upload.pick}
                  onCamera={startCamera}
                />
              )}
            {filter === 'settings' && (
              <FilesOrganization mode="settings" view={filter} onView={selectFilter} />
            )}
            {filter !== 'settings' && (
              <VirtualScroller
                viewportRef={listViewport}
                items={virtualRows}
                sizes={rowSizes}
                enabled
                contentWidth={0}
                className="library-virtual-list"
                label="我的文件"
                itemKey={(item) => item.key}
                onWidth={setListWidth}
                onScroll={() => {}}
                stickyHeader={(item) => item.label}
                renderItem={(item) =>
                  item.header ? (
                    <Typography
                      variant="overline"
                      color="text.secondary"
                      sx={{ display: 'block', lineHeight: '38px' }}
                    >
                      {item.label}
                    </Typography>
                  ) : (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                        gap: 12,
                      }}
                    >
                      {item.jobs.map((job) => {
                        const Component = layout === 'grid' ? FileTile : FileRow;
                        return (
                          <Component
                            key={job.id}
                            id={job.id}
                            name="照片"
                            type="image/png"
                            assetId={job.id}
                            blob={job.preview}
                            localOnly
                            meta={partitionOf(job.origin.kind === 'files' ? job.origin.partitionId : null)}
                            status={photoStatus(undefined, job)}
                            onOpen={() => setPhoto(job.id)}
                          />
                        );
                      })}
                      {item.entries.map((entry) => (
                        <LibraryEntryView
                          key={entry.id}
                          entry={entry}
                          mode={effectiveLayout}
                          meta={entryMeta(entry)}
                          selected={chosen.has(entry.id)}
                          selecting={selecting}
                          open={menu?.id === entry.id}
                          disabled={disabled}
                          inBasket={inBasket.has(entry.id)}
                          basketFull={basket.length >= MAX_BASKET}
                          onOpen={entryActions.open}
                          onSelect={entryActions.select}
                          onLongPress={entryActions.longPress}
                          onBasket={entryActions.basket}
                          onMenu={entryActions.menu}
                        />
                      ))}
                    </div>
                  )
                }
              />
            )}
          </Box>
        </FileDropZone>
      </Box>

      <Menu
        anchorEl={scaledAnchor(uploadMenu)}
        open={!!uploadMenu}
        onClose={() => setUploadMenu(undefined)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ list: { dense: true } }}
      >
        <MenuItem
          onClick={() => {
            setUploadMenu(undefined);
            upload.pick();
          }}
        >
          <ListItemIcon>
            <UploadFileOutlined fontSize="small" />
          </ListItemIcon>
          <ListItemText>从设备选择</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            setUploadMenu(undefined);
            startCamera();
          }}
        >
          <ListItemIcon>
            <PhotoCameraOutlined fontSize="small" />
          </ListItemIcon>
          <ListItemText>摄像头拍照</ListItemText>
        </MenuItem>
      </Menu>
      <FileEntryMenu
        entry={menuEntry}
        anchor={menu?.anchor}
        windowId={windowId}
        onClose={() => setMenu(undefined)}
        onOpen={openPreview}
        onSelect={(entry) => setSelected([entry.id])}
      />
      <Snackbar open={copied} autoHideDuration={1600} onClose={() => setCopied(false)} message="已复制" />
      {camera && (
        <PhotoCapture
          windowId={windowId}
          destination="library"
          {...camera}
          onClose={() => setCamera(undefined)}
        />
      )}
      {move && (
        <PartitionPicker
          title={move.length > 1 ? `移动 ${move.length} 个文件` : '移动文件'}
          partitions={partitions}
          initial={
            move.length === 1 ? (catalog.find((entry) => entry.id === move[0])?.partitionId ?? null) : null
          }
          onClose={() => setMove(undefined)}
          onChoose={(partitionId) => {
            const ids = move;
            setMove(undefined);
            void run(async () => {
              await mutate('library.move', { operationId: operationId(), ids, partitionId });
              setSelected(undefined);
            });
          }}
        />
      )}
      {deletion && (
        <Dialog
          open
          fullWidth
          maxWidth="xs"
          aria-labelledby="delete-library-file"
          onClose={busy ? undefined : () => setDeletion(undefined)}
        >
          <DialogTitle id="delete-library-file">
            {deletion.ids.length > 1 ? `删除 ${deletion.ids.length} 个文件？` : '删除文件？'}
          </DialogTitle>
          <DialogContent>
            {deletion.ids.length === 1 && (
              <Typography sx={{ overflowWrap: 'anywhere' }}>
                {catalog.find((entry) => entry.id === deletion.ids[0])?.name}
              </Typography>
            )}
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              将从我的文件和文件篮删除。页面已接收的副本会保留。
            </Typography>
            {error && (
              <Alert severity="warning" sx={{ mt: 1 }}>
                {error}
              </Alert>
            )}
          </DialogContent>
          <DialogActions>
            <Button autoFocus disabled={busy} onClick={() => setDeletion(undefined)}>
              取消
            </Button>
            <Button
              color="error"
              variant="contained"
              disabled={disabled}
              onClick={() =>
                void run(async () => {
                  await mutate('library.delete', { operationId: deletion.operationId, ids: deletion.ids });
                  setDeletion(undefined);
                  setSelected(undefined);
                })
              }
            >
              删除文件
            </Button>
          </DialogActions>
        </Dialog>
      )}
      {(photoEntry || photoJob) && (
        <PhotoDialog
          entry={photoEntry}
          job={photoJob}
          disabled={disabled}
          onRetake={(entry) => {
            setPhoto(undefined);
            setCamera({ replace: entry, partitionId: entry.partitionId });
          }}
          onClose={() => setPhoto(undefined)}
        />
      )}
      {showBasket && <FileBasketDialog windowId={windowId} onClose={() => setShowBasket(false)} />}
    </Box>
  );
}

function SearchField({
  value,
  onChange,
  autoFocus = false,
  fullWidth = false,
}: {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  fullWidth?: boolean;
}) {
  const autoFocusRef = useAutoFocus<HTMLInputElement>(autoFocus);
  return (
    <TextField
      size="small"
      placeholder="搜索文件名"
      value={value}
      inputRef={autoFocusRef}
      fullWidth={fullWidth}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && value) {
          event.stopPropagation();
          onChange('');
        }
      }}
      sx={fullWidth ? undefined : { width: 220 }}
      slotProps={{
        htmlInput: { 'aria-label': '搜索文件名' },
        input: {
          sx: {
            borderRadius: '8px',
            bgcolor: 'var(--surface-background)',
            '& fieldset': { borderColor: 'transparent' },
          },
          startAdornment: (
            <InputAdornment position="start">
              <Search fontSize="small" />
            </InputAdornment>
          ),
          endAdornment: value ? (
            <InputAdornment position="end">
              <IconButton aria-label="清除搜索" edge="end" onClick={() => onChange('')}>
                <Close fontSize="small" />
              </IconButton>
            </InputAdornment>
          ) : undefined,
        },
      }}
    />
  );
}

function EmptyLibrary({
  kind,
  disabled,
  onUpload,
  onCamera,
}: {
  kind: 'none' | 'partition' | 'search';
  disabled: boolean;
  onUpload: () => void;
  onCamera: () => void;
}) {
  const text = {
    none: ['还没有文件', '上传文件或拍照，之后在网页里上传时可以直接选用。也可以把文件拖到这里。'],
    partition: ['这里还没有文件', '上传到这个分区，或把其他文件移动过来。'],
    search: ['没有找到匹配的文件', '换个关键词试试。'],
  }[kind];
  return (
    <Box
      sx={{
        py: 8,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        columnGap: 1,
        textAlign: 'center',
      }}
    >
      <CloudUploadOutlined sx={{ fontSize: 48, color: 'var(--scrollbar-hover)' }} />
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        {text[0]}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 360 }}>
        {text[1]}
      </Typography>
      {kind !== 'search' && (
        <Box
          sx={{
            display: 'flex',
            columnGap: 1,
            mt: 1.5,
            flexWrap: 'wrap',
            justifyContent: 'center',
          }}
        >
          <Button
            variant="contained"
            startIcon={<UploadFileOutlined />}
            disabled={disabled}
            onClick={onUpload}
          >
            从设备选择
          </Button>
          <Button
            variant="outlined"
            startIcon={<PhotoCameraOutlined />}
            disabled={disabled}
            onClick={onCamera}
          >
            摄像头拍照
          </Button>
        </Box>
      )}
    </Box>
  );
}

export function PhotoDialog({
  entry,
  job,
  disabled,
  onRetake,
  onClose,
}: {
  entry?: LibraryEntry;
  job?: PhotoJob;
  disabled: boolean;
  onRetake: (entry: LibraryEntry) => void;
  onClose: () => void;
}) {
  const { photos } = useLibrary();
  return (
    <Dialog open fullWidth maxWidth="xs" onClose={onClose}>
      <DialogTitle sx={{ overflowWrap: 'anywhere' }}>{entry?.name ?? '照片'}</DialogTitle>
      <DialogContent>
        {entry ? (
          <PhotoOptions key={entry.id} entry={entry} job={job} destination="library" disabled={disabled} />
        ) : job?.error ? (
          <Alert severity="warning">{job.error}</Alert>
        ) : (
          <Typography variant="body2" role="status">
            正在处理照片
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        {job?.retryable && job.state === 'error' && (
          <Button onClick={() => photos.retry(job.id)}>重试</Button>
        )}
        {job && (
          <Button
            disabled={job.state === 'committing'}
            onClick={() => {
              photos.cancel(job.id);
              if (!entry) onClose();
            }}
          >
            {entry ? '取消照片任务' : '移除照片'}
          </Button>
        )}
        {entry && !job && (
          <Button disabled={disabled} startIcon={<PhotoCameraOutlined />} onClick={() => onRetake(entry)}>
            重拍
          </Button>
        )}
        <Button onClick={onClose}>完成</Button>
      </DialogActions>
    </Dialog>
  );
}

interface LibraryRow {
  key: string;
  label: string;
  header: boolean;
  entries: LibraryEntry[];
  jobs: PhotoJob[];
}
interface LibraryEntryProps {
  entry: LibraryEntry;
  mode: 'grid' | 'list';
  meta: string;
  selected: boolean;
  selecting: boolean;
  open: boolean;
  disabled: boolean;
  inBasket: boolean;
  basketFull: boolean;
  onOpen(id: string, anchor: HTMLElement): void;
  onSelect(id: string): void;
  onLongPress(id: string): void;
  onBasket(id: string): void;
  onMenu(id: string, anchor: HTMLElement): void;
}
const LibraryEntryView = memo(
  function LibraryEntryView({
    entry,
    mode,
    meta,
    selected,
    selecting,
    open,
    disabled,
    inBasket,
    basketFull,
    onOpen,
    onSelect,
    onLongPress,
    onBasket,
    onMenu,
  }: LibraryEntryProps) {
    if (entry.kind === 'snippet')
      return (
        <SnippetView
          entry={entry}
          mode={mode}
          meta={meta}
          selected={selected}
          selecting={selecting}
          disabled={disabled}
          onOpen={onOpen}
          onSelect={onSelect}
          onMenu={onMenu}
        />
      );
    const entryCheckbox = (entry: LibraryEntry, tile: boolean) => (
      <Checkbox
        className="library-check"
        checked={selected}
        disabled={disabled}
        onChange={() => onSelect(entry.id)}
        slotProps={{ input: { 'aria-label': `选择 ${entry.name}` } }}
        sx={
          tile
            ? {
                width: 40,
                height: 40,
                '& svg': { bgcolor: 'rgb(255 255 255 / 92%)', borderRadius: '4px' },
              }
            : { width: 40, height: 40 }
        }
      />
    );
    const basketMarker = (entry: LibraryEntry) =>
      inBasket ? (
        <Tooltip title="已在文件篮">
          <Box
            component="span"
            aria-label="已在文件篮"
            sx={{
              width: 24,
              height: 24,
              display: 'grid',
              placeItems: 'center',
              borderRadius: '50%',
              bgcolor: 'primary.main',
              color: '#fff',
              boxShadow: '0 1px 3px rgb(15 23 42 / 25%)',
            }}
          >
            <ShoppingBasket sx={{ fontSize: 14 }} />
          </Box>
        </Tooltip>
      ) : undefined;

    return mode === 'grid' ? (
      <FileTile
        id={entry.id}
        name={entry.name}
        type={entry.type}
        assetId={entry.assetId}
        meta={meta}
        status={photoStatus(entry)}
        selected={selected}
        pressed={selecting ? selected : undefined}
        open={open}
        disabled={disabled}
        marker={basketMarker(entry)}
        start={entryCheckbox(entry, true)}
        onOpen={(anchor) => onOpen(entry.id, anchor)}
        onLongPress={() => onLongPress(entry.id)}
      />
    ) : (
      <FileRow
        id={entry.id}
        name={entry.name}
        type={entry.type}
        assetId={entry.assetId}
        meta={meta}
        detail={entry.detail}
        status={photoStatus(entry)}
        selected={selected}
        pressed={selecting ? selected : undefined}
        disabled={disabled}
        leading={entryCheckbox(entry, false)}
        onOpen={(anchor) => onOpen(entry.id, anchor)}
        onLongPress={() => onLongPress(entry.id)}
        trailing={
          !selecting && (
            <>
              <Tooltip title={inBasket ? '从文件篮移除' : '加入文件篮'}>
                <span>
                  <IconButton
                    aria-label={inBasket ? `从文件篮移除 ${entry.name}` : `加入文件篮 ${entry.name}`}
                    aria-pressed={inBasket}
                    color={inBasket ? 'primary' : 'default'}
                    disabled={disabled || (!inBasket && basketFull)}
                    onClick={() => onBasket(entry.id)}
                  >
                    {inBasket ? (
                      <ShoppingBasket fontSize="small" />
                    ) : (
                      <ShoppingBasketOutlined fontSize="small" />
                    )}
                  </IconButton>
                </span>
              </Tooltip>
              <IconButton
                aria-label={`更多操作 ${entry.name}`}
                aria-haspopup="menu"
                disabled={disabled}
                onClick={(event) => onMenu(entry.id, event.currentTarget)}
              >
                <MoreVert fontSize="small" />
              </IconButton>
            </>
          )
        }
      />
    );
  },
  (previous, next) =>
    Object.keys(previous).every((key) =>
      key === 'entry'
        ? canonicalJson(previous.entry) === canonicalJson(next.entry)
        : previous[key as keyof LibraryEntryProps] === next[key as keyof LibraryEntryProps],
    ),
);
