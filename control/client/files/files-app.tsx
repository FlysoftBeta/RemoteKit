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
  TuneOutlined,
  UploadFileOutlined,
  VisibilityOutlined,
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
  Divider,
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
} from '@mui/material';
import React, { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryEntry } from '../../shared/file-library';
import { scaledAnchor } from '../app/ui-scale';
import { operationId } from '../control/product-operations';
import { photoStatus } from './basket-items';
import { FileBasketDialog } from './file-chooser-dialog';
import { dayLabel, formatFileSize, formatTime } from './file-format';
import { canPreviewFile, FileImagePreview } from './file-image-preview';
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
import {
  filesInView,
  readFilesState,
  sourceAppName,
  sourceChannelName,
  type FilesView,
} from './files-app-state';
import { FilesOrganization } from './files-organization';

const PAGE_SIZE = 60;
const MAX_BASKET = 64;

export function FilesApp({
  windowId,
  state,
  onState,
  previewEntryId,
  previewRequestId,
}: {
  windowId: string;
  state: unknown;
  onState(state: unknown): void;
  previewEntryId?: string;
  previewRequestId?: string;
}): JSX.Element {
  const { snapshot, online, refresh, mutate, photos, recordUsage, apps } = useLibrary();
  const restored = readFilesState(state);
  const pane = useRef<HTMLDivElement>(null);
  const [paneWidth, setPaneWidth] = useState(Infinity);
  // narrow: chips replace the side navigation; compact: header actions become icons.
  const narrow = paneWidth < 600;
  const compact = paneWidth < 900;
  const filter = restored.view;
  const query = restored.query;
  const setQuery = (query: string) => onState({ ...restored, query: query.slice(0, 512) });
  const [searching, setSearching] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>();
  const [menu, setMenu] = useState<{ anchor: HTMLElement; id: string }>();
  const [uploadMenu, setUploadMenu] = useState<HTMLElement>();
  const [camera, setCamera] = useState<{ partitionId?: string | null; replace?: LibraryEntry }>();
  const [showBasket, setShowBasket] = useState(false);
  const [preview, setPreview] = useState<LibraryEntry>();
  const [photo, setPhoto] = useState<string>();
  const [move, setMove] = useState<string[]>();
  const [deletion, setDeletion] = useState<{ ids: string[]; operationId: string }>();

  const partitions = snapshot?.partitions ?? [];
  const basket = basketEntries(snapshot);
  const inBasket = new Set(basket.map((entry) => entry.id));
  const catalog = snapshot?.entries ?? [];
  const needle = query.trim().toLowerCase();
  const entries = (snapshot ? filesInView(snapshot, filter) : []).filter(
    (entry) => !needle || entry.name.toLowerCase().includes(needle),
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
  const view = {
    mode: restored.layout === 'grid' ? ('cards' as const) : ('list' as const),
    set: (mode: 'cards' | 'list') => onState({ ...restored, layout: mode === 'cards' ? 'grid' : 'list' }),
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
    if (online) void refresh().catch((failure) => diagnostics.record('my-files', failure));
  }, [online]);
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

  async function run(action: () => Promise<void>) {
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
    onState({ ...restored, view: next });
    setLimit(PAGE_SIZE);
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
  const visibleEntries = entries.slice(0, limit);
  const sections = new Map<string, { entries: LibraryEntry[]; jobs: PhotoJob[] }>();
  if (pending.length) sections.set('今天', { entries: [], jobs: pending });
  for (const entry of visibleEntries) {
    const key = dayLabel(entry.createdAt);
    const section = sections.get(key) ?? { entries: [], jobs: [] };
    section.entries.push(entry);
    sections.set(key, section);
  }
  const heading = needle
    ? `搜索“${query.trim()}”`
    : filter === 'settings'
      ? '设置'
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
    if (entry.photo) setPhoto(entry.id);
    else setPreview(entry);
    void recordUsage(entry.id, windowId).catch((failure) => diagnostics.record('file-usage', failure));
  };
  const launchedPreview = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!previewEntryId || !previewRequestId || launchedPreview.current === previewRequestId) return;
    const entry = catalog.find((item) => item.id === previewEntryId);
    if (!entry) return;
    launchedPreview.current = previewRequestId;
    openPreview(entry);
  }, [previewEntryId, previewRequestId, snapshot]);
  const entryCheckbox = (entry: LibraryEntry, tile: boolean) => (
    <Checkbox
      className="library-check"
      checked={chosen.has(entry.id)}
      disabled={disabled}
      onChange={() => toggleSelected(entry.id)}
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
    inBasket.has(entry.id) ? (
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
  const openEntry = (entry: LibraryEntry, anchor: HTMLElement) => {
    if (selecting) toggleSelected(entry.id);
    else if (entry.photo?.pending) openPreview(entry);
    else setMenu({ anchor, id: entry.id });
  };
  const entryMeta = (entry: LibraryEntry) =>
    [
      formatFileSize(entry.size),
      formatTime(entry.createdAt),
      entry.source
        ? [sourceAppName(entry.source.app, apps), sourceChannelName(entry.source)].filter(Boolean).join(' / ')
        : '已整理',
      partitions.length && (!currentPartition || needle) ? partitionOf(entry.partitionId) : '',
    ]
      .filter(Boolean)
      .join(' · ');

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
          ['加入文件篮', <ShoppingBasketOutlined fontSize="small" />, () => addToBasket([...chosen]), false],
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
            {entries.length} 个文件
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
      {!narrow && <FileViewToggle mode={view.mode} onChange={view.set} />}
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
          <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: narrow ? 1.5 : 3, pb: 3 }}>
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
                {narrow && <FileViewToggle mode={view.mode} onChange={view.set} />}
                {!selecting && !!entries.length && !narrow && (
                  <Button size="small" startIcon={<CheckBoxOutlined />} onClick={() => setSelected([])}>
                    选择
                  </Button>
                )}
              </Box>
            )}
            {snapshot && filter !== 'settings' && !entries.length && !pending.length && (
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
            {[...sections].map(([label, section]) => (
              <Box key={label} component="section" aria-label={label}>
                <Typography
                  variant="overline"
                  color="text.secondary"
                  sx={{
                    display: 'block',
                    position: 'sticky',
                    top: 0,
                    zIndex: 2,
                    bgcolor: 'background.paper',
                    pt: 1.5,
                    pb: 0.75,
                    lineHeight: '20px',
                    fontWeight: 600,
                    letterSpacing: 0.5,
                  }}
                >
                  {label}
                </Typography>
                {view.mode === 'cards' ? (
                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: `repeat(auto-fill, minmax(${narrow ? 136 : 160}px, 1fr))`,
                      gap: 1.5,
                    }}
                  >
                    {section.jobs.map((job) => (
                      <FileTile
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
                    ))}
                    {section.entries.map((entry) => (
                      <FileTile
                        key={entry.id}
                        id={entry.id}
                        name={entry.name}
                        type={entry.type}
                        assetId={entry.assetId}
                        meta={entryMeta(entry)}
                        status={photoStatus(entry)}
                        selected={chosen.has(entry.id)}
                        pressed={selecting ? chosen.has(entry.id) : undefined}
                        open={menu?.id === entry.id}
                        disabled={disabled}
                        marker={basketMarker(entry)}
                        start={entryCheckbox(entry, true)}
                        onOpen={(anchor) => openEntry(entry, anchor)}
                        onLongPress={() =>
                          setSelected((current = []) =>
                            current.includes(entry.id) ? current : [...current, entry.id],
                          )
                        }
                      />
                    ))}
                  </Box>
                ) : (
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    {section.jobs.map((job) => (
                      <FileRow
                        key={job.id}
                        id={job.id}
                        name="照片"
                        type="image/png"
                        assetId={job.id}
                        blob={job.preview}
                        localOnly
                        meta={partitionOf(job.origin.kind === 'files' ? job.origin.partitionId : null)}
                        status={photoStatus(undefined, job)}
                        leading={<Box sx={{ width: 40 }} />}
                        onOpen={() => setPhoto(job.id)}
                      />
                    ))}
                    {section.entries.map((entry) => (
                      <FileRow
                        key={entry.id}
                        id={entry.id}
                        name={entry.name}
                        type={entry.type}
                        assetId={entry.assetId}
                        meta={entryMeta(entry)}
                        status={photoStatus(entry)}
                        selected={chosen.has(entry.id)}
                        pressed={selecting ? chosen.has(entry.id) : undefined}
                        disabled={disabled}
                        leading={entryCheckbox(entry, false)}
                        onOpen={(anchor) => openEntry(entry, anchor)}
                        onLongPress={() =>
                          setSelected((current = []) =>
                            current.includes(entry.id) ? current : [...current, entry.id],
                          )
                        }
                        trailing={
                          !selecting && (
                            <>
                              <Tooltip title={inBasket.has(entry.id) ? '从文件篮移除' : '加入文件篮'}>
                                <span>
                                  <IconButton
                                    aria-label={
                                      inBasket.has(entry.id)
                                        ? `从文件篮移除 ${entry.name}`
                                        : `加入文件篮 ${entry.name}`
                                    }
                                    aria-pressed={inBasket.has(entry.id)}
                                    color={inBasket.has(entry.id) ? 'primary' : 'default'}
                                    disabled={
                                      disabled || (!inBasket.has(entry.id) && basket.length >= MAX_BASKET)
                                    }
                                    onClick={() =>
                                      inBasket.has(entry.id)
                                        ? removeFromBasket(entry.id)
                                        : addToBasket([entry.id])
                                    }
                                  >
                                    {inBasket.has(entry.id) ? (
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
                                onClick={(event) => setMenu({ anchor: event.currentTarget, id: entry.id })}
                              >
                                <MoreVert fontSize="small" />
                              </IconButton>
                            </>
                          )
                        }
                      />
                    ))}
                  </Box>
                )}
              </Box>
            ))}
            {entries.length > limit && <LoadMore onVisible={() => setLimit((value) => value + PAGE_SIZE)} />}
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
      {
        <Menu
          anchorEl={scaledAnchor(menu?.anchor)}
          open={!!menuEntry && !disabled}
          onClose={() => setMenu(undefined)}
          slotProps={{ list: { dense: true } }}
        >
          {menuEntry && [
            <Box key="title" sx={{ px: 2, pt: 0.5, pb: 1, maxWidth: 280 }}>
              <Typography variant="subtitle2" sx={{ overflowWrap: 'anywhere' }}>
                {menuEntry.name}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {dayLabel(menuEntry.createdAt)} {formatTime(menuEntry.createdAt)} ·{' '}
                {formatFileSize(menuEntry.size)} · {partitionOf(menuEntry.partitionId)}
              </Typography>
            </Box>,
            <Divider key="divider" />,
            <MenuItem
              key="view"
              onClick={() => {
                openPreview(menuEntry);
                setMenu(undefined);
              }}
            >
              <ListItemIcon>
                <VisibilityOutlined fontSize="small" />
              </ListItemIcon>
              <ListItemText>{canPreviewFile(menuEntry) ? '查看大图' : '预览'}</ListItemText>
            </MenuItem>,
            menuEntry.photo && (
              <MenuItem
                key="photo"
                onClick={() => {
                  openPreview(menuEntry);
                  setMenu(undefined);
                }}
              >
                <ListItemIcon>
                  <TuneOutlined fontSize="small" />
                </ListItemIcon>
                <ListItemText>照片详情</ListItemText>
              </MenuItem>
            ),
            <MenuItem
              key="basket"
              disabled={!inBasket.has(menuEntry.id) && basket.length >= MAX_BASKET}
              onClick={() => {
                if (inBasket.has(menuEntry.id)) removeFromBasket(menuEntry.id);
                else addToBasket([menuEntry.id]);
                setMenu(undefined);
              }}
            >
              <ListItemIcon>
                <ShoppingBasketOutlined fontSize="small" />
              </ListItemIcon>
              <ListItemText>{inBasket.has(menuEntry.id) ? '从文件篮移除' : '加入文件篮'}</ListItemText>
            </MenuItem>,
            <MenuItem
              key="move"
              onClick={() => {
                setMove([menuEntry.id]);
                setMenu(undefined);
              }}
            >
              <ListItemIcon>
                <DriveFileMoveOutlined fontSize="small" />
              </ListItemIcon>
              <ListItemText>移到分区…</ListItemText>
            </MenuItem>,
            menuEntry.partitionId !== null && (
              <MenuItem
                key="unpartition"
                onClick={() => {
                  const id = menuEntry.id;
                  setMenu(undefined);
                  void run(async () => {
                    await mutate('library.move', {
                      operationId: operationId(),
                      ids: [id],
                      partitionId: null,
                    });
                  });
                }}
              >
                移出分区
              </MenuItem>
            ),
            <MenuItem
              key="select"
              onClick={() => {
                setSelected([menuEntry.id]);
                setMenu(undefined);
              }}
            >
              <ListItemIcon>
                <CheckBoxOutlined fontSize="small" />
              </ListItemIcon>
              <ListItemText>选择多个</ListItemText>
            </MenuItem>,
            <Divider key="divider-delete" />,
            <MenuItem
              key="delete"
              sx={{ color: 'error.main' }}
              onClick={() => {
                setDeletion({ ids: [menuEntry.id], operationId: operationId() });
                setMenu(undefined);
              }}
            >
              <ListItemIcon sx={{ color: 'inherit' }}>
                <DeleteOutline fontSize="small" />
              </ListItemIcon>
              <ListItemText>删除文件</ListItemText>
            </MenuItem>,
          ]}
        </Menu>
      }
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
      {preview &&
        (canPreviewFile(preview) ? (
          <FileImagePreview entry={preview} onClose={() => setPreview(undefined)} />
        ) : (
          <Dialog open fullWidth maxWidth="xs" onClose={() => setPreview(undefined)}>
            <DialogTitle sx={{ overflowWrap: 'anywhere' }}>{preview.name}</DialogTitle>
            <DialogContent>
              <Typography>
                {preview.type || '文件'} · {formatFileSize(preview.size)}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                此类型暂不支持内容预览，可加入文件篮供网页选择。
              </Typography>
            </DialogContent>
            <DialogActions>
              <Button
                disabled={disabled || inBasket.has(preview.id)}
                onClick={() => addToBasket([preview.id])}
              >
                加入文件篮
              </Button>
              <Button onClick={() => setPreview(undefined)}>返回</Button>
            </DialogActions>
          </Dialog>
        ))}
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
  return (
    <TextField
      size="small"
      placeholder="搜索文件名"
      value={value}
      autoFocus={autoFocus}
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

function LoadMore({ onVisible }: { onVisible: () => void }) {
  const sentinel = useRef<HTMLDivElement>(null);
  const latest = useRef(onVisible);
  latest.current = onVisible;
  useEffect(() => {
    const node = sentinel.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && latest.current());
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <Box ref={sentinel} sx={{ py: 2, textAlign: 'center' }}>
      <Button onClick={() => latest.current()}>显示更多</Button>
    </Box>
  );
}

function PhotoDialog({
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
