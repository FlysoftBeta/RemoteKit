import { Box, Button, Typography } from '@mui/material';
import { useState } from 'react';
import type { LibraryEntry } from '../../shared/file-library';
import { fileSize } from './basket-rows';
import { FileCard } from './file-card';

export const fileGrid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(128px, 1fr))',
  gap: 1.25,
};

export function ArchiveContents({
  entries,
  onAdd,
  onClose,
}: {
  entries: LibraryEntry[];
  onAdd: (id: string) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string>();
  const [limit, setLimit] = useState(48);
  return (
    <Box sx={{ borderTop: '1px solid', borderColor: 'divider', p: 0.5 }}>
      <Typography variant="subtitle2">从我的文件选择</Typography>
      {!entries.length && <Typography color="text.secondary">没有可加入的文件</Typography>}
      <Box sx={{ display: 'flex', overflowX: 'auto', gap: '6px', py: 0.5 }}>
        {entries.slice(0, limit).map((entry) => (
          <Box key={entry.id} sx={{ flex: '0 0 96px' }}>
            <FileCard
              compact
              popup={false}
              id={entry.id}
              title={entry.name}
              assetId={entry.assetId}
              type={entry.type}
              detail={entry.photo?.pending ? '待确认' : fileSize(entry.size)}
              selected={selected === entry.id}
              onOpen={() => setSelected(entry.id)}
            />
          </Box>
        ))}
        {entries.length > limit && <Button onClick={() => setLimit((n) => n + 48)}>更多</Button>}
      </Box>
      <Button onClick={onClose}>返回</Button>
      <Button
        disabled={!entries.some((entry) => entry.id === selected)}
        onClick={() => {
          if (selected) onAdd(selected);
        }}
      >
        加入文件篮
      </Button>
    </Box>
  );
}
