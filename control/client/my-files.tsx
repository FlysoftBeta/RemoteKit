import React, { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, LinearProgress, List, ListItemButton, ListSubheader, Menu, MenuItem, TextField, Typography, useMediaQuery } from '@mui/material';
import { Add } from '@mui/icons-material';
import type { LibraryEntry, LibraryGroup } from '../shared/file-library';
import { basketEntries, DeviceImport, fileError, GroupField, GroupPicker } from './file-library-controls';
import { BasketRows, compactPreview, fileSize } from './basket-rows';
import { FileCard } from './file-card';
import { FileThumbnail } from './file-thumbnail';
import { FileViewButton, useFileView } from './file-view';
import { ArchivePicker, fileGrid } from './archive-picker';
import { canPreviewFile, FileImagePreview } from './file-image-preview';
import { useLibrary } from './file-library-state';
import { PhotoCapture } from './photo-library-capture';
import { operationId } from './product-operations';

const PAGE_SIZE = 50;
const dates = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });

export function MyFiles({ visible }: { visible: boolean }) {
    const { snapshot, online, refresh, mutate } = useLibrary();
    const [narrow, setNarrow] = useState(false);
    const [filter, setFilter] = useState<string | null>('*');
    const [limit, setLimit] = useState(PAGE_SIZE);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [camera, setCamera] = useState<{ afterId?: string; destination: 'library' | 'basket' }>();
    const [showBasket, setShowBasket] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [basketInsertion, setBasketInsertion] = useState<string>();
    const [source, setSource] = useState<{ anchor: HTMLElement; destination: 'library' | 'basket' }>();
    const [archive, setArchive] = useState(false);
    const [cardMenu, setCardMenu] = useState<{ anchor: HTMLElement; id: string }>();
    const [preview, setPreview] = useState<LibraryEntry>();
    const [move, setMove] = useState<LibraryEntry>();
    const [deletion, setDeletion] = useState<{ entry: LibraryEntry; operationId: string }>();
    const [groupEdit, setGroupEdit] = useState<{ group?: LibraryGroup; name: string }>();
    const input = useRef<HTMLInputElement>(null), basketInput = useRef<HTMLInputElement>(null), pane = useRef<HTMLDivElement>(null);
    const groups = snapshot?.groups ?? [];
    const basket = basketEntries(snapshot);
    const inBasket = new Set(basket.map(entry => entry.id));
    const catalog = snapshot?.entries.filter(entry => entry.archived)
        .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)) ?? [];
    const entries = catalog.filter(entry => filter === '*' || entry.groupId === filter);
    const menuEntry = entries.find(entry => entry.id === cardMenu?.id);
    const view = useFileView(entries);
    const today = new Date(), yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    const days = new Map<string, LibraryEntry[]>();
    for (const entry of entries.slice(0, limit)) {
        const day = new Date(entry.createdAt).toDateString();
        const key = day === today.toDateString() ? '今天' : day === yesterday.toDateString() ? '昨天' : dates.format(entry.createdAt);
        const bucket = days.get(key);
        if (bucket) bucket.push(entry);
        else days.set(key, [entry]);
    }
    const disabled = !online || busy || uploading || !snapshot;
    const systemNarrow = useMediaQuery('(max-width:599px)');
    useEffect(() => {
        if (online && visible) void refresh().catch(() => {});
    }, [online, visible]);
    useEffect(() => {
        const node = pane.current;
        if (!node || typeof ResizeObserver === 'undefined') return;
        const resize = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 580));
        resize.observe(node);
        return () => resize.disconnect();
    }, []);
    useEffect(() => {
        if (!visible) {
            setCamera(undefined); setShowBasket(false); setMove(undefined); setGroupEdit(undefined); setDeletion(undefined);
            setSource(undefined); setArchive(false); setCardMenu(undefined); setPreview(undefined);
        }
    }, [visible]);
    const selectFilter = (groupId: string | null) => { setFilter(groupId); setLimit(PAGE_SIZE); };
    async function run(action: () => Promise<void>) {
        setError('');
        setBusy(true);
        try { await action(); } catch (failure) { setError(fileError(failure)); }
        finally { setBusy(false); }
    }
    const saveBasket = (ids: string[], revision = snapshot?.revision) => run(async () => {
        if (revision !== undefined) await mutate('library.basket', { operationId: operationId(), ids, expectedRevision: revision });
    });
    const currentGroup = groups.find(group => group.id === filter);
    const addToBasket = (id: string, afterId?: string) => {
        const ids = basket.map(entry => entry.id);
        const position = afterId ? ids.indexOf(afterId) : -1;
        if (afterId && position < 0) { setError('文件篮已更新，请重新选择插入位置'); return; }
        ids.splice(position >= 0 ? position + 1 : ids.length, 0, id);
        void saveBasket(ids);
    };
    const deleteEntry = (entry: LibraryEntry) => {
        setError('');
        setDeletion({ entry, operationId: operationId() });
    };
    function openBasketSource(anchor: HTMLElement, afterId?: string) {
        setBasketInsertion(afterId);
        setSource({ anchor, destination: 'basket' });
    }
    return <Box ref={pane} sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto', bgcolor: 'background.paper', px: { xs: 1, sm: 2 }, pt: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', pb: 1 }}>
            <Typography variant="h6" sx={{ mr: 'auto' }}>我的文件</Typography>
            <Button startIcon={<Add />} disabled={disabled} onClick={event => setSource({ anchor: event.currentTarget, destination: 'library' })}>添加文件</Button>
            <Button disabled={!snapshot} onClick={() => setShowBasket(true)}>文件篮（{basket.length}）</Button>
            {!!entries.length && <FileViewButton mode={view.mode} toggle={() => { setCardMenu(undefined); view.toggle(); }} />}
        </Box>
        {error && <Alert severity="warning" onClose={() => setError('')}>{error}</Alert>}
        {(busy || uploading) && <LinearProgress />}
        {!snapshot && online && <Button disabled={busy} onClick={() => void run(refresh)}>加载我的文件</Button>}
        {!online && <Typography variant="caption">等待连接恢复</Typography>}
        <DeviceImport destination="library" inputRef={input} disabled={disabled} onBusy={setUploading} onError={setError} />
        {snapshot && <Box sx={{ display: 'flex', flexDirection: narrow || systemNarrow ? 'column' : 'row', gap: 2 }}>
            <Box sx={{ width: narrow || systemNarrow ? '100%' : 156, flexShrink: 0 }}>
                {narrow || systemNarrow ? <GroupField includeAll groups={groups} value={filter} onChange={selectFilter} /> :
                    <List dense aria-label="分组">
                        <ListItemButton selected={filter === '*'} onClick={() => selectFilter('*')}>全部文件</ListItemButton>
                        <ListItemButton selected={filter === null} onClick={() => selectFilter(null)}>未分组</ListItemButton>
                        {groups.map(group => <ListItemButton key={group.id} selected={filter === group.id} onClick={() => selectFilter(group.id)} sx={{ overflowWrap: 'anywhere' }}>{group.name}</ListItemButton>)}
                    </List>}
                <Button disabled={disabled} onClick={() => setGroupEdit({ name: '' })}>新建分组</Button>
                {currentGroup && <Button disabled={disabled} onClick={() => setGroupEdit({ group: currentGroup, name: currentGroup.name })}>重命名分组</Button>}
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
                {!entries.length && <Typography color="text.secondary" sx={{ pt: 2 }}>暂无文件</Typography>}
                {[...days].map(([date, files]) => <Box key={date} sx={{ pb: 2 }}>
                    <Typography variant="subtitle2" sx={{ pb: .75 }}>{date}</Typography>
                    {view.mode === 'cards' ? <Box sx={fileGrid}>{files.map(entry => <Box key={entry.id} sx={{ minWidth: 0, maxWidth: 180 }}>
                        <FileCard id={entry.id} title={entry.name} type={entry.type} assetId={entry.assetId} detail={fileSize(entry.size)}
                            status={inBasket.has(entry.id) ? '已在篮中' : undefined} open={menuEntry?.id === entry.id} disabled={disabled}
                            onOpen={anchor => setCardMenu({ anchor, id: entry.id })} />
                    </Box>)}</Box> : files.map(entry => <Box key={entry.id} sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: .75,
                        minHeight: 56, py: .5, borderBottom: '1px solid', borderColor: 'divider' }}>
                        <FileThumbnail assetId={entry.assetId} type={entry.type} sx={compactPreview} />
                        <Box sx={{ flex: '1 1 100px', minWidth: 0 }}><Typography variant="body2" noWrap title={entry.name}>{entry.name}</Typography>
                            <Typography variant="caption" color="text.secondary">{fileSize(entry.size)}</Typography>
                        </Box>
                        {canPreviewFile(entry) && <Button size="small" disabled={disabled} onClick={() => setPreview(entry)}>查看</Button>}
                        <Button size="small" disabled={disabled || inBasket.has(entry.id) || basket.length >= 64} onClick={() => addToBasket(entry.id)}>{inBasket.has(entry.id) ? '已在篮中' : '加入文件篮'}</Button>
                        <Button size="small" disabled={disabled || !groups.length} onClick={() => setMove(entry)}>移动</Button>
                        <Button size="small" color="error" disabled={disabled} aria-label={`删除 ${entry.name}`} onClick={() => deleteEntry(entry)}>删除</Button>
                    </Box>)}
                </Box>)}
                {entries.length > limit && <Button onClick={() => setLimit(previous => previous + PAGE_SIZE)}>显示更多</Button>}
            </Box>
        </Box>}
        {visible && camera && <PhotoCapture {...camera} onClose={() => setCamera(undefined)} />}
        {visible && move && <GroupPicker title="移动文件" groups={groups} initial={move.groupId} onClose={() => setMove(undefined)} onChoose={groupId => {
            setMove(undefined);
            void run(async () => { await mutate('library.move', { operationId: operationId(), ids: [move.id], groupId }); });
        }} />}
        {visible && deletion && <Dialog open fullWidth maxWidth="xs" aria-labelledby="delete-library-file" onClose={busy ? undefined : () => setDeletion(undefined)}>
            <DialogTitle id="delete-library-file">删除文件？</DialogTitle>
            <DialogContent>
                <Typography sx={{ overflowWrap: 'anywhere' }}>{deletion.entry.name}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>将从我的文件和文件篮删除。页面已接收的副本会保留。</Typography>
                {error && <Alert severity="warning" sx={{ mt: 1 }}>{error}</Alert>}
            </DialogContent>
            <DialogActions>
                <Button autoFocus disabled={busy} onClick={() => setDeletion(undefined)}>取消</Button>
                <Button color="error" variant="contained" disabled={disabled} onClick={() => void run(async () => {
                    await mutate('library.delete', { operationId: deletion.operationId, ids: [deletion.entry.id] });
                    setDeletion(undefined);
                })}>删除文件</Button>
            </DialogActions>
        </Dialog>}
        {visible && groupEdit && <Dialog open fullWidth maxWidth="xs" onClose={() => setGroupEdit(undefined)}>
            <Box component="form" onSubmit={event => {
                event.preventDefault();
                if (disabled || !groupEdit.name.trim()) return;
                const { group, name } = groupEdit;
                setGroupEdit(undefined);
                void run(async () => { await mutate('library.group', { operationId: operationId(), id: group?.id, name: name.trim() }); });
            }}>
                <DialogTitle>{groupEdit.group ? '重命名分组' : '新建分组'}</DialogTitle>
                <DialogContent><TextField autoFocus fullWidth label="分组名称" size="small" value={groupEdit.name} slotProps={{ htmlInput: { maxLength: 80 } }} sx={{ mt: 1 }}
                    onChange={event => setGroupEdit({ ...groupEdit, name: event.target.value })} /></DialogContent>
                <DialogActions><Button onClick={() => setGroupEdit(undefined)}>取消</Button><Button type="submit" variant="contained" disabled={disabled || !groupEdit.name.trim()}>保存</Button></DialogActions>
            </Box>
        </Dialog>}
        {visible && showBasket && <Dialog open fullWidth maxWidth="xs" disableEscapeKeyDown={dragging}
            onClose={uploading || dragging ? undefined : () => setShowBasket(false)}>
            <DialogTitle>文件篮（{basket.length}）</DialogTitle>
            <DialogContent>
                {error && <Alert severity="warning">{error}</Alert>}
                {uploading && <LinearProgress />}
                {!basket.length && <Typography color="text.secondary">文件篮为空</Typography>}
                {snapshot && <BasketRows entries={basket} revision={snapshot.revision} onChange={saveBasket} disabled={disabled}
                    onInsert={(id, anchor) => openBasketSource(anchor, id)} onDragging={setDragging}
                    add={<Button startIcon={<Add />} disabled={disabled || dragging || basket.length >= 64} onClick={event => openBasketSource(event.currentTarget)}>添加文件</Button>} />}
                <DeviceImport destination="basket" afterId={basketInsertion} inputRef={basketInput} disabled={disabled || dragging}
                    onBusy={setUploading} onError={setError} onDone={() => setBasketInsertion(undefined)} />
            </DialogContent>
            <DialogActions><Button disabled={uploading || dragging} onClick={() => { setShowBasket(false); setBasketInsertion(undefined); }}>关闭</Button></DialogActions>
        </Dialog>}
        {visible && <Menu anchorEl={source?.anchor} open={!!source} onClose={() => setSource(undefined)}>
            <MenuItem onClick={() => { (source?.destination === 'basket' ? basketInput : input).current?.click(); setSource(undefined); }}>从设备选择</MenuItem>
            <MenuItem onClick={() => {
                if (source) setCamera({ destination: source.destination, afterId: source.destination === 'basket' ? basketInsertion : undefined });
                setSource(undefined);
            }}>摄像头拍照</MenuItem>
            {source?.destination === 'basket' && <MenuItem onClick={() => { setArchive(true); setSource(undefined); }}>从我的文件选择</MenuItem>}
        </Menu>}
        {visible && <Menu anchorEl={cardMenu?.anchor} open={!!menuEntry && !disabled} onClose={() => setCardMenu(undefined)}>
            <ListSubheader disableSticky sx={{ py: .5, maxWidth: 300, overflowWrap: 'anywhere', lineHeight: 1.4 }}>
                <Typography variant="subtitle2">{menuEntry?.name}</Typography>
                <Typography variant="caption">{menuEntry && `${dates.format(menuEntry.createdAt)} · ${fileSize(menuEntry.size)}`}</Typography>
            </ListSubheader>
            <Divider />
            {menuEntry && canPreviewFile(menuEntry) && <MenuItem onClick={() => { setPreview(menuEntry); setCardMenu(undefined); }}>查看大图</MenuItem>}
            <MenuItem disabled={!menuEntry || inBasket.has(menuEntry.id) || basket.length >= 64} onClick={() => {
                if (menuEntry) addToBasket(menuEntry.id);
                setCardMenu(undefined);
            }}>{menuEntry && inBasket.has(menuEntry.id) ? '已在篮中' : '加入文件篮'}</MenuItem>
            <MenuItem disabled={!groups.length} onClick={() => { setMove(menuEntry); setCardMenu(undefined); }}>移动到分组…</MenuItem>
            <Divider />
            <MenuItem sx={{ color: 'error.main' }} onClick={() => { if (menuEntry) deleteEntry(menuEntry); setCardMenu(undefined); }}>删除文件</MenuItem>
        </Menu>}
        {visible && archive && <ArchivePicker entries={catalog.filter(entry => !inBasket.has(entry.id))} onClose={() => setArchive(false)}
            onAdd={id => { addToBasket(id, basketInsertion); setArchive(false); }} />}
        {visible && preview && <FileImagePreview entry={preview} onClose={() => setPreview(undefined)} />}
    </Box>;
}
