import { Add, Close, DeleteOutline, VisibilityOutlined } from '@mui/icons-material';
import { Alert, Box, Button, CircularProgress, IconButton, Radio, Tooltip, Typography } from '@mui/material';
import React from 'react';
import type { LibraryEntry } from '../shared/file-library';
import { FileCard } from './file-card';
import { canPreviewFile, FileImagePreview } from './file-image-preview';
import { useLibrary } from './file-library-state';
import { FileThumbnail } from './file-thumbnail';
import type { PhotoJob } from './photo-jobs';
import { PhotoOptions } from './photo-options';
import { SortableFileItems, type FileView } from './sortable-file-items';

export const fileSize = (size: number) => `${(size / 1024).toFixed(1)} KB`;
export const compactPreview = {
  width: 32,
  height: 32,
  borderRadius: 1,
  flexShrink: 0,
  '& svg': { fontSize: 20 },
  '& .MuiTypography-root': { display: 'none' },
};
export interface BasketItemPanel {
  id: string;
  view: 'actions' | 'image';
}

const status = (entry?: LibraryEntry, job?: PhotoJob) => {
  const state = job?.state ?? entry?.photo?.pending;
  if (state === 'choice') return '待选片';
  if (state === 'scan-error') return '扫描未完成';
  if (state === 'error') return '处理失败';
  if (state) return job?.replace ? '重拍处理中' : '处理中';
  if (entry?.photo?.warning) return '清晰度提示';
};

export function BasketRows({
  entries,
  revision,
  chosen,
  onChoose,
  onChange,
  onInsert,
  disabled,
  dragging,
  onDragging,
  mode,
  panel,
  setPanel,
  onRetake,
  pending,
}: {
  entries: LibraryEntry[];
  revision: number;
  chosen?: string | null;
  onChoose?: (id: string) => void;
  onChange: (ids: string[], revision: number) => Promise<void>;
  onInsert: (afterId: string) => void;
  disabled: boolean;
  dragging: boolean;
  onDragging: (value: boolean) => void;
  mode: FileView;
  panel?: BasketItemPanel;
  setPanel: (panel?: BasketItemPanel) => void;
  onRetake: (entry: LibraryEntry) => void;
  pending: PhotoJob[];
}) {
  const { photos } = useLibrary();
  const locked = disabled || dragging;
  const replacements = new Map(
    photos.jobs.flatMap((job) => (job.replace ? [[job.replace.id, job] as const] : [])),
  );
  const items: { id: string; name: string; entry?: LibraryEntry; job?: PhotoJob }[] = entries.map(
    (entry) => ({
      id: entry.id,
      name: entry.name,
      entry,
      job: replacements.get(entry.id),
    }),
  );
  const tails = new Map<string, string>();
  for (const job of pending) {
    const anchor = job.insertion?.afterId;
    const index = anchor ? items.findIndex((item) => item.id === (tails.get(anchor) ?? anchor)) : -1;
    if (anchor) tails.set(anchor, job.id);
    items.splice(index < 0 ? items.length : index + 1, 0, { id: job.id, name: '照片', job });
  }
  const active = items.find((item) => item.id === panel?.id);
  const entry = active?.entry;
  const job = active?.job;
  const remove = (id: string) => {
    setPanel(undefined);
    void onChange(
      entries.filter((item) => item.id !== id).map((item) => item.id),
      revision,
    );
  };
  const open = (id: string) => setPanel(panel?.id === id ? undefined : { id, view: 'actions' });
  const canInsert = items.length < 64;
  const startDrag = React.useCallback(
    (value: boolean) => {
      if (value) setPanel(undefined);
      onDragging(value);
    },
    [onDragging, setPanel],
  );
  return (
    <>
      {items.length ? (
        <SortableFileItems
          compact
          mode={mode}
          items={items}
          revision={revision}
          disabled={disabled || !!pending.length}
          label="文件篮项目"
          onChange={onChange}
          onDragging={startDrag}
          renderItem={(item, flags) => {
            const selection = onChoose && item.entry && !flags.overlay && (
              <Radio
                checked={chosen === item.id}
                name="chooser-file"
                onChange={() => onChoose(item.id)}
                disabled={locked || !!item.entry.photo?.pending || !!item.job}
                slotProps={{ input: { 'aria-label': item.name } }}
                sx={{ width: 44, height: 44, color: 'text.secondary', bgcolor: 'rgba(255,255,255,.82)' }}
                size="small"
              />
            );
            const { entry, job } = item;
            const assetId = entry?.assetId ?? item.id;
            const type = entry?.type ?? 'image/png';
            const detail = status(entry, job) ?? (entry ? fileSize(entry.size) : '');
            const blob = entry ? undefined : job?.preview;
            if (mode === 'cards')
              return (
                <FileCard
                  compact
                  id={item.id}
                  title={item.name}
                  type={type}
                  assetId={assetId}
                  blob={blob}
                  localOnly={!entry}
                  detail={detail}
                  index={flags.index + 1}
                  selected={chosen === item.id}
                  open={panel?.id === item.id}
                  selection={selection}
                  activator={flags.activator}
                  disabled={disabled || (flags.dragging && !flags.activator)}
                  onOpen={() => open(item.id)}
                />
              );
            return (
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  minHeight: 56,
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                  bgcolor: 'background.paper',
                }}
              >
                {entry && flags.handle}
                {selection}
                <FileThumbnail
                  assetId={assetId}
                  type={type}
                  blob={blob}
                  localOnly={!entry}
                  sx={compactPreview}
                />
                <Box sx={{ flex: '1 1 65px', minWidth: 0, ml: 0.5 }}>
                  <Typography variant="body2" noWrap title={item.name}>
                    {item.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {detail}
                  </Typography>
                </Box>
                <Box sx={{ display: 'flex', ml: 'auto' }}>
                  {(job || (entry && canPreviewFile(entry))) && (
                    <Tooltip title={job || entry?.photo?.pending ? '查看状态' : '查看大图'}>
                      <IconButton
                        disabled={locked}
                        aria-label="查看"
                        onClick={() =>
                          setPanel({ id: item.id, view: job || entry?.photo?.pending ? 'actions' : 'image' })
                        }
                      >
                        <VisibilityOutlined fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                  {entry && (
                    <Tooltip title="在后面插入">
                      <IconButton
                        aria-label="插入"
                        disabled={locked || !canInsert}
                        onClick={() => onInsert(item.id)}
                      >
                        <Add fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                  <Tooltip title="移除">
                    <IconButton
                      aria-label="移除"
                      disabled={locked || job?.state === 'committing'}
                      onClick={() => {
                        if (job) photos.cancel(job.id);
                        else remove(item.id);
                      }}
                    >
                      <DeleteOutline fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Box>
              </Box>
            );
          }}
        />
      ) : (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ px: 2, py: 5, bgcolor: 'action.hover', borderRadius: 2 }}
        >
          添加文件
        </Typography>
      )}
      {active && panel?.view === 'image' && entry && (
        <FileImagePreview key={entry.assetId} inline entry={entry} onClose={() => setPanel(undefined)} />
      )}
      {active && panel?.view === 'actions' && (
        <Box sx={{ borderTop: '1px solid', borderColor: 'divider', pt: 0.5, overflowWrap: 'anywhere' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="subtitle2">{active.name}</Typography>
            <IconButton size="small" aria-label="收起项目" onClick={() => setPanel(undefined)}>
              <Close fontSize="small" />
            </IconButton>
          </Box>
          {entry && (
            <PhotoOptions key={entry.id} entry={entry} job={job} destination="basket" disabled={locked} />
          )}
          {job &&
            !entry &&
            (job.error ? (
              <Alert severity="warning">{job.error}</Alert>
            ) : (
              <Typography variant="caption" role="status">
                <CircularProgress size={12} sx={{ mr: 0.75 }} />
                处理中
              </Typography>
            ))}
          {job && job.state !== 'committing' && (
            <Button
              disabled={locked}
              onClick={() => {
                photos.cancel(job.id);
                setPanel(undefined);
              }}
            >
              {entry ? '取消重拍或处理' : '移除照片'}
            </Button>
          )}
          {job?.state === 'error' && job.retryable && (
            <Button disabled={locked} onClick={() => photos.retry(job.id)}>
              重试
            </Button>
          )}
          {entry && (
            <>
              {canPreviewFile(entry) && (
                <Button disabled={locked} onClick={() => setPanel({ id: entry.id, view: 'image' })}>
                  查看大图
                </Button>
              )}
              {(entry.photo || entry.name.startsWith('photo-')) && !job && (
                <Button disabled={locked} onClick={() => onRetake(entry)}>
                  重拍
                </Button>
              )}
              <Button disabled={locked || !canInsert} onClick={() => onInsert(entry.id)}>
                在后面插入…
              </Button>
              {!job && (
                <Button disabled={locked} onClick={() => remove(entry.id)}>
                  从文件篮移除
                </Button>
              )}
            </>
          )}
        </Box>
      )}
    </>
  );
}
