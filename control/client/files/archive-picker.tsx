import { ArrowBack, CheckCircle, Search } from '@mui/icons-material';
import { Box, Button, IconButton, InputAdornment, TextField, Typography } from '@mui/material';
import { useState } from 'react';
import type { LibraryEntry } from '../../shared/file-library';
import { formatFileSize } from './file-format';
import { FileTile } from './file-tile';

const PAGE = 48;

// Picks files from My Files into the basket: newest first, filter by name, several at once in
// the order they were picked.
export function ArchivePicker({
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
  const needle = query.trim().toLowerCase();
  const shown = needle ? entries.filter((entry) => entry.name.toLowerCase().includes(needle)) : entries;
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
                      sx={{ fontSize: 20, bgcolor: '#fff', borderRadius: '50%' }}
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
