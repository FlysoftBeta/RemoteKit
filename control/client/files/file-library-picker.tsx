import { ArrowBack, CheckCircle, Search } from '@mui/icons-material';
import { Box, Button, Chip, IconButton, InputAdornment, TextField, Typography } from '@mui/material';
import { useState } from 'react';
import type { LibraryEntry } from '../../shared/file-library';
import { formatFileSize } from './file-format';
import { FileTile } from './file-tile';
import { useLibrary } from './file-library-state';
import { filesInView, sourceAppName, sourceChannelName, sourceKey, type FilesView } from './files-app-state';

const PAGE = 48;

// Picks files from My Files into the basket: newest first, filter by name, several at once in
// the order they were picked.
export function FileLibraryPicker({
  entries,
  capacity,
  onAdd,
  onClose,
}: {
  entries: LibraryEntry[];
  capacity: number;
  onAdd: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const { snapshot, apps } = useLibrary();
  const [filter, setFilter] = useState<FilesView>('all');
  const needle = query.trim().toLowerCase();
  const allowed = new Set(snapshot ? filesInView(snapshot, filter).map((entry) => entry.id) : []);
  const shown = entries.filter(
    (entry) => allowed.has(entry.id) && (!needle || entry.name.toLowerCase().includes(needle)),
  );
  const valid = picked.filter((id) => entries.some((entry) => entry.id === id));
  const full = valid.length >= capacity;
  const toggle = (id: string) =>
    setPicked((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : full ? current : [...current, id],
    );
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, pt: 0.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <IconButton aria-label="返回" onClick={onClose}>
          <ArrowBack fontSize="small" />
        </IconButton>
        <Typography variant="subtitle2" sx={{ flex: 1 }}>
          从我的文件选择
        </Typography>
      </Box>
      <Box
        aria-label="来源和分区筛选"
        sx={{
          display: 'flex',
          overflowX: 'auto',
          pb: 0.5,
          '& > *': { flex: 'none' },
          columnGap: 0.5,
        }}
      >
        <Chip
          size="small"
          label="全部"
          color={filter === 'all' ? 'primary' : 'default'}
          onClick={() => {
            setFilter('all');
            setLimit(PAGE);
          }}
        />
        {snapshot?.partitions.map((partition) => (
          <Chip
            key={partition.id}
            size="small"
            label={`分区 · ${partition.name}`}
            color={
              typeof filter === 'object' && 'partition' in filter && filter.partition === partition.id
                ? 'primary'
                : 'default'
            }
            onClick={() => {
              setFilter({ partition: partition.id });
              setLimit(PAGE);
            }}
          />
        ))}
        {snapshot?.sources.map((source) => (
          <Chip
            key={sourceKey(source)}
            size="small"
            label={[sourceAppName(source.app, apps), sourceChannelName(source)].filter(Boolean).join(' › ')}
            color={
              typeof filter === 'object' &&
              'source' in filter &&
              sourceKey(filter.source) === sourceKey(source)
                ? 'primary'
                : 'default'
            }
            sx={{ color: source.excluded ? 'text.disabled' : undefined }}
            onClick={() => {
              setFilter({ source });
              setLimit(PAGE);
            }}
          />
        ))}
      </Box>
      {entries.length > 6 && (
        <TextField
          size="small"
          placeholder="搜索文件名"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(PAGE);
          }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <Search fontSize="small" />
                </InputAdornment>
              ),
            },
            htmlInput: { 'aria-label': '搜索文件名' },
          }}
        />
      )}
      {!shown.length ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
          {entries.length ? '没有匹配的文件' : '我的文件里没有可加入的文件'}
        </Typography>
      ) : (
        <Box
          role="group"
          aria-label="我的文件"
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))',
            gap: 1,
            maxHeight: 260,
            overflowY: 'auto',
            p: '2px',
          }}
        >
          {shown.slice(0, limit).map((entry) => {
            const order = valid.indexOf(entry.id);
            return (
              <FileTile
                key={entry.id}
                compact
                id={entry.id}
                name={entry.name}
                type={entry.type}
                assetId={entry.assetId}
                meta={formatFileSize(entry.size)}
                selected={order >= 0}
                pressed={order >= 0}
                disabled={order < 0 && full}
                index={order >= 0 ? order + 1 : undefined}
                marker={
                  order >= 0 ? (
                    <CheckCircle
                      color="primary"
                      sx={{ fontSize: 20, bgcolor: 'var(--surface)', borderRadius: '50%' }}
                    />
                  ) : undefined
                }
                onOpen={() => toggle(entry.id)}
              />
            );
          })}
          {shown.length > limit && (
            <Button onClick={() => setLimit((value) => value + PAGE)} sx={{ gridColumn: '1 / -1' }}>
              显示更多
            </Button>
          )}
        </Box>
      )}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
          {full
            ? `文件篮最多再放 ${capacity} 项`
            : valid.length
              ? `已选 ${valid.length} 项，按选择顺序加入`
              : '点按文件进行选择'}
        </Typography>
        <Button variant="contained" disabled={!valid.length} onClick={() => onAdd(valid)}>
          加入文件篮
        </Button>
      </Box>
    </Box>
  );
}
