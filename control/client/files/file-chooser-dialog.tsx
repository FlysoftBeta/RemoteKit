import { recover } from '../failures/recovery';
import {
  Add,
  Close,
  FolderOutlined,
  GridViewOutlined,
  MoreHoriz,
  PhotoCameraOutlined,
  Send,
  UploadFileOutlined,
  ViewListOutlined,
} from '@mui/icons-material';
import {
  Badge,
  Box,
  Button,
  Divider,
  IconButton,
  LinearProgress,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from '@mui/material';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { RemoteKitError } from '../../shared/errors';
import type { LibraryEntry } from '../../shared/file-library';
import type { FileRequest } from '../../shared/product';
import { FloatingPanel } from '../app/floating-panel';
import { scaledAnchor, uiScale } from '../app/ui-scale';
import { operationId } from '../control/product-operations';
import { failureError, FailureNote } from '../failures';
import { diagnostics } from '../media/diagnostics';
import type { ViewerSession } from '../viewer-session';
import { BasketItems, type BasketPanel } from './basket-items';
import { placeFileChooser } from './file-chooser-anchor';
import { basketEntries, FileDropZone, useDeviceImport } from './file-library-controls';
import { FileLibraryPicker } from './file-library-picker';
import { useLibrary } from './file-library-state';
import { fileChooserAccept, selectionViewModel, validateSelection } from './file-selection';
import { useFileView } from './file-view';
import { useImportQueue } from './import-state';
import { BasketPartitionMenu } from './partition-menu';
import { PhotoCapture } from './photo-library-capture';

const MAX_BASKET = 64;

type Step = 'library';
type Camera = { afterId?: string; replace?: LibraryEntry };
type AddMenu = { anchor: HTMLElement; afterId?: string };

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
  windowId,
}: {
  windowId?: string;
  request?: FileRequest;
  viewId?: string;
  transport?: ViewerSession;
  onClose?: () => void;
}) {
  const {
    online,
    snapshot,
    refresh,
    mutate,
    select,
    cancelSelection,
    cancellations,
    checkout,
    photos,
    recordUsage,
  } = useLibrary();
  const transaction = request && checkout(request.id);
  const [chosen, setChosen] = useState<string | null>(null);
  const taskAbort = useRef(new AbortController());
  useEffect(() => () => taskAbort.current.abort(), []);
  const [error, setError] = useState<RemoteKitError | undefined>();
  const [busy, setBusy] = useState(false);
  const cancelOutcome = request && cancellations[request.id];
  const [dragging, setDragging] = useState(false);
  const [camera, setCamera] = useState<Camera>();
  const [step, setStep] = useState<Step>();
  const [panel, setPanel] = useState<BasketPanel>();
  const [addMenu, setAddMenu] = useState<AddMenu>();
  const [moreMenu, setMoreMenu] = useState<HTMLElement>();
  const [afterId, setAfterId] = useState<string>();
  const [position, setPosition] = useState<ReturnType<typeof placeFileChooser>>();
  const [viewportHeight, setViewportHeight] = useState(
    () => window.visualViewport?.height ?? window.innerHeight,
  );
  const basket = basketEntries(snapshot);
  const view = useFileView(basket);
  const pending = photos.jobs.filter((job) => job.destination === 'basket' && !job.replace);
  const retaking = new Set(photos.jobs.flatMap((job) => (job.replace ? [job.replace.id] : [])));
  const selection = request?.multiple ? basket : basket.filter((entry) => entry.id === chosen);
  const blocked =
    selection.filter((entry) => entry.photo?.pending || retaking.has(entry.id)).length +
    (request?.multiple ? pending.length : 0);
  const basketIds = new Set(snapshot?.basket);
  const available =
    snapshot?.entries
      .filter((entry) => entry.kind === 'file' && !basketIds.has(entry.id))
      .sort((a, b) => b.createdAt - a.createdAt) ?? [];
  const outcome = selectionViewModel(transaction?.state, cancelOutcome);
  const final = outcome.terminal;
  const waiting = request?.state === 'validating' || !!transaction || cancelOutcome !== undefined;
  const capacity = MAX_BASKET - basket.length - pending.length;
  const reportError = useCallback((error: RemoteKitError | undefined) => setError(error), []);
  const clearInsertion = useCallback(() => setAfterId(undefined), []);
  const uploads = useImportQueue('basket', request?.windowId ?? windowId);
  const upload = useDeviceImport({
    uploads,
    afterId,
    accept: request ? fileChooserAccept(request) : undefined,
    requestId: request?.id,
    disabled: !online || busy || !snapshot || waiting || final || dragging,
    onError: reportError,
    onDone: clearInsertion,
  });
  const disabled = !online || busy || upload.busy || !!transaction?.active;
  const editingDisabled = disabled || !snapshot || waiting || final;
  const toolbarDisabled = editingDisabled || dragging;
  const canAdd = !toolbarDisabled && capacity > 0;

  useEffect(() => {
    if (online) void refresh().catch((failure) => diagnostics.record('file-chooser-dialog', failure));
  }, [online, request?.id]);
  const measure = () => {
    const anchor =
      viewId && request?.anchor && transport?.presentation.fileInputBounds(viewId, request.anchor);
    const visual = window.visualViewport;
    const height = visual?.height ?? window.innerHeight;
    // Placement is computed in visual px and applied in layout px under the UI scale.
    const scale = uiScale();
    setViewportHeight(height / scale);
    const placed = anchor
      ? placeFileChooser(
          anchor,
          {
            left: visual?.offsetLeft ?? 0,
            top: visual?.offsetTop ?? 0,
            width: visual?.width ?? window.innerWidth,
            height,
          },
          scale,
        )
      : undefined;
    const next = placed && {
      ...placed,
      top: placed.top / scale,
      left: placed.left / scale,
      width: placed.width / scale,
      maxHeight: placed.maxHeight / scale,
    };
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

  async function run(operation: () => Promise<unknown>) {
    if (disabled) return;
    setBusy(true);
    setError(undefined);
    try {
      await recover(operation, taskAbort.current.signal, setError);
      setError(undefined);
    } catch (failure) {
      setError(failureError(failure));
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
        await mutate(
          'library.basket',
          { operationId: operationId(), ids, expectedRevision: revision },
          request?.windowId ?? windowId,
        );
    });
  const submit = () => {
    if (!request || (!transaction && blocked)) return;
    void run(async () => {
      await select(
        request.id,
        selection.map((entry) => entry.id),
      );
    });
  };
  function beginSelection() {
    if (!request) return;
    if (transaction) {
      submit();
      return;
    }
    const problem = validateSelection(selection, request);
    if (problem) {
      setError(new RemoteKitError('invalid_request', problem));
      return;
    }
    submit();
  }
  const openAdd = (anchor: HTMLElement, insertAfter?: string) => {
    setAfterId(insertAfter);
    setAddMenu({ anchor, afterId: insertAfter });
  };
  const addFromLibrary = (ids: string[]) => {
    const order = basket.map((item) => item.id);
    const index = afterId ? order.indexOf(afterId) : -1;
    if (afterId && index < 0) {
      setError(new RemoteKitError('invalid_request', '文件篮已更新，请重新选择插入位置'));
      return;
    }
    order.splice(index >= 0 ? index + 1 : order.length, 0, ...ids);
    setStep(undefined);
    setAfterId(undefined);
    void saveBasket(order);
  };
  const addSources = [
    {
      key: 'device',
      icon: <UploadFileOutlined fontSize="small" />,
      label: '从设备选择',
      disabled: !canAdd,
      run: () => upload.pick(),
    },
    {
      key: 'camera',
      icon: <PhotoCameraOutlined fontSize="small" />,
      label: '摄像头拍照',
      disabled: !canAdd,
      run: () => setCamera({ afterId }),
    },
    {
      key: 'library',
      icon: <FolderOutlined fontSize="small" />,
      label: '从我的文件选择',
      disabled: !canAdd || !available.length,
      run: () => setStep('library'),
    },
  ];
  const sendLabel = transaction
    ? '正在确认结果…'
    : blocked
      ? `还有 ${blocked} 项处理中或待确认`
      : request?.multiple
        ? `按顺序发送全部 ${selection.length} 项`
        : selection.length
          ? '发送选中的文件'
          : '先选择一个文件';
  const sendDisabled =
    disabled ||
    final ||
    !!transaction ||
    dragging ||
    (!transaction && (waiting || !selection.length || blocked > 0));
  const expanded = !!panel || !!step;
  const maxHeight = Math.min(expanded ? 600 : 380, position?.maxHeight ?? Math.max(0, viewportHeight - 16));
  const closeLabel = request ? '取消文件选择' : '关闭文件篮';
  const statusText =
    final || waiting
      ? final
        ? outcome.selected
          ? '文件已交给页面'
          : '文件选择已关闭'
        : outcome.uncertain
          ? '页面接收结果未知，正在确认'
          : '等待页面确认文件'
      : '';
  return (
    <>
      <FloatingPanel
        label="文件篮"
        placement={position}
        width={position?.width ?? 420}
        maxHeight={maxHeight}
        onEscape={
          dragging
            ? undefined
            : () => {
                if (step) setStep(undefined);
                else if (panel) setPanel(undefined);
              }
        }
        header={
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', height: 20, mt: '-14px', px: 0.5 }}>
            <Tooltip title={closeLabel}>
              <span>
                <IconButton
                  aria-label={closeLabel}
                  disabled={disabled || final || dragging}
                  onClick={cancel}
                  sx={{ p: '3px' }}
                >
                  <Close sx={{ fontSize: 18 }} />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        }
      >
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            overflowY: step === 'library' ? 'hidden' : 'auto',
            p: '6px 6px 8px 8px',
            display: 'flex',
            flexDirection: 'column',
            gap: 0.75,
            '& > *': { flexShrink: 0 },
          }}
        >
          {step !== 'library' && (
            <FileDropZone
              label="松开以加入文件篮"
              disabled={!canAdd}
              onFiles={(files) => {
                setAfterId(undefined);
                upload.add(files);
              }}
              sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75 }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                {!snapshot ? (
                  <Box sx={{ py: 4, textAlign: 'center' }}>
                    <Button disabled={!online || waiting} onClick={() => void run(refresh)}>
                      加载文件篮
                    </Button>
                  </Box>
                ) : basket.length || pending.length ? (
                  <BasketItems
                    entries={basket}
                    pending={pending}
                    revision={snapshot.revision}
                    mode={view.mode}
                    ordered={!request || request.multiple}
                    chosen={chosen}
                    onChoose={request && !request.multiple ? setChosen : undefined}
                    disabled={editingDisabled}
                    dragging={dragging}
                    onDragging={setDragging}
                    panel={panel}
                    setPanel={(next) => {
                      setPanel(next);
                      const owner = request?.windowId ?? windowId;
                      if (
                        owner &&
                        next &&
                        snapshot.entries.some((entry) => entry.id === next.id) &&
                        (next.id !== panel?.id || next.view !== panel.view)
                      ) {
                        void recordUsage(next.id, owner).catch((failure) =>
                          diagnostics.record('file-usage', failure),
                        );
                      }
                    }}
                    onChange={saveBasket}
                    onInsert={(id, anchor) => openAdd(anchor, id)}
                    onRetake={(replace) => setCamera({ replace })}
                  />
                ) : (
                  <EmptyBasket sources={addSources} />
                )}
              </Box>
              <Box
                sx={{
                  flex: '0 0 44px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 0.5,
                }}
              >
                {request && (
                  <Tooltip title={sendLabel} placement="left">
                    <Badge
                      overlap="circular"
                      badgeContent={request.multiple ? selection.length : 0}
                      sx={{
                        '& .MuiBadge-badge': {
                          bgcolor: 'var(--surface)',
                          color: 'primary.main',
                          fontWeight: 600,
                          boxShadow: '0 0 0 1px var(--primary)',
                        },
                      }}
                    >
                      <span>
                        <IconButton
                          aria-label={transaction ? '正在确认结果…' : '发送'}
                          disabled={sendDisabled}
                          onClick={beginSelection}
                          sx={{
                            width: 44,
                            height: 44,
                            bgcolor: 'primary.main',
                            color: 'primary.contrastText',
                            '&:hover': { bgcolor: 'primary.dark' },
                            '&.Mui-disabled': { bgcolor: 'action.disabledBackground' },
                          }}
                        >
                          <Send fontSize="small" />
                        </IconButton>
                      </span>
                    </Badge>
                  </Tooltip>
                )}
                <Tooltip title="添加文件" placement="left">
                  <span>
                    <IconButton
                      aria-label="添加文件"
                      aria-haspopup="menu"
                      aria-expanded={!!addMenu}
                      disabled={!canAdd}
                      sx={{ width: 44, height: 44 }}
                      onClick={(event) => openAdd(event.currentTarget)}
                    >
                      <Add />
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip title="更多" placement="left">
                  <span>
                    <IconButton
                      aria-label="更多"
                      aria-haspopup="menu"
                      aria-expanded={!!moreMenu}
                      disabled={dragging}
                      sx={{ width: 44, height: 44 }}
                      onClick={(event) => setMoreMenu(event.currentTarget)}
                    >
                      <MoreHoriz />
                    </IconButton>
                  </span>
                </Tooltip>
              </Box>
            </FileDropZone>
          )}
          {step === 'library' && (
            <FileLibraryPicker
              entries={available}
              capacity={capacity}
              onClose={() => setStep(undefined)}
              onAdd={addFromLibrary}
            />
          )}
          {upload.view}
          {(error ?? transaction?.error) && (
            <FailureNote
              error={error ?? transaction?.error}
              context={{
                operation: '发送文件',
                scope: 'surface',
                input: true,
                capacity: 'selection',
                action: { label: '调整所选内容', run: () => setError(undefined) },
              }}
            />
          )}
          {!online && (
            <FailureNote
              error={new RemoteKitError('unavailable', '')}
              context={{ operation: '发送文件', scope: 'surface' }}
            />
          )}
          {(busy || upload.busy || transaction?.active) && <LinearProgress sx={{ borderRadius: 1 }} />}
          {statusText && (
            <Typography role="status" variant="caption" color="text.secondary" sx={{ px: 0.5 }}>
              {statusText}
            </Typography>
          )}
        </Box>
      </FloatingPanel>
      <Menu
        anchorEl={scaledAnchor(addMenu?.anchor)}
        open={!!addMenu && canAdd}
        onClose={() => {
          setAddMenu(undefined);
          if (!step) setAfterId(undefined);
        }}
        slotProps={{ list: { dense: true } }}
      >
        {addMenu?.afterId && (
          <ListSubheader disableSticky sx={{ lineHeight: '32px', maxWidth: 260 }}>
            <Typography variant="caption" noWrap display="block">
              插入到“{basket.find((entry) => entry.id === addMenu.afterId)?.name}”之后
            </Typography>
          </ListSubheader>
        )}
        {addSources.map((source) => (
          <MenuItem
            key={source.key}
            disabled={source.disabled}
            onClick={() => {
              setAddMenu(undefined);
              source.run();
            }}
          >
            <ListItemIcon>{source.icon}</ListItemIcon>
            <ListItemText>{source.label}</ListItemText>
          </MenuItem>
        ))}
      </Menu>
      <Menu
        anchorEl={scaledAnchor(moreMenu)}
        open={!!moreMenu}
        onClose={() => setMoreMenu(undefined)}
        slotProps={{ list: { dense: true } }}
      >
        <MenuItem
          disabled={toolbarDisabled}
          onClick={() => {
            setMoreMenu(undefined);
            view.toggle();
          }}
        >
          <ListItemIcon>
            {view.mode === 'cards' ? (
              <ViewListOutlined fontSize="small" />
            ) : (
              <GridViewOutlined fontSize="small" />
            )}
          </ListItemIcon>
          <ListItemText>{view.mode === 'cards' ? '切换到列表' : '切换到卡片'}</ListItemText>
        </MenuItem>
        <BasketPartitionMenu disabled={toolbarDisabled} />
        <Divider />
        <MenuItem
          disabled={disabled || final || dragging}
          onClick={() => {
            setMoreMenu(undefined);
            cancel();
          }}
        >
          <ListItemIcon>
            <Close fontSize="small" />
          </ListItemIcon>
          <ListItemText>{closeLabel}</ListItemText>
        </MenuItem>
      </Menu>
      {camera && (
        <PhotoCapture
          requestId={request?.id}
          windowId={request?.windowId ?? windowId}
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

function EmptyBasket({
  sources,
}: {
  sources: { key: string; icon: React.ReactNode; label: string; disabled: boolean; run: () => void }[];
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1,
        px: 1,
        py: 2.5,
        borderRadius: '10px',
        border: '1px dashed',
        borderColor: 'var(--border-tab)',
        bgcolor: 'var(--surface-subtle)',
        textAlign: 'center',
      }}
    >
      <Typography variant="body2" color="text.secondary">
        文件篮是空的，添加要上传的文件
      </Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 0.75 }}>
        {sources.map((source) => (
          <Button
            key={source.key}
            size="small"
            variant="outlined"
            startIcon={source.icon}
            disabled={source.disabled}
            onClick={source.run}
            sx={{ bgcolor: 'background.paper' }}
          >
            {source.label}
          </Button>
        ))}
      </Box>
    </Box>
  );
}
