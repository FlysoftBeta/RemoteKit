import { diagnostics } from '../media/diagnostics';
import { Add, Close, MoreHoriz, Send } from '@mui/icons-material';
import {
  Alert,
  Badge,
  Box,
  Button,
  Dialog,
  DialogContent,
  IconButton,
  LinearProgress,
  Tooltip,
  Typography,
} from '@mui/material';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LibraryEntry } from '../../shared/file-library';
import type { FileRequest } from '../../shared/product';
import { ArchiveContents } from './archive-picker';
import { BasketRows, type BasketItemPanel } from './basket-rows';
import { operationId } from '../control/product-operations';
import { placeFileChooser } from './file-chooser-anchor';
import { basketEntries, DeviceImport, fileError, GroupConfirm, touchButton } from './file-library-controls';
import { useLibrary } from './file-library-state';
import { fileChooserAccept, selectionViewModel, validateSelection } from './file-selection';
import { FileViewButton, useFileView } from './file-view';
import { PhotoCapture } from './photo-library-capture';
import type { ViewerSession } from '../viewer-session';

type Panel = 'add' | 'more' | 'group' | 'archive' | BasketItemPanel;
type Camera = { afterId?: string; replace?: LibraryEntry };

export function FileChooserDialog(props: {
  request: FileRequest;
  viewId?: string;
  transport: ViewerSession;
}) {
  return <FileBasketDialog {...props} />;
}

export function FileBasketDialog({
  request,
  viewId,
  transport,
  onClose,
}: {
  request?: FileRequest;
  viewId?: string;
  transport?: ViewerSession;
  onClose?: () => void;
}) {
  const { online, snapshot, refresh, mutate, select, cancelSelection, cancellations, checkout, photos } =
    useLibrary();
  const transaction = request && checkout(request.id);
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const cancelOutcome = request && cancellations[request.id];
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [camera, setCamera] = useState<Camera>();
  const [panel, setPanel] = useState<Panel>();
  const [afterId, setAfterId] = useState<string>();
  const [position, setPosition] = useState<ReturnType<typeof placeFileChooser>>();
  const [viewportHeight, setViewportHeight] = useState(
    () => window.visualViewport?.height ?? window.innerHeight,
  );
  const input = useRef<HTMLInputElement>(null);
  const basket = basketEntries(snapshot);
  const view = useFileView(basket);
  const pending = photos.jobs.filter((job) => job.destination === 'basket' && !job.replace);
  const retaking = new Set(photos.jobs.flatMap((job) => (job.replace ? [job.replace.id] : [])));
  const selection = request?.multiple ? basket : basket.filter((entry) => entry.id === chosen);
  const blocked =
    selection.filter((entry) => entry.photo?.pending || retaking.has(entry.id)).length +
    (request?.multiple ? pending.length : 0);
  const groups = snapshot?.groups ?? [];
  const basketIds = new Set(snapshot?.basket);
  const archived =
    snapshot?.entries
      .filter((entry) => entry.archived && !basketIds.has(entry.id))
      .sort((a, b) => b.createdAt - a.createdAt) ?? [];
  const outcome = selectionViewModel(transaction?.state, cancelOutcome);
  const final = outcome.terminal;
  const waiting = request?.state === 'validating' || !!transaction || cancelOutcome !== undefined;
  const disabled = !online || busy || uploading || !!transaction?.active;
  const editingDisabled = disabled || !snapshot || waiting || final;
  const toolbarDisabled = editingDisabled || dragging;
  const canAdd = !toolbarDisabled && basket.length + pending.length < 64;

  useEffect(() => {
    if (online) void refresh().catch((error) => diagnostics.record('file-chooser-dialog', error));
  }, [online, request?.id]);
  const measure = () => {
    const anchor =
      viewId && request?.anchor && transport?.presentation.fileInputBounds(viewId, request.anchor);
    const visual = window.visualViewport;
    const height = visual?.height ?? window.innerHeight;
    setViewportHeight(height);
    const next = anchor
      ? placeFileChooser(anchor, {
          left: visual?.offsetLeft ?? 0,
          top: visual?.offsetTop ?? 0,
          width: visual?.width ?? window.innerWidth,
          height,
        })
      : undefined;
    setPosition((previous) =>
      previous?.top === next?.top &&
      previous?.left === next?.left &&
      previous?.width === next?.width &&
      previous?.maxHeight === next?.maxHeight &&
      previous?.above === next?.above
        ? previous
        : next,
    );
  };
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const visual = window.visualViewport;
    visual?.addEventListener('resize', measure);
    visual?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    return () => {
      visual?.removeEventListener('resize', measure);
      visual?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [viewId, request?.anchor, transport]);

  async function run(operation: () => Promise<void>) {
    if (disabled) return;
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (failure) {
      setError(fileError(failure));
    } finally {
      setBusy(false);
    }
  }
  const cancel = () => {
    if (!request) {
      onClose?.();
      return;
    }
    void run(async () => {
      if (final) return;
      await cancelSelection(request.id);
    });
  };
  const saveBasket = (ids: string[], revision = snapshot?.revision) =>
    run(async () => {
      if (revision !== undefined)
        await mutate('library.basket', { operationId: operationId(), ids, expectedRevision: revision });
    });
  const submit = (groupId: string | null) => {
    if (!request || (!transaction && blocked)) return;
    void run(async () => {
      await select(
        request.id,
        selection.map((entry) => entry.id),
        groupId,
      );
    });
  };
  function beginSelection() {
    if (!request) return;
    if (transaction) {
      submit(transaction.groupId);
      return;
    }
    const problem = validateSelection(selection, request);
    if (problem) {
      setError(problem);
      return;
    }
    if (groups.length) setPanel('group');
    else submit(null);
  }
  function openInsert(id?: string) {
    setAfterId(id);
    setPanel(panel === 'add' && id === afterId ? undefined : 'add');
  }
  const sendTitle = transaction
    ? '重试确认'
    : blocked
      ? `还有 ${blocked} 项处理中或待确认`
      : request?.multiple
        ? `按顺序发送全部 ${selection.length} 项`
        : '发送选中的文件';
  const expandedLimit = typeof panel === 'object' ? 560 : 360;
  const maxHeight = Math.min(expandedLimit, position?.maxHeight ?? Math.max(0, viewportHeight - 16));
  return (
    <>
      <Dialog
        open
        disableEscapeKeyDown={dragging}
        onClose={
          disabled || final || dragging
            ? undefined
            : () => {
                if (panel) setPanel(undefined);
                else cancel();
              }
        }
        slotProps={{
          paper: {
            'aria-label': '文件篮',
            style: { maxHeight },
            sx: position
              ? {
                  position: 'fixed',
                  top: position.top,
                  left: position.left,
                  width: position.width,
                  transform: position.above ? 'translateY(-100%)' : undefined,
                  m: 0,
                }
              : { width: 400, maxWidth: 'calc(100vw - 16px)', m: 1 },
          },
        }}
      >
        <DialogContent
          sx={{ '&&': { p: '6px !important' }, display: 'flex', flexDirection: 'column', gap: 0.5 }}
        >
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              {snapshot ? (
                <BasketRows
                  entries={basket}
                  revision={snapshot.revision}
                  chosen={chosen}
                  onChoose={request && !request.multiple ? setChosen : undefined}
                  mode={view.mode}
                  pending={pending}
                  panel={typeof panel === 'object' ? panel : undefined}
                  setPanel={setPanel}
                  onChange={saveBasket}
                  onInsert={openInsert}
                  disabled={editingDisabled}
                  dragging={dragging}
                  onDragging={setDragging}
                  onRetake={(replace) => {
                    setCamera({ replace });
                  }}
                />
              ) : (
                <Button disabled={!online || waiting} onClick={() => void run(refresh)}>
                  加载文件篮
                </Button>
              )}
            </Box>
            <Box sx={{ flex: '0 0 44px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {request && (
                <Tooltip title={sendTitle}>
                  <span>
                    <IconButton
                      aria-label={transaction ? '重试确认' : '发送'}
                      color="primary"
                      sx={{ width: 44, height: 44 }}
                      disabled={
                        disabled ||
                        final ||
                        dragging ||
                        (!transaction && (waiting || !selection.length || blocked > 0))
                      }
                      onClick={beginSelection}
                    >
                      <Badge badgeContent={request.multiple ? selection.length : 0} color="primary">
                        <Send fontSize="small" />
                      </Badge>
                    </IconButton>
                  </span>
                </Tooltip>
              )}
              <Tooltip title="添加文件">
                <span>
                  <IconButton
                    aria-label="添加文件"
                    aria-expanded={panel === 'add'}
                    disabled={!canAdd}
                    sx={{ width: 44, height: 44 }}
                    onClick={() => openInsert()}
                  >
                    <Add />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="更多">
                <span>
                  <IconButton
                    aria-label="更多"
                    aria-expanded={panel === 'more'}
                    disabled={dragging}
                    sx={{ width: 44, height: 44 }}
                    onClick={() => setPanel(panel === 'more' ? undefined : 'more')}
                  >
                    <MoreHoriz />
                  </IconButton>
                </span>
              </Tooltip>
            </Box>
          </Box>
          {panel === 'add' && (
            <Box sx={{ display: 'flex', flexWrap: 'wrap' }}>
              <Button
                disabled={!canAdd}
                onClick={() => {
                  setPanel(undefined);
                  input.current?.click();
                }}
              >
                从设备选择
              </Button>
              <Button
                disabled={!canAdd}
                onClick={() => {
                  setPanel(undefined);
                  setCamera({ afterId });
                }}
              >
                摄像头拍照
              </Button>
              <Button disabled={!canAdd || !archived.length} onClick={() => setPanel('archive')}>
                从我的文件选择
              </Button>
            </Box>
          )}
          {panel === 'archive' && (
            <ArchiveContents
              entries={archived}
              onClose={() => setPanel(undefined)}
              onAdd={(id) => {
                if (!canAdd) return;
                const ids = basket.map((item) => item.id);
                const index = afterId ? ids.indexOf(afterId) : -1;
                if (afterId && index < 0) {
                  setError('文件篮已更新，请重新选择插入位置');
                  return;
                }
                ids.splice(index >= 0 ? index + 1 : ids.length, 0, id);
                setPanel(undefined);
                void saveBasket(ids);
              }}
            />
          )}
          {panel === 'group' && (
            <GroupConfirm
              groups={groups}
              onClose={() => setPanel(undefined)}
              title="选择文件保存分组"
              disabled={disabled || blocked > 0}
              onChoose={(group) => {
                setPanel(undefined);
                submit(group);
              }}
            />
          )}
          {panel === 'more' && (
            <Box sx={{ borderTop: '1px solid', borderColor: 'divider', px: 1, pb: 0.5 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <FileViewButton mode={view.mode} toggle={view.toggle} disabled={toolbarDisabled} />
                <Button
                  startIcon={<Close />}
                  disabled={disabled || final || dragging}
                  onClick={cancel}
                  sx={touchButton}
                >
                  {request ? '取消文件选择' : '关闭文件篮'}
                </Button>
              </Box>
              {request && (
                <Typography variant="caption" display="block" sx={{ overflowWrap: 'anywhere' }}>
                  {request.origin}
                  <br />
                  {request.multiple
                    ? `按篮中顺序发送全部文件，页面最多接收 ${request.limits.maxFiles} 项`
                    : '使用单选按钮选择一个文件'}
                </Typography>
              )}
            </Box>
          )}
          <DeviceImport
            inline
            destination="basket"
            afterId={afterId}
            accept={request ? fileChooserAccept(request) : undefined}
            disabled={toolbarDisabled}
            inputRef={input}
            onBusy={setUploading}
            onError={setError}
            onDone={() => setAfterId(undefined)}
          />
          {error && (
            <Alert severity="warning" onClose={() => setError('')}>
              {error}
            </Alert>
          )}
          {!online && <Alert severity="info">等待连接恢复</Alert>}
          {(busy || uploading || transaction?.active) && <LinearProgress />}
          {(final || waiting) && (
            <Typography role="status" variant="caption">
              {final
                ? outcome.selected
                  ? '文件已交给页面'
                  : '文件选择已关闭'
                : outcome.uncertain
                  ? '页面接收结果未知，正在确认'
                  : '等待页面确认文件'}
            </Typography>
          )}
        </DialogContent>
      </Dialog>
      {camera && (
        <PhotoCapture
          {...camera}
          onClose={() => {
            setCamera(undefined);
            setAfterId(undefined);
          }}
        />
      )}
    </>
  );
}
