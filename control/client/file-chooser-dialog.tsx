import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, LinearProgress, Menu, MenuItem, Typography } from '@mui/material';
import { Add, Close } from '@mui/icons-material';
import type { FileRequest } from '../shared/product';
import { fileChooserAccept, validateSelection } from './file-selection';
import { basketEntries, DeviceImport, fileError, GroupPicker, touchButton } from './file-library-controls';
import { BasketRows } from './basket-rows';
import { ArchivePicker } from './archive-picker';
import { useLibrary } from './file-library-state';
import { PhotoCapture } from './photo-library-capture';
import { operationId } from './product-operations';
import { placeFileChooser } from './file-chooser-anchor';
import type { RemoteTransport } from './transport';

export function FileChooserDialog({ request, viewId, transport }: { request: FileRequest; viewId?: string; transport: RemoteTransport }) {
    const { rpc, online, snapshot, refresh, mutate, select, checkout } = useLibrary();
    const transaction = checkout(request.id);
    const [chosen, setChosen] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [cancelled, setCancelled] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [camera, setCamera] = useState(false);
    const [groupPicker, setGroupPicker] = useState(false);
    const [archivedPicker, setArchivedPicker] = useState(false);
    const [insertMenu, setInsertMenu] = useState<HTMLElement | null>(null);
    const [afterId, setAfterId] = useState<string>();
    const [position, setPosition] = useState<ReturnType<typeof placeFileChooser>>();
    const input = useRef<HTMLInputElement>(null);
    const basket = basketEntries(snapshot);
    const selection = request.multiple ? basket : basket.filter(entry => entry.id === chosen);
    const groups = snapshot?.groups ?? [];
    const basketIds = new Set(snapshot?.basket);
    const archived = snapshot?.entries.filter(entry => entry.archived && !basketIds.has(entry.id)).sort((a, b) => b.createdAt - a.createdAt) ?? [];
    const final = cancelled || transaction?.state === 'selected' || transaction?.state === 'cancelled';
    const waiting = request.state === 'validating' || !!transaction;
    const disabled = !online || busy || uploading || !!transaction?.active;
    const editingDisabled = disabled || !snapshot || waiting || final;
    const toolbarDisabled = editingDisabled || dragging;

    useEffect(() => {
        if (online) void refresh().catch(() => {});
    }, [online, request.id]);
    const measure = () => {
        const anchor = viewId && request.anchor && transport.fileInputBounds(viewId, request.anchor);
        const visual = window.visualViewport;
        const next = anchor ? placeFileChooser(anchor, {
            left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0,
            width: visual?.width ?? window.innerWidth, height: visual?.height ?? window.innerHeight,
        }) : undefined;
        setPosition(previous => previous?.top === next?.top && previous?.left === next?.left &&
            previous?.width === next?.width && previous?.maxHeight === next?.maxHeight && previous?.above === next?.above ? previous : next);
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
    }, [viewId, request.anchor, transport]);

    async function run(operation: () => Promise<void>) {
        if (disabled) return;
        setBusy(true);
        setError('');
        try { await operation(); } catch (failure) { setError(fileError(failure)); }
        finally { setBusy(false); }
    }
    const cancel = () => void run(async () => {
        if (final) return;
        const result = await rpc.cancel(request.id);
        if (result.state !== 'validating') setCancelled(true);
        else setError('页面正在确认文件，稍后可再次检查');
    });
    const saveBasket = (ids: string[], revision = snapshot?.revision) => run(async () => {
        if (revision !== undefined) await mutate('library.basket', { operationId: operationId(), ids, expectedRevision: revision });
    });
    const submit = (groupId: string | null) => void run(async () => {
        const state = await select(request.id, selection.map(entry => entry.id), groupId);
        if (state === 'unknown') setError('页面接收结果未知。请重试确认原操作，文件仍在文件篮中。');
        if (state === 'pending') setError('页面还未确认。请重试同一次选择。');
    });
    function beginSelection() {
        if (transaction) { submit(transaction.groupId); return; }
        const problem = validateSelection(selection, request);
        if (problem) { setError(problem); return; }
        if (groups.length) setGroupPicker(true);
        else submit(null);
    }
    function openInsert(anchor: HTMLElement, id?: string) {
        setAfterId(id);
        setInsertMenu(anchor);
    }
    return <Dialog open aria-labelledby="file-chooser-title" aria-describedby="file-chooser-origin"
        disableEscapeKeyDown={dragging} onClose={disabled || final || dragging ? undefined : cancel}
        slotProps={{ paper: { sx: position ? {
            position: 'fixed', top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight,
            transform: position.above ? 'translateY(-100%)' : undefined, m: 0,
        } : { width: 360, maxWidth: 'calc(100vw - 24px)', maxHeight: 'min(420px, calc(100% - 24px))', m: 1.5 } } }}>
        <DialogTitle id="file-chooser-title" sx={{ pr: 7 }}>选择文件
            <IconButton aria-label="取消文件选择" disabled={disabled || final || dragging} onClick={cancel} sx={{ ...touchButton, position: 'absolute', right: 8, top: 8 }}><Close /></IconButton>
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: .5, px: 2 }}>
            <Typography id="file-chooser-origin" variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{request.origin}</Typography>
            {error && <Alert severity="warning">{error}</Alert>}
            {!online && <Alert severity="info">等待连接恢复</Alert>}
            {!snapshot && online && !waiting && <Button onClick={() => void run(refresh)}>加载文件篮</Button>}
            {snapshot && <>
                <BasketRows entries={basket} revision={snapshot.revision} chosen={chosen} onChoose={request.multiple ? undefined : setChosen}
                    onChange={saveBasket} onInsert={(id, anchor) => openInsert(anchor, id)} disabled={editingDisabled} onDragging={setDragging}
                    add={<Button startIcon={<Add />} disabled={toolbarDisabled || basket.length >= 64} onClick={event => openInsert(event.currentTarget)}>添加文件</Button>} />
                {!!basket.length && <Typography variant="caption" color="text.secondary">
                    {request.multiple ? `将按当前顺序使用全部 ${basket.length} 个文件` : '使用单选按钮选择一个文件'}
                </Typography>}
            </>}
            <DeviceImport destination="basket" afterId={afterId} accept={fileChooserAccept(request)} disabled={toolbarDisabled}
                inputRef={input} onBusy={setUploading} onError={setError} onDone={() => setAfterId(undefined)} />
            {(busy || uploading || transaction?.active) && <LinearProgress />}
            <Typography role="status" variant="caption">{final ? transaction?.state === 'selected' ? '文件已交给页面' : '文件选择已关闭' : waiting ? '等待页面确认文件' : ''}</Typography>
        </DialogContent>
        <DialogActions>
            <Button disabled={disabled || final || dragging} onClick={cancel}>取消</Button>
            <Button variant="contained" disabled={disabled || final || dragging || (!transaction && (waiting || !selection.length))} onClick={beginSelection}>
                {transaction ? '重试确认' : request.multiple && selection.length ? `使用全部（${selection.length}）` : '使用选中文件'}
            </Button>
        </DialogActions>
        <Menu anchorEl={insertMenu} open={!!insertMenu} onClose={() => setInsertMenu(null)}>
            <MenuItem onClick={() => { setInsertMenu(null); input.current?.click(); }}>从设备选择</MenuItem>
            <MenuItem onClick={() => { setInsertMenu(null); setCamera(true); }}>摄像头拍照</MenuItem>
            <MenuItem disabled={!archived.length} onClick={() => { setInsertMenu(null); setArchivedPicker(true); }}>从我的文件选择</MenuItem>
        </Menu>
        {archivedPicker && <ArchivePicker entries={archived} onClose={() => setArchivedPicker(false)} onAdd={id => {
            const ids = basket.map(item => item.id);
            const index = afterId ? ids.indexOf(afterId) : -1;
            ids.splice(index >= 0 ? index + 1 : ids.length, 0, id);
            setArchivedPicker(false);
            void saveBasket(ids);
        }} />}
        {camera && <PhotoCapture afterId={afterId} onClose={() => { setCamera(false); setAfterId(undefined); }} />}
        {groupPicker && <GroupPicker title="选择文件保存分组" groups={groups} onClose={() => setGroupPicker(false)} onChoose={group => { setGroupPicker(false); submit(group); }} />}
    </Dialog>;
}
