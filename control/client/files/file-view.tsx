import { GridViewOutlined, ViewListOutlined } from '@mui/icons-material';
import { ToggleButton, ToggleButtonGroup, Tooltip } from '@mui/material';
import { useState } from 'react';
import type { FileView } from './sortable-file-items';

// Cards while images dominate; a list once at least three ordinary files make up two thirds.
// A manual choice holds for this component instance only.
export function useFileView(items: { type: string }[]) {
  const [override, setOverride] = useState<FileView>();
  const ordinary = items.filter((item) => !item.type.toLowerCase().startsWith('image/')).length;
  const mode = override ?? (ordinary >= 3 && ordinary * 3 >= items.length * 2 ? 'list' : 'cards');
  return {
    mode,
    set: setOverride,
    toggle: () => setOverride(mode === 'cards' ? 'list' : 'cards'),
  } as const;
}

export function FileViewToggle({ mode, onChange }: { mode: FileView; onChange: (mode: FileView) => void }) {
  return (
    <ToggleButtonGroup
      size="small"
      exclusive
      value={mode}
      aria-label="视图"
      onChange={(_, next: FileView | null) => next && onChange(next)}
      sx={{ '& .MuiToggleButton-root': { px: 1, py: 0.5 } }}
    >
      <Tooltip title="卡片视图">
        <ToggleButton value="cards" aria-label="卡片视图">
          <GridViewOutlined fontSize="small" />
        </ToggleButton>
      </Tooltip>
      <Tooltip title="列表视图">
        <ToggleButton value="list" aria-label="列表视图">
          <ViewListOutlined fontSize="small" />
        </ToggleButton>
      </Tooltip>
    </ToggleButtonGroup>
  );
}
