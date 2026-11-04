import React, { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, ButtonBase, Dialog, DialogActions, DialogContent, DialogTitle, Divider, IconButton, Menu, MenuItem, TextField, Typography } from '@mui/material';
import { ArrowBack, CameraAltOutlined, CameraswitchOutlined } from '@mui/icons-material';
import type { Asset } from '../shared/file-library';
import { capturePhotoBurst } from './camera-capture';
import { fileError, GroupPicker, touchButton } from './file-library-controls';
import { useLibrary } from './file-library-state';
import { operationId } from './product-operations';
import { FileCard } from './file-card';
import { FileThumbnail } from './file-thumbnail';
import { FileViewButton, useFileView } from './file-view';
import { SortableFileItems } from './sortable-file-items';
import { compactPreview } from './basket-rows';

type PhotoMode = 'original' | 'rectify' | 'scan';
interface Photo {
    asset: Asset;
    preview: Blob;
}
interface Slot {
    id: string;
    importId: string;
    original: Photo;
    candidates: Photo[];
    needsChoice: boolean;
    processed?: Photo;
    processedMode?: 'rectify' | 'scan';
    useOriginal: boolean;
    warning?: string;
}
const modeLabels = { original: '照片', rectify: '文档校正', scan: '文档扫描' };
const disabledCameraButton = { color: '#b7c2d2', bgcolor: '#343e4d' };

function Picture({ blob, label }: { blob: Blob; label: string }) {
    const [url, setUrl] = useState<string>();
    useEffect(() => {
        const objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
        return () => URL.revokeObjectURL(objectUrl);
    }, [blob]);
    return <Box component="img" src={url} alt={label} sx={{ display: 'block', width: '100%', height: 'auto', maxHeight: '65vh', objectFit: 'contain', bgcolor: 'action.hover', borderRadius: 1 }} />;
}

export function PhotoCapture({ afterId, destination = 'basket', onClose }: {
    afterId?: string;
    destination?: 'basket' | 'library';
    onClose: () => void;
}) {
    const { rpc, online, snapshot, mutate, rememberPreview } = useLibrary();
    const maxSlots = destination === 'basket' ? Math.max(0, 64 - (snapshot?.basket.length ?? 0)) : 64;
    const groups = snapshot?.groups ?? [];
    const [capturing, setCapturing] = useState(true);
    const [slots, setSlots] = useState<Slot[]>([]);
    const [retake, setRetake] = useState<string>();
    const [compare, setCompare] = useState<string>();
    const [candidateChoice, setCandidateChoice] = useState<string>();
    const [selectedSlot, setSelectedSlot] = useState<string>();
    const [reviewMenu, setReviewMenu] = useState<{ id: string; anchor: HTMLElement; processing?: boolean }>();
    const [reviewDragging, setReviewDragging] = useState(false);
    const handleReviewDrag = React.useCallback((value: boolean) => {
        setReviewDragging(value);
        if (value) setReviewMenu(undefined);
    }, []);
    const [preview, setPreview] = useState<{ blob: Blob; label: string }>();
    const [mode, setMode] = useState<PhotoMode>('original');
    const [deviceId, setDeviceId] = useState<string>();
    const [devices, setDevices] = useState<string[]>([]);
    const [ready, setReady] = useState(false);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [pickingGroup, setPickingGroup] = useState(false);
    const [saveStarted, setSaveStarted] = useState(false);
    const reviewView = useFileView(slots.map(slot => ({ type: slot.original.asset.type })));
    const video = useRef<HTMLVideoElement>(null);
    const stream = useRef<MediaStream | undefined>(undefined);
    const task = useRef<AbortController | undefined>(undefined);
    const insertAfter = useRef(afterId);
    const selectedGroup = useRef<string | null>(null);
    const mounted = useRef(true);
    const cameraGeneration = useRef(0);
    const stopCamera = () => {
        cameraGeneration.current++;
        stream.current?.getTracks().forEach(track => track.stop());
        stream.current = undefined;
        if (video.current) video.current.srcObject = null;
    };
    const leaveCamera = () => {
        stopCamera();
        task.current?.abort();
        setReady(false);
        setRetake(undefined);
        setCapturing(false);
    };
    useEffect(() => {
        mounted.current = true;
        const hide = () => {
            if (document.visibilityState === 'hidden') {
                stopCamera();
                task.current?.abort();
                setRetake(undefined);
                setCapturing(false);
                setReady(false);
            }
        };
        document.addEventListener('visibilitychange', hide);
        return () => {
            mounted.current = false;
            stopCamera();
            task.current?.abort();
            document.removeEventListener('visibilitychange', hide);
        };
    }, []);
    useEffect(() => { if (!online) leaveCamera(); }, [online]);
    useEffect(() => {
        if (!capturing || !online || document.visibilityState === 'hidden') return;
        const generation = ++cameraGeneration.current;
        const media = navigator.mediaDevices;
        setReady(false);
        setError('');
        if (!media?.getUserMedia) {
            setError('无法打开摄像头，请使用 HTTPS');
            return;
        }
        void media.getUserMedia({
            audio: false,
            video: { ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
                width: { ideal: 1920, max: 2560 }, height: { ideal: 1080, max: 2160 }, frameRate: { ideal: 15, max: 24 } },
        }).then(async next => {
            if (generation !== cameraGeneration.current || !video.current) {
                next.getTracks().forEach(track => track.stop());
                return;
            }
            stream.current = next;
            video.current.srcObject = next;
            await video.current.play();
            if (generation !== cameraGeneration.current) return;
            setReady(true);
            const listed = await media.enumerateDevices().catch(() => []);
            if (generation === cameraGeneration.current) setDevices(listed.filter(device => device.kind === 'videoinput' && device.deviceId).map(device => device.deviceId));
        }).catch(() => {
            if (generation !== cameraGeneration.current) return;
            stopCamera();
            setReady(false);
            setError('无法使用摄像头，请检查摄像头权限');
        });
        return stopCamera;
    }, [capturing, online, deviceId]);

    async function run(label: string, operation: (signal: AbortSignal) => Promise<void>) {
        if (task.current || !online) return;
        const controller = new AbortController();
        task.current = controller;
        setError('');
        setBusy(label);
        try {
            await operation(controller.signal);
        } catch (failure) {
            if (!controller.signal.aborted && mounted.current) setError(fileError(failure));
        } finally {
            task.current = undefined;
            if (mounted.current) setBusy('');
        }
    }
    async function process(original: Photo, method: 'rectify' | 'scan', signal: AbortSignal): Promise<Photo> {
        try {
            const asset = await rpc.processPhoto(original.asset.assetId, method);
            return { asset, preview: await rpc.photoThumbnail(asset.assetId, signal) };
        } catch (error) {
            if (error instanceof Error && error.message === 'no_document') throw new Error('未识别到完整文档边缘。可使用原图，或将整页放进画面后重拍。');
            throw error;
        }
    }
    const shutter = () => void run('正在拍摄并处理照片…', async signal => {
        const node = video.current;
        if (!ready || !node || (!retake && slots.length >= maxSlots)) return;
        const captures = await capturePhotoBurst(node, signal);
        const photos: Photo[] = [];
        for (const frame of captures) {
            const asset = await rpc.uploadAsset(new File([frame.blob], 'photo.jpg', { type: 'image/jpeg' }), operationId(), signal);
            photos.push({ asset, preview: frame.preview });
        }
        if (signal.aborted) return;
        const rank = await rpc.rankPhotos(photos.map(photo => photo.asset.assetId));
        if (signal.aborted) return;
        const original = photos.find(photo => photo.asset.assetId === rank.selectedAssetId);
        if (!original) throw new Error('无法确认照片处理结果');
        const options = new Set(rank.candidates.slice(0, 3).map(option => option.assetId));
        const candidates = rank.uncertain ? photos.filter(photo => options.delete(photo.asset.assetId)) : [];
        if (rank.uncertain && !candidates.some(photo => photo.asset.assetId === original.asset.assetId)) {
            candidates.unshift(original);
            candidates.splice(3);
        }
        const slot: Slot = { id: retake ?? operationId(), importId: operationId(), original, candidates,
            needsChoice: rank.uncertain, useOriginal: true };
        if (rank.reason === 'low-quality') slot.warning = '照片可能不够清晰，可查看或重拍';
        if (mode !== 'original' && !slot.needsChoice) {
            try {
                slot.processed = await process(original, mode, signal);
                slot.processedMode = mode;
                slot.useOriginal = false;
            } catch (error) {
                slot.warning = fileError(error);
            }
        }
        if (signal.aborted) return;
        setSlots(previous => retake ? previous.map(old => old.id === retake ? slot : old) : [...previous, slot]);
        if (retake) leaveCamera();
    });
    function updateSlot(id: string, update: (slot: Slot) => Slot) {
        setSlots(previous => previous.map(slot => slot.id === id ? update(slot) : slot));
    }
    const save = () => void run('正在保存照片…', async signal => {
        if (slots.some(slot => slot.needsChoice)) return;
        setSaveStarted(true);
        for (const slot of slots) {
            if (signal.aborted) return;
            const photo = slot.useOriginal ? slot.original : slot.processed ?? slot.original;
            const extension = photo.asset.type === 'image/png' ? 'png' : 'jpg';
            const next = await mutate('library.import', {
                operationId: slot.importId, assetId: photo.asset.assetId,
                originalAssetId: photo === slot.original ? undefined : slot.original.asset.assetId,
                name: `photo-${slot.id.slice(-8)}.${extension}`, groupId: selectedGroup.current, destination, afterId: insertAfter.current,
            });
            rememberPreview(photo.asset.assetId, photo.preview);
            if (destination === 'basket' && insertAfter.current) {
                const index = next.basket.indexOf(insertAfter.current);
                if (index >= 0) insertAfter.current = next.basket[index + 1] ?? insertAfter.current;
            }
            if (!mounted.current) return;
            setSlots(previous => previous.filter(old => old.id !== slot.id));
        }
        if (mounted.current) onClose();
    });
    const candidateSlot = slots.find(slot => slot.id === compare);
    const candidate = candidateSlot?.candidates.find(photo => photo.asset.assetId === candidateChoice) ?? candidateSlot?.original;
    const pendingChoices = slots.filter(slot => slot.needsChoice).length;
    const currentSlot = slots.find(slot => slot.id === selectedSlot) ?? slots[0];
    const menuSlot = slots.find(slot => slot.id === reviewMenu?.id);
    const reviewLocked = !!busy || !online || saveStarted;
    const chosenPhoto = (slot: Slot) => slot.useOriginal ? slot.original : slot.processed ?? slot.original;
    const currentPhoto = currentSlot && chosenPhoto(currentSlot);
    function openPhoto(photo: Photo, label: string) {
        void run('正在加载照片…', async signal => {
            const blob = await rpc.readPhoto(photo.asset, signal);
            if (!signal.aborted) setPreview({ blob, label });
        });
    }
    function retakeSlot(id: string) {
        setReviewMenu(undefined);
        setSelectedSlot(id);
        setRetake(id);
        setCapturing(true);
    }
    function removeSlot(id: string) {
        const index = slots.findIndex(slot => slot.id === id);
        if (currentSlot?.id === id) setSelectedSlot((slots[index + 1] ?? slots[index - 1])?.id);
        setSlots(previous => previous.filter(slot => slot.id !== id));
        setReviewMenu(undefined);
    }
    function compareSlot(slot: Slot) {
        setReviewMenu(undefined);
        setSelectedSlot(slot.id);
        setError('');
        setCandidateChoice(slot.original.asset.assetId);
        setCompare(slot.id);
    }
    function processSlot(slot: Slot, method: 'rectify' | 'scan') {
        setReviewMenu(undefined);
        if (slot.processed && slot.processedMode === method) {
            updateSlot(slot.id, old => ({ ...old, useOriginal: false }));
            return;
        }
        void run('正在处理文档…', async signal => {
            const processed = await process(slot.original, method, signal);
            if (!signal.aborted) updateSlot(slot.id, old => ({ ...old, processed, processedMode: method, useOriginal: false, warning: undefined }));
        });
    }
    const closeCamera = () => {
        leaveCamera();
        if (!slots.length) onClose();
    };
    if (capturing) return <Dialog fullScreen open onClose={closeCamera} slotProps={{ paper: { 'aria-label': '摄像头拍照', sx: { bgcolor: '#101318', color: 'white' } } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1 }}>
            <IconButton aria-label={retake ? '取消重拍' : '返回'} onClick={closeCamera} sx={{ ...touchButton, color: 'inherit' }}><ArrowBack /></IconButton>
            <Typography sx={{ flex: 1 }}>{retake ? '重拍照片' : '连续拍照'}</Typography>
            <TextField select size="small" aria-label="拍摄模式" value={mode} disabled={!!busy} onChange={event => setMode(event.target.value as PhotoMode)}
                sx={{ minWidth: 108, bgcolor: 'background.paper', borderRadius: 1 }}>
                {(['original', 'rectify', 'scan'] as const).map(value => <MenuItem key={value} value={value}>{modeLabels[value]}</MenuItem>)}
            </TextField>
            {devices.length > 1 && <IconButton aria-label="切换摄像头" disabled={!!busy} onClick={() => {
                const active = stream.current?.getVideoTracks()[0]?.getSettings().deviceId ?? deviceId;
                setDeviceId(devices[(devices.indexOf(active ?? '') + 1) % devices.length]);
            }} sx={{ ...touchButton, color: 'inherit', '&.Mui-disabled': { color: disabledCameraButton.color } }}><CameraswitchOutlined /></IconButton>}
        </Box>
        {error && <Alert severity="warning">{error}</Alert>}
        <Box sx={{ flex: 1, position: 'relative', minHeight: 0 }}>
            <Box component="video" ref={video} muted playsInline sx={{ position: 'absolute', width: '100%', height: '100%', objectFit: 'contain' }} />
        </Box>
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 64, gap: 2, pb: 'env(safe-area-inset-bottom)' }}>
            <IconButton aria-label="拍照" color="primary" sx={{ ...touchButton, bgcolor: 'white', '&:hover': { bgcolor: 'grey.200' }, '&.Mui-disabled': disabledCameraButton }} disabled={!ready || !!busy || (!retake && slots.length >= maxSlots)} onClick={shutter}><CameraAltOutlined /></IconButton>
            {!retake && <Button variant="contained" disabled={!slots.length || !!busy} sx={{ ...touchButton, '&.Mui-disabled': disabledCameraButton }} onClick={leaveCamera}>完成（{slots.length}）</Button>}
            <Typography variant="caption" role="status">{busy || (!ready && !error ? '正在打开摄像头…' : '')}</Typography>
        </Box>
    </Dialog>;
    return <Dialog open fullWidth maxWidth="sm" disableEscapeKeyDown={reviewDragging} onClose={!busy && !reviewDragging ? onClose : undefined} aria-labelledby="photo-review">
        <DialogTitle id="photo-review" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', py: .75 }}>
            检查照片 · {slots.length}
            {!!slots.length && <FileViewButton mode={reviewView.mode} disabled={reviewDragging || !!busy || saveStarted}
                toggle={() => { setReviewMenu(undefined); reviewView.toggle(); }} />}
        </DialogTitle>
        <DialogContent dividers sx={{ px: 2 }}>
            {error && <Alert severity="warning">{error}</Alert>}
            {!slots.length && <Typography color="text.secondary">还没有照片</Typography>}
            {currentSlot && currentPhoto && <Box sx={{ mb: 1 }}>
                <ButtonBase disabled={reviewLocked || reviewDragging} onClick={() => openPhoto(currentPhoto, '照片预览')}
                    aria-label="查看当前照片大图" sx={{ width: '100%', display: 'block', borderRadius: 2, overflow: 'hidden' }}>
                    <FileThumbnail assetId={currentPhoto.asset.assetId} type={currentPhoto.asset.type} blob={currentPhoto.preview}
                        sx={{ height: 'clamp(150px, 34vh, 320px)' }} />
                </ButtonBase>
                {currentSlot.warning && <Typography variant="caption" color="warning.main">{currentSlot.warning}</Typography>}
            </Box>}
            {!!slots.length && <SortableFileItems items={slots.map((slot, index) => ({ ...slot, name: `照片 ${index + 1}` }))}
                revision={0} mode={reviewView.mode} label="照片顺序" disabled={reviewLocked}
                onDragging={handleReviewDrag} onChange={async ids => {
                    setSlots(previous => ids.flatMap(id => previous.find(slot => slot.id === id) ?? []));
                }} renderItem={(slot, flags) => {
                    const photo = chosenPhoto(slot), title = `照片 ${flags.index + 1}`;
                    const status = slot.needsChoice ? '待选片' : slot.useOriginal ? undefined : '已处理';
                    const disabled = reviewLocked || flags.dragging;
                    const showMenu = (anchor: HTMLElement, processing = false) => {
                        setSelectedSlot(slot.id);
                        setReviewMenu({ id: slot.id, anchor, processing });
                    };
                    if (reviewView.mode === 'cards') return <FileCard id={slot.id} title={title} type={photo.asset.type}
                        assetId={photo.asset.assetId} blob={photo.preview} detail={status ?? '原图'}
                        index={flags.index + 1} status={status} selected={currentSlot?.id === slot.id}
                        open={reviewMenu?.id === slot.id} activator={flags.activator}
                        disabled={reviewLocked || flags.dragging && !flags.activator} onOpen={showMenu} />;
                    return <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: .5,
                        minHeight: 56, borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'background.paper' }}>
                        {flags.handle}
                        <FileThumbnail assetId={photo.asset.assetId} type={photo.asset.type} blob={photo.preview} sx={compactPreview} />
                        <Box sx={{ flex: '1 1 74px' }}><Typography variant="body2">{title}</Typography>
                            {status && <Typography variant="caption" color={slot.needsChoice ? 'warning.main' : 'text.secondary'}>{status}</Typography>}
                        </Box>
                        <Button size="small" disabled={disabled} onClick={() => { setSelectedSlot(slot.id); openPhoto(photo, title); }}>查看</Button>
                        <Button size="small" disabled={disabled} onClick={() => retakeSlot(slot.id)}>重拍</Button>
                        <Button size="small" disabled={disabled || slot.needsChoice} onClick={event => showMenu(event.currentTarget, true)}>处理</Button>
                        {slot.candidates.length > 0 && <Button size="small" disabled={disabled} onClick={() => compareSlot(slot)}>候选</Button>}
                        <Button size="small" disabled={disabled} onClick={() => removeSlot(slot.id)}>移除</Button>
                    </Box>;
                }} />}
            {!!pendingChoices && <Typography variant="caption" role="status" color="warning.main">还有 {pendingChoices} 张需要选片</Typography>}
            {busy && <Typography role="status">{busy}</Typography>}
        </DialogContent>
        <DialogActions sx={{ flexWrap: 'wrap' }}>
            <Button disabled={!!busy || reviewDragging} onClick={onClose}>关闭</Button>
            {!saveStarted && <Button disabled={!online || !!busy || reviewDragging || slots.length >= maxSlots} onClick={() => setCapturing(true)}>继续拍照</Button>}
            <Button disabled={!online || !!busy || reviewDragging || !slots.length || slots.length > maxSlots || pendingChoices > 0} variant="contained" onClick={() => {
                if (groups.length && !saveStarted) setPickingGroup(true);
                else save();
            }}>{saveStarted ? '继续保存' : destination === 'basket' ? `加入文件篮（${slots.length}）` : `保存到我的文件（${slots.length}）`}</Button>
        </DialogActions>
        <Menu anchorEl={reviewMenu?.anchor} open={!!menuSlot && !reviewLocked} onClose={() => setReviewMenu(undefined)}>
            {reviewMenu?.processing ? [
                <MenuItem key="original" selected={!!menuSlot?.useOriginal} onClick={() => {
                    if (menuSlot) updateSlot(menuSlot.id, old => ({ ...old, useOriginal: true }));
                    setReviewMenu(undefined);
                }}>原图</MenuItem>,
                ...(['rectify', 'scan'] as const).map(method => <MenuItem key={method}
                    selected={!!menuSlot && !menuSlot.useOriginal && menuSlot.processedMode === method}
                    onClick={() => { if (menuSlot) processSlot(menuSlot, method); }}>{modeLabels[method]}</MenuItem>),
            ] : [
                <MenuItem key="preview" onClick={() => { if (menuSlot) openPhoto(chosenPhoto(menuSlot), '照片预览'); setReviewMenu(undefined); }}>查看大图</MenuItem>,
                <MenuItem key="retake" onClick={() => { if (menuSlot) retakeSlot(menuSlot.id); }}>重拍这张</MenuItem>,
                <MenuItem key="process" disabled={!!menuSlot?.needsChoice} onClick={() => setReviewMenu(old => old && { ...old, processing: true })}>处理照片…</MenuItem>,
                menuSlot && menuSlot.candidates.length > 0 ? <MenuItem key="candidate" onClick={() => compareSlot(menuSlot)}>查看候选</MenuItem> : null,
                <Divider key="divider" />,
                <MenuItem key="remove" onClick={() => { if (menuSlot) removeSlot(menuSlot.id); }}>移除</MenuItem>,
            ]}
        </Menu>
        {pickingGroup && <GroupPicker groups={groups} title="选择照片分组" onClose={() => setPickingGroup(false)} onChoose={group => {
            selectedGroup.current = group;
            setPickingGroup(false);
            save();
        }} />}
        {candidateSlot && candidate && <Dialog open fullWidth maxWidth="sm" onClose={busy ? undefined : () => setCompare(undefined)}>
            <DialogTitle>比较候选照片</DialogTitle>
            <DialogContent sx={{ px: 2 }}>
                <ButtonBase disabled={!online || !!busy} onClick={() => openPhoto(candidate, '候选照片原图')}
                    aria-label="查看原图" sx={{ width: '100%', display: 'block', borderRadius: 2, overflow: 'hidden' }}>
                    <FileThumbnail assetId={candidate.asset.assetId} type={candidate.asset.type} blob={candidate.preview}
                        sx={{ height: 'clamp(144px, 32vh, 300px)' }} />
                </ButtonBase>
                <Box sx={{ display: 'flex', overflowX: 'auto', gap: '10px', py: 1 }}>
                    {candidateSlot.candidates.map((option, index) => <Box key={option.asset.assetId} sx={{ flex: '0 0 144px' }}>
                        <FileCard id={option.asset.assetId} title={`候选 ${index + 1}`} type={option.asset.type}
                            assetId={option.asset.assetId} blob={option.preview} detail="点击比较" index={index + 1}
                            popup={false} selected={option.asset.assetId === candidate.asset.assetId} disabled={!!busy}
                            onOpen={() => setCandidateChoice(option.asset.assetId)} />
                    </Box>)}
                </Box>
                {busy && <Typography role="status">{busy}</Typography>}
                {error && <Alert severity="warning">{error}</Alert>}
            </DialogContent>
            <DialogActions>
                <Button disabled={!online || !!busy} onClick={() => openPhoto(candidate, '候选照片原图')}>查看原图</Button>
                <Button disabled={!!busy} onClick={() => setCompare(undefined)}>返回检查</Button>
                <Button variant="contained" disabled={!!busy} onClick={() => {
                    updateSlot(candidateSlot.id, old => candidate === old.original ? { ...old, needsChoice: false }
                        : { ...old, original: candidate, processed: undefined, processedMode: undefined, useOriginal: true, needsChoice: false });
                    setCompare(undefined);
                }}>使用这张</Button>
            </DialogActions>
        </Dialog>}
        {preview && <Dialog open fullWidth maxWidth="md" onClose={() => setPreview(undefined)}>
            <DialogTitle>{preview.label}</DialogTitle>
            <DialogContent><Picture blob={preview.blob} label={preview.label} /></DialogContent>
            <DialogActions><Button onClick={() => setPreview(undefined)}>{candidateSlot ? '返回候选' : '返回检查'}</Button></DialogActions>
        </Dialog>}
    </Dialog>;
}
