import {
  Add,
  AppsOutlined,
  ContentPasteOutlined,
  DeleteOutline,
  DownloadOutlined,
  EditOutlined,
  FolderOutlined,
  InboxOutlined,
  LanguageOutlined,
  MoreVert,
  ScheduleOutlined,
  SettingsOutlined,
} from '@mui/icons-material';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import { RemoteKitError } from '../../shared/errors';
import type { LibraryPartition, LibrarySource } from '../../shared/file-library';
import { OverflowText } from '../app/overflow-text';
import { scaledAnchor } from '../app/ui-scale';
import { operationId } from '../control/product-operations';
import { useAutoFocus } from '../editing/local-autofocus';
import { failureError, FailureNote } from '../failures';
import { useLibrary } from './file-library-state';
import {
  filesInView,
  removalCounts,
  sourceAppName,
  sourceChannelName,
  sourceKey,
  type FilesView,
} from './files-app-state';

export function FilesOrganization({
  mode,
  view,
  onView,
}: {
  mode: 'nav' | 'chips' | 'settings' | 'source';
  view: FilesView;
  onView: (view: FilesView) => void;
}) {
  const autoFocusRef = useAutoFocus<HTMLInputElement>();
  const { snapshot, online, mutate, apps } = useLibrary();
  const [edit, setEdit] = useState<{ id?: string; name: string; operationId: string }>();
  const [remove, setRemove] = useState<
    ({ partition: string } | { source: LibrarySource }) & { operationId: string }
  >();
  const [anchor, setAnchor] = useState<HTMLElement>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RemoteKitError | undefined>();
  if (!snapshot) return null;
  const disabled = !online || busy;
  const activeSource =
    view === 'clipboard'
      ? { app: 'clipboard', channel: '' }
      : typeof view === 'object' && 'source' in view
        ? view.source
        : undefined;
  const excluded = (source: LibrarySource) =>
    snapshot.excludedSources.some((item) => sourceKey(item) === sourceKey(source));
  const sourceLabel = (source: LibrarySource) =>
    [sourceAppName(source.app, apps), sourceChannelName(source)].filter(Boolean).join(' › ');
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      setError(failureError(failure));
    } finally {
      setBusy(false);
    }
  }
  const editPartition = (partition?: LibraryPartition) =>
    setEdit({ id: partition?.id, name: partition?.name ?? '', operationId: operationId() });
  const toggleSource = (source: LibrarySource) =>
    void run(() =>
      mutate('library.source', { operationId: operationId(), source, excluded: !excluded(source) }),
    );
  const counts = remove && removalCounts(snapshot, remove);
  const settingsSources = [
    ...snapshot.sources,
    ...snapshot.excludedSources
      .filter((source) => !snapshot.sources.some((item) => sourceKey(item) === sourceKey(source)))
      .map((source) => ({ ...source, count: 0, excluded: true })),
  ];
  if (!settingsSources.some((source) => source.app === 'clipboard'))
    settingsSources.push({ app: 'clipboard', channel: '', count: 0, excluded: false });
  const items: {
    key: string;
    label: string;
    view: FilesView;
    count: number;
    muted?: boolean;
    section?: string;
  }[] = [
    { key: 'all', label: '全部', view: 'all', count: filesInView(snapshot, 'all').length },
    { key: 'recent', label: '最近', view: 'recent', count: filesInView(snapshot, 'recent').length },
    {
      key: 'clipboard',
      label: '剪贴板',
      view: 'clipboard',
      count: filesInView(snapshot, 'clipboard').length,
    },
    ...snapshot.partitions.map((partition) => ({
      key: partition.id,
      label: partition.name,
      view: { partition: partition.id },
      count: snapshot.entries.filter((entry) => entry.partitionId === partition.id).length,
      section: '分区',
    })),
    ...[...snapshot.sources]
      .filter((source) => source.app !== 'clipboard')
      .sort((a, b) => a.app.localeCompare(b.app) || a.channel.localeCompare(b.channel))
      .map((source) => ({
        key: sourceKey(source),
        label: sourceChannelName(source) || sourceAppName(source.app, apps),
        view: { source: { app: source.app, channel: source.channel } },
        count: source.count,
        muted: source.excluded,
        section: sourceAppName(source.app, apps),
      })),
  ];
  const selected = (next: FilesView) => JSON.stringify(view) === JSON.stringify(next);
  return (
    <>
      {mode === 'chips' && (
        <Box
          component="nav"
          aria-label="文件导航"
          sx={{
            display: 'flex',
            overflowX: 'auto',
            py: 1,
            columnGap: 0.75,
            scrollbarWidth: 'none',
            '&::-webkit-scrollbar': { display: 'none' },
            '& > *': { flex: 'none' },
          }}
        >
          {items.map((item) => (
            <Chip
              key={item.key}
              icon={item.view === 'clipboard' ? <ContentPasteOutlined /> : undefined}
              label={`${item.section && item.section !== '分区' ? item.section + ' › ' : ''}${item.label} ${item.count}`}
              color={selected(item.view) ? 'primary' : 'default'}
              variant={selected(item.view) ? 'filled' : 'outlined'}
              sx={{ color: item.muted ? 'text.disabled' : undefined }}
              onClick={() => onView(item.view)}
            />
          ))}
          <Chip icon={<Add />} label="新建分区" disabled={disabled} onClick={() => editPartition()} />
          <Chip
            icon={<SettingsOutlined />}
            label="设置"
            color={view === 'settings' ? 'primary' : 'default'}
            onClick={() => onView('settings')}
          />
        </Box>
      )}
      {mode === 'nav' && (
        <Box
          component="nav"
          aria-label="文件导航"
          sx={{
            width: 200,
            flex: 'none',
            borderRight: '1px solid',
            borderColor: 'divider',
            display: 'flex',
            flexDirection: 'column',
            p: 1,
          }}
        >
          <List dense sx={{ flex: 1, overflowY: 'auto', py: 0 }}>
            {items
              .filter((item) => !item.section)
              .map((item) => (
                <NavRow
                  key={item.key}
                  item={item}
                  icon={
                    item.view === 'clipboard' ? (
                      <ContentPasteOutlined />
                    ) : item.view === 'recent' ? (
                      <ScheduleOutlined />
                    ) : (
                      <InboxOutlined />
                    )
                  }
                  selected={selected(item.view)}
                  onSelect={onView}
                />
              ))}
            <NavHeader
              title="分区"
              action={
                <IconButton
                  size="small"
                  aria-label="新建分区"
                  disabled={disabled}
                  onClick={() => editPartition()}
                >
                  <Add fontSize="small" />
                </IconButton>
              }
            />
            {items
              .filter((item) => item.section === '分区')
              .map((item) => (
                <NavRow
                  key={item.key}
                  item={item}
                  icon={<FolderOutlined />}
                  selected={selected(item.view)}
                  onSelect={onView}
                />
              ))}
            {!snapshot.partitions.length && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', px: 1.5, py: 0.5 }}
              >
                把文件整理到分区，来源被清除时也会保留
              </Typography>
            )}
            {snapshot.sources.length > 0 && <NavHeader title="来源" />}
            {items
              .filter((item) => item.section && item.section !== '分区')
              .map((item) => (
                <NavRow
                  key={item.key}
                  item={item}
                  secondary={item.label === item.section ? undefined : item.section}
                  icon={sourceIcon(item.view)}
                  selected={selected(item.view)}
                  onSelect={onView}
                />
              ))}
          </List>
          <List dense sx={{ py: 0, borderTop: '1px solid', borderColor: 'divider', pt: 0.5 }}>
            <ListItemButton
              selected={view === 'settings'}
              onClick={() => onView('settings')}
              sx={{ borderRadius: 1 }}
            >
              <ListItemIcon sx={{ minWidth: 32 }}>
                <SettingsOutlined fontSize="small" />
              </ListItemIcon>
              <ListItemText primary="设置" />
            </ListItemButton>
          </List>
        </Box>
      )}
      {mode === 'source' && activeSource && (
        <>
          <IconButton aria-label="来源操作" onClick={(event) => setAnchor(event.currentTarget)}>
            <MoreVert />
          </IconButton>
          <Menu anchorEl={scaledAnchor(anchor)} open={!!anchor} onClose={() => setAnchor(undefined)}>
            <MenuItem
              disabled={disabled}
              onClick={() => {
                setAnchor(undefined);
                toggleSource(activeSource);
              }}
            >
              {excluded(activeSource) ? '取消排除来源' : '排除来源'}
            </MenuItem>
            <MenuItem
              disabled={disabled}
              onClick={() => {
                setAnchor(undefined);
                setRemove({ source: activeSource, operationId: operationId() });
              }}
            >
              清除来源中的文件
            </MenuItem>
          </Menu>
        </>
      )}
      {mode === 'settings' && (
        <Box sx={{ py: 2 }}>
          <Typography variant="h6">来源</Typography>
          {settingsSources.map((source) => (
            <Box
              key={sourceKey(source)}
              sx={{
                display: 'flex',
                alignItems: 'center',
                py: 1,
                borderBottom: '1px solid',
                borderColor: 'divider',
              }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography
                  sx={{ overflowWrap: 'anywhere', color: source.excluded ? 'text.disabled' : undefined }}
                >
                  {sourceLabel(source)}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {source.count} 个文件 · {source.excluded ? '已排除' : '自动收集'}
                </Typography>
              </Box>
              <Switch
                checked={!source.excluded}
                disabled={disabled}
                slotProps={{ input: { 'aria-label': `收集 ${sourceLabel(source)}` } }}
                onChange={() => toggleSource(source)}
              />
              <IconButton
                aria-label={`清除 ${sourceLabel(source)}`}
                disabled={disabled}
                onClick={() => setRemove({ source, operationId: operationId() })}
              >
                <DeleteOutline />
              </IconButton>
            </Box>
          ))}
          {!settingsSources.length && (
            <Typography color="text.secondary" sx={{ py: 2 }}>
              还没有来源
            </Typography>
          )}
          <Box sx={{ display: 'flex', alignItems: 'center', mt: 3 }}>
            <Typography variant="h6" sx={{ flex: 1 }}>
              分区管理
            </Typography>
            <Button startIcon={<Add />} disabled={disabled} onClick={() => editPartition()}>
              新建分区
            </Button>
          </Box>
          {snapshot.partitions.map((partition) => (
            <Box key={partition.id} sx={{ display: 'flex', alignItems: 'center', py: 1 }}>
              <Button
                onClick={() => onView({ partition: partition.id })}
                sx={{ mr: 'auto', textTransform: 'none' }}
              >
                {partition.name}（
                {snapshot.entries.filter((entry) => entry.partitionId === partition.id).length}）
              </Button>
              <IconButton
                aria-label={`重命名 ${partition.name}`}
                disabled={disabled}
                onClick={() => editPartition(partition)}
              >
                <EditOutlined />
              </IconButton>
              <IconButton
                aria-label={`删除分区 ${partition.name}`}
                disabled={disabled}
                onClick={() => setRemove({ partition: partition.id, operationId: operationId() })}
              >
                <DeleteOutline />
              </IconButton>
            </Box>
          ))}
        </Box>
      )}
      {error && <FailureNote error={error} context={{ operation: '保存分区', scope: 'surface' }} />}
      {edit && (
        <Dialog open fullWidth maxWidth="xs" onClose={busy ? undefined : () => setEdit(undefined)}>
          <Box
            component="form"
            onSubmit={(event) => {
              event.preventDefault();
              if (disabled || !edit.name.trim()) return;
              void run(async () => {
                await mutate('library.partition', { ...edit, name: edit.name.trim() });
                setEdit(undefined);
              });
            }}
          >
            <DialogTitle>{edit.id ? '重命名分区' : '新建分区'}</DialogTitle>
            <DialogContent>
              <TextField
                inputRef={autoFocusRef}
                fullWidth
                label="分区名称"
                value={edit.name}
                onChange={(event) =>
                  setEdit({ ...edit, name: event.target.value, operationId: operationId() })
                }
                slotProps={{ htmlInput: { maxLength: 120 } }}
                sx={{ mt: 1 }}
              />
              {error && <FailureNote error={error} context={{ operation: '保存分区', scope: 'surface' }} />}
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={() => setEdit(undefined)}>
                取消
              </Button>
              <Button type="submit" disabled={disabled || !edit.name.trim()}>
                保存
              </Button>
            </DialogActions>
          </Box>
        </Dialog>
      )}
      {remove && counts && (
        <Dialog open fullWidth maxWidth="xs" onClose={busy ? undefined : () => setRemove(undefined)}>
          <DialogTitle>{'partition' in remove ? '删除分区？' : '清除来源中的文件？'}</DialogTitle>
          <DialogContent>
            <Typography>
              {'partition' in remove
                ? snapshot.partitions.find((item) => item.id === remove.partition)?.name
                : sourceLabel(remove.source)}
            </Typography>
            <Typography sx={{ mt: 1 }}>
              将删除 {counts.deleted} 个文件，保留 {counts.kept} 个文件。
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              文件篮中的文件会保留。未决选择持有的文件会阻止此操作。
            </Typography>
            {error && <FailureNote error={error} context={{ operation: '保存分区', scope: 'surface' }} />}
          </DialogContent>
          <DialogActions>
            <Button disabled={busy} onClick={() => setRemove(undefined)}>
              取消
            </Button>
            <Button
              color="error"
              disabled={disabled}
              onClick={() =>
                void run(async () => {
                  if ('partition' in remove)
                    await mutate('library.partitionDelete', {
                      operationId: remove.operationId,
                      id: remove.partition,
                    });
                  else
                    await mutate('library.sourcePurge', {
                      operationId: remove.operationId,
                      source: remove.source,
                    });
                  setRemove(undefined);
                })
              }
            >
              确认删除
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </>
  );
}

function NavHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', px: 1.5, pt: 2, pb: 0.5, minHeight: 28 }}>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, flex: 1 }}>
        {title}
      </Typography>
      {action}
    </Box>
  );
}

function NavRow({
  item,
  icon,
  secondary,
  selected,
  onSelect,
}: {
  item: { label: string; view: FilesView; count: number; muted?: boolean };
  icon: React.ReactElement;
  secondary?: string;
  selected: boolean;
  onSelect: (view: FilesView) => void;
}) {
  return (
    <ListItemButton
      selected={selected}
      onClick={() => onSelect(item.view)}
      sx={{ borderRadius: 1, minHeight: 36, color: item.muted ? 'text.disabled' : undefined }}
    >
      <ListItemIcon sx={{ minWidth: 32, color: 'inherit', '& svg': { fontSize: 20 } }}>{icon}</ListItemIcon>
      <ListItemText
        primary={
          <OverflowText component="span" variant="inherit" display="block">
            {item.label}
          </OverflowText>
        }
        secondary={secondary}
        slotProps={{
          secondary: { noWrap: true, variant: 'caption' },
        }}
        sx={{ my: 0 }}
      />
      <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
        {item.count}
      </Typography>
    </ListItemButton>
  );
}

export function sourceIcon(view: FilesView) {
  const app = typeof view === 'object' && 'source' in view ? view.source.app : '';
  if (app === 'download') return <DownloadOutlined />;
  if (app === 'browser') return <LanguageOutlined />;
  if (app === 'files') return <FolderOutlined />;
  return <AppsOutlined />;
}
