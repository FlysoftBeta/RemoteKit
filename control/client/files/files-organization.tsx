import { Add, DeleteOutline, EditOutlined, MoreVert, SettingsOutlined } from '@mui/icons-material';
import {
  Alert,
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
  ListItemText,
  Menu,
  MenuItem,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import type { LibraryPartition, LibrarySource } from '../../shared/file-library';
import { scaledAnchor } from '../app/ui-scale';
import { operationId } from '../control/product-operations';
import { fileError } from './file-library-controls';
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
  const { snapshot, online, mutate, apps } = useLibrary();
  const [edit, setEdit] = useState<{ id?: string; name: string; operationId: string }>();
  const [remove, setRemove] = useState<
    ({ partition: string } | { source: LibrarySource }) & { operationId: string }
  >();
  const [anchor, setAnchor] = useState<HTMLElement>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!snapshot) return null;
  const disabled = !online || busy;
  const activeSource = typeof view === 'object' && 'source' in view ? view.source : undefined;
  const excluded = (source: LibrarySource) =>
    snapshot.excludedSources.some((item) => sourceKey(item) === sourceKey(source));
  const sourceLabel = (source: LibrarySource) =>
    [sourceAppName(source.app, apps), sourceChannelName(source)].filter(Boolean).join(' › ');
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(fileError(failure));
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
    ...snapshot.partitions.map((partition) => ({
      key: partition.id,
      label: partition.name,
      view: { partition: partition.id },
      count: snapshot.entries.filter((entry) => entry.partitionId === partition.id).length,
      section: '分区',
    })),
    ...[...snapshot.sources]
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
          <List dense sx={{ flex: 1, overflowY: 'auto' }}>
            {items.map((item, index) => (
              <Box key={item.key}>
                {item.section && item.section !== items[index - 1]?.section && (
                  <Typography
                    variant="overline"
                    color="text.secondary"
                    sx={{ display: 'block', px: 1, mt: 1 }}
                  >
                    {item.section === '分区' ? '分区' : `来源 · ${item.section}`}
                  </Typography>
                )}
                <ListItemButton
                  selected={selected(item.view)}
                  onClick={() => onView(item.view)}
                  sx={{ borderRadius: 1, color: item.muted ? 'text.disabled' : undefined }}
                >
                  <ListItemText
                    primary={item.label}
                    slotProps={{ primary: { noWrap: true, title: item.label } }}
                  />
                  <Typography variant="caption" sx={{ ml: 1 }}>
                    {item.count}
                  </Typography>
                </ListItemButton>
              </Box>
            ))}
            <ListItemButton disabled={disabled} onClick={() => editPartition()}>
              <Add fontSize="small" sx={{ mr: 1 }} />
              <ListItemText primary="新建分区" />
            </ListItemButton>
          </List>
          <Button
            startIcon={<SettingsOutlined />}
            onClick={() => onView('settings')}
            sx={{ justifyContent: 'flex-start', mt: 1 }}
          >
            设置
          </Button>
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
      {error && (
        <Alert severity="warning" onClose={() => setError('')}>
          {error}
        </Alert>
      )}
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
                autoFocus
                fullWidth
                label="分区名称"
                value={edit.name}
                onChange={(event) =>
                  setEdit({ ...edit, name: event.target.value, operationId: operationId() })
                }
                slotProps={{ htmlInput: { maxLength: 120 } }}
                sx={{ mt: 1 }}
              />
              {error && (
                <Alert severity="warning" sx={{ mt: 1 }}>
                  {error}
                </Alert>
              )}
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
            {error && (
              <Alert severity="warning" sx={{ mt: 1 }}>
                {error}
              </Alert>
            )}
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
