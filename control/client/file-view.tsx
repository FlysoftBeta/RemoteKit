import { GridView, ViewList } from '@mui/icons-material';
import { IconButton, Tooltip } from '@mui/material';
import { useState } from 'react';
import type { FileView } from './sortable-file-items';

export function useFileView(items: { type: string }[]) {
  const [override, setOverride] = useState<FileView>();
  const ordinary = items.filter((item) => !item.type.toLowerCase().startsWith('image/')).length;
  const mode = override ?? (ordinary >= 3 && ordinary * 3 >= items.length * 2 ? 'list' : 'cards');
  return { mode, toggle: () => setOverride(mode === 'cards' ? 'list' : 'cards') } as const;
}

export function FileViewButton({
  mode,
  toggle,
  disabled,
}: {
  mode: FileView;
  toggle: () => void;
  disabled?: boolean;
}) {
  const label = mode === 'cards' ? '切换到列表' : '切换到卡片';
  return (
    <Tooltip title={label}>
      <span>
        <IconButton
          aria-label={label}
          disabled={disabled}
          onClick={toggle}
          sx={{ minWidth: 44, minHeight: 44 }}
        >
          {mode === 'cards' ? <ViewList /> : <GridView />}
        </IconButton>
      </span>
    </Tooltip>
  );
}
