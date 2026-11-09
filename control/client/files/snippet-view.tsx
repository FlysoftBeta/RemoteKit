import { useRef } from 'react';
import { Box, ButtonBase, Checkbox, IconButton, Typography } from '@mui/material';
import { MoreVert } from '@mui/icons-material';
import type { LibrarySnippetEntry, SnippetOrigin } from '../../shared/file-library';
import { sourceAppName } from './files-app-state';
import { usePress } from './file-tile';

export function snippetOriginLabel(
  origin: SnippetOrigin,
  apps: readonly { id: string; name: string }[] = [],
) {
  if (origin.kind === 'device') return '本机';
  if (origin.kind === 'app') return sourceAppName(origin.app, apps);
  try {
    return new URL(origin.url).host || sourceAppName(origin.app, apps);
  } catch {
    return sourceAppName(origin.app, apps);
  }
}

export function snippetSearchText(entry: LibrarySnippetEntry, apps: readonly { id: string; name: string }[]) {
  const origin = entry.origin;
  return [
    entry.preview,
    snippetOriginLabel(origin, apps),
    origin.kind === 'page' ? origin.url : '',
    origin.kind === 'page' ? origin.title : '',
    origin.kind !== 'device' ? sourceAppName(origin.app, apps) : '本机',
  ].join(' ');
}

export function snippetRelativeTime(at: number, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  if (!minutes) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}小时前`;
  return `${Math.floor(minutes / 1440)}天前`;
}

export function SnippetView({
  entry,
  mode,
  meta,
  selected,
  selecting,
  disabled,
  onOpen,
  onSelect,
  onMenu,
}: {
  entry: LibrarySnippetEntry;
  mode: 'grid' | 'list';
  meta: string;
  selected: boolean;
  selecting: boolean;
  disabled: boolean;
  onOpen(id: string, anchor: HTMLElement): void;
  onSelect(id: string): void;
  onMenu(id: string, anchor: HTMLElement): void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const press = usePress(
    (node) => onOpen(entry.id, node),
    () => {
      if (anchor.current) onMenu(entry.id, anchor.current);
    },
  );
  return (
    <Box
      data-snippet={entry.id}
      sx={{
        display: 'flex',
        position: 'relative',
        alignItems: 'center',
        minWidth: 0,
        height: mode === 'list' ? 48 : '100%',
        borderRadius: 1,
        bgcolor: selected ? 'action.selected' : 'background.paper',
        border: mode === 'grid' ? '1px solid' : undefined,
        borderColor: 'divider',
        '&:hover .snippet-menu, &:focus-within .snippet-menu': { opacity: 1 },
      }}
    >
      {selecting && (
        <Checkbox
          checked={selected}
          disabled={disabled}
          onChange={() => onSelect(entry.id)}
          slotProps={{ input: { 'aria-label': `选择 ${entry.preview}` } }}
        />
      )}
      <ButtonBase
        ref={anchor}
        {...press}
        disabled={disabled}
        aria-label={entry.preview}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu(entry.id, event.currentTarget);
        }}
        sx={{
          minWidth: 0,
          flex: 1,
          height: '100%',
          px: 1,
          py: mode === 'grid' ? 1.5 : 0.5,
          display: 'flex',
          flexDirection: mode === 'grid' ? 'column' : 'row',
          alignItems: mode === 'grid' ? 'stretch' : 'center',
          textAlign: 'left',
          gap: 1,
        }}
      >
        <Typography
          component="span"
          sx={
            mode === 'grid'
              ? {
                  flex: 1,
                  overflow: 'hidden',
                  overflowWrap: 'anywhere',
                  display: '-webkit-box',
                  WebkitLineClamp: 4,
                  WebkitBoxOrient: 'vertical',
                  fontSize: 14,
                }
              : {
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 14,
                }
          }
        >
          {entry.preview}
        </Typography>
        <Typography
          component="span"
          color="text.secondary"
          sx={{
            fontSize: 12,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: mode === 'list' ? '40%' : '100%',
          }}
        >
          {meta}
        </Typography>
      </ButtonBase>
      {!selecting && (
        <IconButton
          className="snippet-menu"
          aria-label="片段操作"
          disabled={disabled}
          onClick={(event) => onMenu(entry.id, event.currentTarget)}
          size="small"
          sx={{ '@media (hover: hover)': { opacity: 0 } }}
        >
          <MoreVert fontSize="small" />
        </IconButton>
      )}
    </Box>
  );
}
