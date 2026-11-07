import { diagnostics } from '../media/diagnostics';
import {
  Add,
  AllInboxOutlined,
  ArrowDropDown,
  CheckBoxOutlined,
  Close,
  CloudUploadOutlined,
  DeleteOutline,
  DriveFileMoveOutlined,
  EditOutlined,
  FolderOffOutlined,
  FolderOutlined,
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
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  InputAdornment,
  LinearProgress,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryEntry, LibraryGroup } from '../../shared/file-library';
import { scaledAnchor, useLayoutNarrow } from '../app/ui-scale';
import { operationId } from '../control/product-operations';
import { photoStatus } from './basket-items';
import { FileBasketDialog } from './file-chooser-dialog';
import { dayLabel, formatFileSize, formatTime } from './file-format';
import { canPreviewFile, FileImagePreview } from './file-image-preview';
import {
  basketEntries,
  fileError,
  FileDropZone,
  GroupPicker,
  useDeviceImport,
} from './file-library-controls';
import { useLibrary } from './file-library-state';
import { FileRow, FileTile } from './file-tile';
import { FileViewToggle, useFileView } from './file-view';
import { PhotoCapture } from './photo-library-capture';
import type { PhotoJob } from './photo-job-store';
import { PhotoOptions } from './photo-options';

const PAGE_SIZE = 60;
const MAX_BASKET = 64;

// '*' is every file, null the files without a group, otherwise a group id.
type Filter = string | null;

const matches = (filter: Filter, groupId: string | null) => filter === '*' || groupId === filter;

export function MyFiles({ visible }: { visible: boolean }) {
  const { snapshot, online, refresh, mutate, photos } = useLibrary();
  const pane = useRef<HTMLDivElement>(null);
  const [paneNarrow, setPaneNarrow] = useState(false);
  const narrow = useLayoutNarrow() || paneNarrow;
  const [filter, setFilter] = useState<Filter>('*');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>();
  const [menu, setMenu] = useState<{ anchor: HTMLElement; id: string }>();
  const [uploadMenu, setUploadMenu] = useState<HTMLElement>();
  const [camera, setCamera] = useState<{ groupId?: string | null; replace?: LibraryEntry }>();
  const [cameraGroup, setCameraGroup] = useState(false);
  const [showBasket, setShowBasket] = useState(false);
  const [preview, setPreview] = useState<LibraryEntry>();
  const [photo, setPhoto] = useState<string>();
  const [move, setMove] = useState<string[]>();
  const [deletion, setDeletion] = useState<{ ids: string[]; operationId: string }>();
  const [groupEdit, setGroupEdit] = useState<{ group?: LibraryGroup; name: string }>();

  const groups = snapshot?.groups ?? [];
  const basket = basketEntries(snapshot);
  const inBasket = new Set(basket.map((entry) => entry.id));
  const catalog =
    snapshot?.entries
      .filter((entry) => entry.archived)
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)) ?? [];
  const needle = query.trim().toLowerCase();
  const entries = catalog.filter(
    (entry) => matches(filter, entry.groupId) && (!needle || entry.name.toLowerCase().includes(needle)),
  );
  const pending = needle
    ? []
    : photos.jobs.filter(
        (job) => job.destination === 'library' && !job.replace && matches(filter, job.groupId ?? null),
      );
  const view = useFileView(entries);
  const currentGroup = groups.find((group) => group.id === filter);
  const groupOf = (id: string | null) => groups.find((group) => group.id === id)?.name ?? '未分组';
  const disabled = !online || busy || !snapshot;
  const selecting = selected !== undefined;
  const chosen = new Set(selected);
  const menuEntry = catalog.find((entry) => entry.id === menu?.id);
  const photoEntry = catalog.find((entry) => entry.id === photo);
  const photoJob = photos.jobs.find((job) => job.id === photo || job.replace?.id === photo);
  const reportError = useCallback((message: string) => setError(message), []);
  const upload = useDeviceImport({
    destination: 'library',
    disabled,
    initialGroup: currentGroup?.id ?? null,
    onError: reportError,
  });

  useEffect(() => {
    if (online && visible) void refresh().catch((failure) => diagnostics.record('my-files', failure));
  }, [online, visible]);
  useEffect(() => {
    const node = pane.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const resize = new ResizeObserver(([entry]) => setPaneNarrow(entry.contentRect.width < 640));
    resize.observe(node);
    return () => resize.disconnect();
  }, []);
  useEffect(() => {
    if (visible) return;
    setCamera(undefined);
    setCameraGroup(false);
    setShowBasket(false);
    setMove(undefined);
    setGroupEdit(undefined);
    setDeletion(undefined);
    setMenu(undefined);
    setUploadMenu(undefined);
    setPreview(undefined);
    setPhoto(undefined);
  }, [visible]);
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
  const selectFilter = (next: Filter) => {
    setFilter(next);
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
    if (fresh.length) void saveBasket([...order, ...fresh]);
  };
  const removeFromBasket = (id: string) =>
    void saveBasket(basket.map((entry) => entry.id).filter((value) => value !== id));
  const startCamera = () => {
    if (groups.length) setCameraGroup(true);
    else setCamera({ groupId: null });
  };
  const visibleEntries = entries.slice(0, limit);
  const sections = new Map<string, { entries: LibraryEntry[]; jobs: PhotoJob[] }>();
  if (pending.length) sections.set('今天', { entries: [], jobs: pending });
  for (const entry of visibleEntries) {
    const key = dayLabel(entry.createdAt);
    const section = sections.get(key) ?? { entries: [], jobs: [] };
    section.entries.push(entry);
    sections.set(key, section);
  }
  const counts = new Map<Filter, number>([['*', catalog.length]]);
  for (const entry of catalog) counts.set(entry.groupId, (counts.get(entry.groupId) ?? 0) + 1);
  const filters: { value: Filter; label: string; icon: React.ReactNode }[] = [
    { value: '*', label: '全部文件', icon: <AllInboxOutlined fontSize="small" /> },
    { value: null, label: '未分组', icon: <FolderOffOutlined fontSize="small" /> },
    ...groups.map((group) => ({
      value: group.id,
      label: group.name,
      icon: <FolderOutlined fontSize="small" />,
    })),
  ];
  const heading = needle
    ? `搜索“${query.trim()}”`
    : (filters.find((item) => item.value === filter)?.label ?? '全部文件');

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
    else if (entry.photo?.pending) setPhoto(entry.id);
    else setMenu({ anchor, id: entry.id });
  };
  const entryMeta = (entry: LibraryEntry) =>
    [
      formatFileSize(entry.size),
      formatTime(entry.createdAt),
      groups.length && (filter === '*' || needle) ? groupOf(entry.groupId) : '',
    ]
      .filter(Boolean)
      .join(' · ');

  const header = selecting ? (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 40 }}>
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
          ['移动', <DriveFileMoveOutlined fontSize="small" />, () => setMove([...chosen]), !groups.length],
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
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 40 }}>
      <Box sx={{ mr: 'auto', minWidth: 0 }}>
        <Typography variant="h6" sx={{ fontWeight: 600, lineHeight: 1.3 }}>
          我的文件
        </Typography>
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
      {narrow ? (
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
        endIcon={narrow ? undefined : <ArrowDropDown />}
        disabled={disabled}
        aria-haspopup="menu"
        onClick={(event) => setUploadMenu(event.currentTarget)}
        sx={narrow ? { minWidth: 0, px: 1.25, '& .MuiButton-startIcon': { m: 0 } } : undefined}
        aria-label="添加文件"
      >
        {narrow ? '' : '添加文件'}
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
        {narrow && snapshot && (
          <Box
            role="tablist"
            aria-label="分组"
            sx={{
              display: 'flex',
              gap: 0.75,
              overflowX: 'auto',
              pt: 1,
              pb: 0.25,
              scrollbarWidth: 'none',
              '&::-webkit-scrollbar': { display: 'none' },
            }}
          >
            {filters.map((item) => (
              <Chip
                key={String(item.value)}
                role="tab"
                aria-selected={filter === item.value}
                label={`${item.label} ${counts.get(item.value) ?? 0}`}
                color={filter === item.value ? 'primary' : 'default'}
                variant={filter === item.value ? 'filled' : 'outlined'}
                onClick={() => selectFilter(item.value)}
                sx={{ flex: 'none' }}
              />
            ))}
            <Chip
              icon={<Add />}
              label="新建分组"
              variant="outlined"
              disabled={disabled}
              onClick={() => setGroupEdit({ name: '' })}
              sx={{ flex: 'none' }}
            />
          </Box>
        )}
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {!narrow && snapshot && (
          <Box
            component="nav"
            aria-label="分组"
            sx={{
              width: 220,
              flex: 'none',
              overflowY: 'auto',
              borderRight: '1px solid',
              borderColor: 'divider',
              p: 1,
            }}
          >
            <List dense disablePadding>
              {filters.map((item) => (
                <ListItemButton
                  key={String(item.value)}
                  selected={filter === item.value}
                  onClick={() => selectFilter(item.value)}
                  sx={{ borderRadius: '8px', mb: '2px' }}
                >
                  <ListItemIcon sx={{ minWidth: 34 }}>{item.icon}</ListItemIcon>
                  <ListItemText
                    primary={item.label}
                    slotProps={{ primary: { noWrap: true, title: item.label } }}
                  />
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                    {counts.get(item.value) ?? 0}
                  </Typography>
                </ListItemButton>
              ))}
              <ListItemButton
                disabled={disabled}
                onClick={() => setGroupEdit({ name: '' })}
                sx={{ borderRadius: '8px', color: 'primary.main' }}
              >
                <ListItemIcon sx={{ minWidth: 34, color: 'inherit' }}>
                  <Add fontSize="small" />
                </ListItemIcon>
                <ListItemText primary="新建分组" />
              </ListItemButton>
            </List>
          </Box>
        )}
        <FileDropZone
          label="松开以上传到我的文件"
          disabled={disabled}
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
            {snapshot && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pt: 2, pb: 0.5 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }} noWrap>
                  {heading}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ flex: 'none' }}>
                  {entries.length} 个文件
                </Typography>
                {currentGroup && !needle && (
                  <Tooltip title="重命名分组">
                    <IconButton
                      aria-label="重命名分组"
                      disabled={disabled}
                      onClick={() => setGroupEdit({ group: currentGroup, name: currentGroup.name })}
                    >
                      <EditOutlined fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
                <Box sx={{ flex: 1 }} />
                {narrow && <FileViewToggle mode={view.mode} onChange={view.set} />}
                {!selecting && !!entries.length && !narrow && (
                  <Button size="small" startIcon={<CheckBoxOutlined />} onClick={() => setSelected([])}>
                    选择
                  </Button>
                )}
              </Box>
            )}
            {snapshot && !entries.length && !pending.length && (
              <EmptyLibrary
                kind={needle ? 'search' : catalog.length ? 'group' : 'none'}
                disabled={disabled}
                onUpload={upload.pick}
                onCamera={startCamera}
              />
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
                        meta={groupOf(job.groupId ?? null)}
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
                        meta={groupOf(job.groupId ?? null)}
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
      {visible && (
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
                {formatFileSize(menuEntry.size)} · {groupOf(menuEntry.groupId)}
              </Typography>
            </Box>,
            <Divider key="divider" />,
            canPreviewFile(menuEntry) && (
              <MenuItem
                key="view"
                onClick={() => {
                  setPreview(menuEntry);
                  setMenu(undefined);
                }}
              >
                <ListItemIcon>
                  <VisibilityOutlined fontSize="small" />
                </ListItemIcon>
                <ListItemText>查看大图</ListItemText>
              </MenuItem>
            ),
            menuEntry.photo && (
              <MenuItem
                key="photo"
                onClick={() => {
                  setPhoto(menuEntry.id);
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
              disabled={!groups.length}
              onClick={() => {
                setMove([menuEntry.id]);
                setMenu(undefined);
              }}
            >
              <ListItemIcon>
                <DriveFileMoveOutlined fontSize="small" />
              </ListItemIcon>
              <ListItemText>移动到分组…</ListItemText>
            </MenuItem>,
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
      )}
      {visible && camera && (
        <PhotoCapture destination="library" {...camera} onClose={() => setCamera(undefined)} />
      )}
      {visible && cameraGroup && (
        <GroupPicker
          title="照片保存到哪个分组？"
          groups={groups}
          initial={currentGroup?.id ?? null}
          disabled={disabled}
          onClose={() => setCameraGroup(false)}
          onChoose={(groupId) => {
            setCameraGroup(false);
            setCamera({ groupId });
          }}
        />
      )}
      {visible && move && (
        <GroupPicker
          title={move.length > 1 ? `移动 ${move.length} 个文件` : '移动文件'}
          groups={groups}
          initial={
            move.length === 1 ? (catalog.find((entry) => entry.id === move[0])?.groupId ?? null) : null
          }
          onClose={() => setMove(undefined)}
          onChoose={(groupId) => {
            const ids = move;
            setMove(undefined);
            void run(async () => {
              await mutate('library.move', { operationId: operationId(), ids, groupId });
              setSelected(undefined);
            });
          }}
        />
      )}
      {visible && deletion && (
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
      {visible && groupEdit && (
        <Dialog open fullWidth maxWidth="xs" onClose={() => setGroupEdit(undefined)}>
          <Box
            component="form"
            onSubmit={(event) => {
              event.preventDefault();
              if (disabled || !groupEdit.name.trim()) return;
              const { group, name } = groupEdit;
              setGroupEdit(undefined);
              void run(async () => {
                await mutate('library.group', {
                  operationId: operationId(),
                  id: group?.id,
                  name: name.trim(),
                });
              });
            }}
          >
            <DialogTitle>{groupEdit.group ? '重命名分组' : '新建分组'}</DialogTitle>
            <DialogContent>
              <TextField
                autoFocus
                fullWidth
                label="分组名称"
                size="small"
                value={groupEdit.name}
                slotProps={{ htmlInput: { maxLength: 80 } }}
                sx={{ mt: 1 }}
                onChange={(event) => setGroupEdit({ ...groupEdit, name: event.target.value })}
              />
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setGroupEdit(undefined)}>取消</Button>
              <Button type="submit" variant="contained" disabled={disabled || !groupEdit.name.trim()}>
                保存
              </Button>
            </DialogActions>
          </Box>
        </Dialog>
      )}
      {visible && (photoEntry || photoJob) && (
        <PhotoDialog
          entry={photoEntry}
          job={photoJob}
          disabled={disabled}
          onRetake={(entry) => {
            setPhoto(undefined);
            setCamera({ replace: entry, groupId: entry.groupId });
          }}
          onClose={() => setPhoto(undefined)}
        />
      )}
      {visible && showBasket && <FileBasketDialog onClose={() => setShowBasket(false)} />}
      {visible && preview && <FileImagePreview entry={preview} onClose={() => setPreview(undefined)} />}
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
          sx: { borderRadius: '8px', bgcolor: '#f2f4f7', '& fieldset': { borderColor: 'transparent' } },
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
  kind: 'none' | 'group' | 'search';
  disabled: boolean;
  onUpload: () => void;
  onCamera: () => void;
}) {
  const text = {
    none: ['还没有文件', '上传文件或拍照，之后在网页里上传时可以直接选用。也可以把文件拖到这里。'],
    group: ['这里还没有文件', '上传到这个分组，或把其他文件移动过来。'],
    search: ['没有找到匹配的文件', '换个关键词试试。'],
  }[kind];
  return (
    <Box
      sx={{
        py: 8,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1,
        textAlign: 'center',
      }}
    >
      <CloudUploadOutlined sx={{ fontSize: 48, color: '#9aa6b5' }} />
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        {text[0]}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 360 }}>
        {text[1]}
      </Typography>
      {kind !== 'search' && (
        <Box sx={{ display: 'flex', gap: 1, mt: 1.5, flexWrap: 'wrap', justifyContent: 'center' }}>
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
