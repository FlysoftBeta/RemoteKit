import { presentFailure } from '../failures';
import { RemoteKitError } from '../../shared/errors';
import {
  AddCircleOutline,
  CheckCircle,
  Close,
  PhotoCameraOutlined,
  RadioButtonUnchecked,
  RemoveCircleOutline,
  RotateRightOutlined,
  TuneOutlined,
  VisibilityOutlined,
} from '@mui/icons-material';
import {
  Box,
  Button,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Radio,
  Tooltip,
  Typography,
} from '@mui/material';
import React, { useState } from 'react';
import type { LibraryEntry } from '../../shared/file-library';
import { OverflowText } from '../app/overflow-text';
import { scaledAnchor } from '../app/ui-scale';
import { formatFileSize } from './file-format';
import { canPreviewFile, FileImagePreview } from './file-image-preview';
import { useLibrary } from './file-library-state';
import { FileRow, FileTile, type FileStatus } from './file-tile';
import { BasketPartitionMenu } from './partition-menu';
import type { PhotoJob } from './photo-job-store';
import { PhotoOptions } from './photo-options';
import { PhotoRotateButton } from './photo-rotate-button';
import { SortableFileItems, type FileView } from './sortable-file-items';

export type BasketPanel = { id: string; view: 'photo' | 'image' };

interface BasketItem {
  id: string;
  name: string;
  entry?: LibraryEntry;
  job?: PhotoJob;
}

export function photoStatus(entry?: LibraryEntry, job?: PhotoJob): FileStatus | undefined {
  const state = job?.state ?? entry?.photo?.pending;
  if (state === 'choice') return { label: '待选片', tone: 'warning' };
  if (state === 'scan-error' || state === 'error')
    return {
      label: '',
      tone: 'progress',
      failure: presentFailure(
        job?.error ??
          entry?.photo?.processingFailure ??
          new RemoteKitError('internal', '照片任务缺少失败记录'),
        { operation: '处理照片', scope: 'item', targetId: job?.id ?? entry?.id },
      ),
    };
  if (state)
    return {
      label: job?.replace && job.rotationTurns === undefined ? '重拍处理中' : '处理中',
      tone: 'progress',
    };
  if (entry?.photo?.advisory) return { label: '可能不清晰', tone: 'warning' };
}

const isPhoto = (entry: LibraryEntry) => !!entry.photo || entry.name.startsWith('photo-');

// The basket's ordered items: cards or rows that sort by drag, a menu per item, and the inline
// panels (photo choices, large preview) that keep the anchored basket in place.
export function BasketItems({
  entries,
  pending,
  revision,
  mode,
  ordered,
  chosen,
  onChoose,
  disabled,
  dragging,
  onDragging,
  panel,
  setPanel,
  onChange,
  onInsert,
  onRetake,
}: {
  entries: LibraryEntry[];
  pending: PhotoJob[];
  revision: number;
  mode: FileView;
  ordered: boolean;
  chosen?: string | null;
  onChoose?: (id: string) => void;
  disabled: boolean;
  dragging: boolean;
  onDragging: (value: boolean) => void;
  panel?: BasketPanel;
  setPanel: (panel?: BasketPanel) => void;
  onChange: (ids: string[], revision: number) => Promise<void>;
  onInsert: (afterId: string, anchor: HTMLElement) => void;
  onRetake: (entry: LibraryEntry) => void;
}) {
  const { photos } = useLibrary();
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement }>();
  const locked = disabled || dragging;
  const replacements = new Map(
    photos.jobs.flatMap((job) => (job.replace ? [[job.replace.id, job] as const] : [])),
  );
  const items: BasketItem[] = entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    entry,
    job: replacements.get(entry.id),
  }));
  // Photos still processing sit where they were shot, after their insertion anchor.
  const tails = new Map<string, string>();
  for (const job of pending) {
    const anchor = job.insertion?.afterId;
    const index = anchor ? items.findIndex((item) => item.id === (tails.get(anchor) ?? anchor)) : -1;
    if (anchor) tails.set(anchor, job.id);
    items.splice(index < 0 ? items.length : index + 1, 0, { id: job.id, name: '照片', job });
  }
  const canInsert = items.length < 64;
  const active = items.find((item) => item.id === panel?.id);
  const menuItem = items.find((item) => item.id === menu?.id);
  const remove = (item: BasketItem) => {
    setMenu(undefined);
    setPanel(undefined);
    if (!item.entry) {
      if (item.job) photos.cancel(item.job.id);
      return;
    }
    void onChange(
      entries.filter((entry) => entry.id !== item.id).map((entry) => entry.id),
      revision,
    );
  };
  // Items that need a decision open their panel directly; the rest open the item menu.
  const open = (item: BasketItem, anchor: HTMLElement) => {
    const state = item.job?.state ?? item.entry?.photo?.pending;
    if (item.entry && !item.entry.available) return;
    if (!item.entry || state === 'choice' || state === 'scan-error' || state === 'error')
      setPanel(panel?.id === item.id ? undefined : { id: item.id, view: 'photo' });
    else setMenu({ id: item.id, anchor });
  };
  const startDrag = React.useCallback(
    (value: boolean) => {
      if (value) {
        setPanel(undefined);
        setMenu(undefined);
      }
      onDragging(value);
    },
    [onDragging, setPanel],
  );
  const choice = (item: BasketItem, overlay?: boolean) =>
    onChoose &&
    item.entry &&
    !overlay && (
      <Radio
        checked={chosen === item.id}
        name="chooser-file"
        onChange={() => onChoose(item.id)}
        disabled={locked || !item.entry.available || !!item.entry.photo?.pending || !!item.job}
        icon={<RadioButtonUnchecked />}
        checkedIcon={<CheckCircle />}
        slotProps={{ input: { 'aria-label': `选择 ${item.name}` } }}
        sx={
          mode === 'cards'
            ? {
                width: 40,
                height: 40,
                '& svg': {
                  fontSize: 22,
                  borderRadius: '50%',
                  bgcolor: 'rgb(255 255 255 / 92%)',
                  boxShadow: '0 1px 3px rgb(15 23 42 / 25%)',
                },
              }
            : { width: 40, height: 40 }
        }
      />
    );
  return (
    <>
      {items.length > 0 && (
        <SortableFileItems
          mode={mode}
          items={items}
          revision={revision}
          disabled={disabled || !!pending.length}
          label="文件篮项目"
          onChange={onChange}
          onDragging={startDrag}
          renderItem={(item, flags) => {
            const { entry, job } = item;
            const common = {
              id: item.id,
              name: item.name,
              type: entry?.type ?? 'image/jpeg',
              assetId: entry?.assetId ?? item.id,
              blob: entry ? undefined : job?.preview,
              localOnly: !entry,
              meta: entry ? (entry.available ? formatFileSize(entry.size) : '暂不可用') : '拍摄的照片',
              status: photoStatus(entry, job),
              selected: chosen === item.id,
            };
            if (mode === 'cards')
              return (
                <FileTile
                  {...common}
                  compact
                  index={ordered ? flags.index + 1 : undefined}
                  open={menu?.id === item.id || panel?.id === item.id}
                  corner={choice(item, flags.overlay)}
                  activator={flags.activator}
                  disabled={disabled || (flags.dragging && !flags.activator)}
                  onOpen={(anchor) => open(item, anchor)}
                />
              );
            return (
              <FileRow
                {...common}
                disabled={locked}
                leading={
                  <>
                    {entry && flags.handle}
                    {choice(item, flags.overlay)}
                  </>
                }
                onOpen={(anchor) => open(item, anchor)}
                trailing={
                  <>
                    {entry && canPreviewFile(entry) && !entry.photo?.pending && (
                      <Tooltip title="查看大图">
                        <IconButton
                          aria-label="查看"
                          disabled={locked}
                          onClick={() => setPanel({ id: item.id, view: 'image' })}
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
                          onClick={(event) => onInsert(item.id, event.currentTarget)}
                        >
                          <AddCircleOutline fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                    <Tooltip title="从文件篮移除">
                      <IconButton
                        aria-label="移除"
                        disabled={locked || job?.state === 'committing'}
                        onClick={() => remove(item)}
                      >
                        <RemoveCircleOutline fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </>
                }
              />
            );
          }}
        />
      )}
      <Menu
        anchorEl={scaledAnchor(menu?.anchor)}
        open={!!menuItem?.entry && !locked}
        onClose={() => setMenu(undefined)}
        slotProps={{ list: { dense: true } }}
      >
        {menuItem?.entry && [
          <Box key="title" sx={{ px: 2, pt: 0.5, pb: 1, maxWidth: 260 }}>
            <OverflowText variant="subtitle2">{menuItem.name}</OverflowText>
            <Typography variant="caption" color="text.secondary">
              {formatFileSize(menuItem.entry.size)}
            </Typography>
          </Box>,
          <Divider key="divider" />,
          <BasketPartitionMenu key="partition" ids={[menuItem.id]} disabled={locked} />,
          canPreviewFile(menuItem.entry) && (
            <MenuItem
              key="view"
              onClick={() => {
                setMenu(undefined);
                setPanel({ id: menuItem.id, view: 'image' });
              }}
            >
              <ListItemIcon>
                <VisibilityOutlined fontSize="small" />
              </ListItemIcon>
              <ListItemText>查看大图</ListItemText>
            </MenuItem>
          ),
          menuItem.entry.photo &&
            !menuItem.entry.photo.pending &&
            (!menuItem.job ||
              (menuItem.job.rotationTurns !== undefined && menuItem.job.state === 'processing')) && (
              <MenuItem
                key="rotate"
                onClick={() => {
                  setMenu(undefined);
                  if (menuItem.entry) photos.rotate(menuItem.entry, 'basket');
                }}
              >
                <ListItemIcon>
                  <RotateRightOutlined fontSize="small" />
                </ListItemIcon>
                <ListItemText>向右旋转</ListItemText>
              </MenuItem>
            ),
          (menuItem.entry.photo?.advisory || menuItem.entry.originalAssetId) && (
            <MenuItem
              key="photo"
              onClick={() => {
                setMenu(undefined);
                setPanel({ id: menuItem.id, view: 'photo' });
              }}
            >
              <ListItemIcon>
                <TuneOutlined fontSize="small" />
              </ListItemIcon>
              <ListItemText>照片详情</ListItemText>
            </MenuItem>
          ),
          isPhoto(menuItem.entry) && !menuItem.job && (
            <MenuItem
              key="retake"
              onClick={() => {
                setMenu(undefined);
                if (menuItem.entry) onRetake(menuItem.entry);
              }}
            >
              <ListItemIcon>
                <PhotoCameraOutlined fontSize="small" />
              </ListItemIcon>
              <ListItemText>重拍</ListItemText>
            </MenuItem>
          ),
          <MenuItem
            key="insert"
            disabled={!canInsert}
            onClick={() => {
              const anchor = menu?.anchor;
              setMenu(undefined);
              if (anchor) onInsert(menuItem.id, anchor);
            }}
          >
            <ListItemIcon>
              <AddCircleOutline fontSize="small" />
            </ListItemIcon>
            <ListItemText>在后面插入…</ListItemText>
          </MenuItem>,
          <MenuItem key="remove" disabled={!!menuItem.job} onClick={() => remove(menuItem)}>
            <ListItemIcon>
              <RemoveCircleOutline fontSize="small" />
            </ListItemIcon>
            <ListItemText>从文件篮移除</ListItemText>
          </MenuItem>,
        ]}
      </Menu>
      {active && (
        <Box
          sx={{
            mt: 0.5,
            p: 1,
            borderRadius: '10px',
            bgcolor: 'var(--surface-subtle)',
            overflowWrap: 'anywhere',
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
            <OverflowText variant="subtitle2" sx={{ flex: 1, minWidth: 0 }}>
              {active.name}
            </OverflowText>
            {panel?.view === 'image' && active.entry && (
              <PhotoRotateButton entry={active.entry} destination="basket" disabled={locked} />
            )}
            <IconButton aria-label="收起项目" onClick={() => setPanel(undefined)}>
              <Close fontSize="small" />
            </IconButton>
          </Box>
          {panel?.view === 'image' && active.entry?.kind === 'file' ? (
            <>
              <FileImagePreview
                key={active.entry.assetId}
                inline
                showRotation={false}
                entry={active.entry}
                onClose={() => setPanel(undefined)}
              />
              {active.job?.state === 'error' && (
                <PhotoPanel
                  item={active}
                  locked={locked}
                  onRemove={() => remove(active)}
                  onRetake={onRetake}
                  onClose={() => setPanel(undefined)}
                />
              )}
            </>
          ) : (
            <PhotoPanel
              item={active}
              locked={locked}
              onRemove={() => remove(active)}
              onRetake={onRetake}
              onClose={() => setPanel(undefined)}
            />
          )}
        </Box>
      )}
    </>
  );
}

function PhotoPanel({
  item,
  locked,
  onRemove,
  onRetake,
  onClose,
}: {
  item: BasketItem;
  locked: boolean;
  onRemove: () => void;
  onRetake: (entry: LibraryEntry) => void;
  onClose: () => void;
}) {
  const { photos } = useLibrary();
  const { entry, job } = item;
  return (
    <>
      {(entry || job) && (
        <PhotoOptions
          key={entry?.id ?? job?.id}
          entry={entry}
          job={job}
          destination="basket"
          disabled={locked}
        />
      )}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 0.5, mt: 1 }}>
        {job && job.state !== 'committing' && (
          <Button
            disabled={locked}
            onClick={() => {
              photos.cancel(job.id);
              onClose();
            }}
          >
            {entry ? '取消重拍或处理' : '移除照片'}
          </Button>
        )}
        {entry && isPhoto(entry) && !job && (
          <Button disabled={locked} startIcon={<PhotoCameraOutlined />} onClick={() => onRetake(entry)}>
            重拍
          </Button>
        )}
        {entry && !job && (
          <Button disabled={locked} startIcon={<RemoveCircleOutline />} onClick={onRemove}>
            从文件篮移除
          </Button>
        )}
      </Box>
    </>
  );
}
