import React, { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, LinearProgress, Typography, useMediaQuery } from '@mui/material';
import { Close, DeleteOutline, InsertDriveFileOutlined, CameraAltOutlined } from '@mui/icons-material';
import type { FileRequest } from '../shared/product';
import { cameraFormat, mergeSelection, combineSelection, validateSelection } from './file-selection';
import { uploadFile, type FileRpc } from './file-upload';
import { CameraCapture } from './camera-capture';
import type { CameraCandidate } from './camera-candidates';
export function FileChooserDialog({ request, online, rpc }: {
    request: FileRequest;
    online: boolean;
    rpc: FileRpc;
}) {
    const narrow = useMediaQuery('(max-width:599px)');
    const [files, setFiles] = useState<File[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false), [waiting, setWaiting] = useState(request.state === 'validating'), [sent, setSent] = useState(0);
    const [camera, setCamera] = useState<'off' | 'opening' | 'preview' | 'capturing'>('off'), [candidates, setCandidates] = useState<CameraCandidate[]>([]), [selected, setSelected] = useState<number[]>([]), [zoom, setZoom] = useState<number | null>(null);
    const input = useRef<HTMLInputElement>(null), video = useRef<HTMLVideoElement>(null), stream = useRef<MediaStream | null>(null), capture = useRef(new CameraCapture()), controller = useRef<AbortController | null>(null), uploadId = useRef<string | undefined>(undefined), generation = useRef(0), mounted = useRef(true), cameraGeneration = useRef(0);
    const format = cameraFormat(request.accept);
    const commitPending = useRef(false);
    const stopCamera = () => { cameraGeneration.current++; stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; if (video.current)
        video.current.srcObject = null; capture.current.cancel(); setCamera('off'); };
    useEffect(() => {
        mounted.current = true;
        const hide = () => { if (document.visibilityState === 'hidden')
            stopCamera(); };
        document.addEventListener('visibilitychange', hide);
        return () => { mounted.current = false; generation.current++; cameraGeneration.current++; stream.current?.getTracks().forEach(track => track.stop()); capture.current.cancel(); controller.current?.abort(); document.removeEventListener('visibilitychange', hide); };
    }, []);
    useEffect(() => { if (!online) {
        stopCamera();
        generation.current++;
        controller.current?.abort();
        setBusy(false);
        setError('连接中断，请恢复连接后重试');
    } }, [online]);
    useEffect(() => { if (request.state === 'validating')
        setWaiting(true); }, [request.state]);
    const selectedPhotos = candidates.filter(c => selected.includes(c.id));
    const allFiles = () => combineSelection(files, selectedPhotos.map(c => new File([c.blob], `photo-${c.id + 1}.${format === 'image/png' ? 'png' : 'jpg'}`, { type: c.blob.type, lastModified: Math.round(c.at) })), request.multiple);
    const openCamera = async () => {
        stopCamera();
        setCandidates([]);
        setSelected([]);
        setZoom(null);
        setError('');
        const current = ++cameraGeneration.current;
        setCamera('opening');
        if (!navigator.mediaDevices?.getUserMedia) {
            setCamera('off');
            setError('当前连接无法使用摄像头，请使用 HTTPS，或从设备选择文件');
            return;
        }
        try {
            const next = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280, max: 1920 }, height: { ideal: 720, max: 1080 }, frameRate: { ideal: 15, max: 15 } } });
            if (!mounted.current || current !== cameraGeneration.current || document.visibilityState === 'hidden') {
                next.getTracks().forEach(track => track.stop());
                return;
            }
            stream.current = next;
            setCamera('preview');
            // Ref is mounted throughout opening/preview; wait until React commits it.
            requestAnimationFrame(() => { if (current !== cameraGeneration.current || !video.current)
                return; video.current.srcObject = next; void video.current.play().catch(() => { if (current === cameraGeneration.current) {
                stopCamera();
                setError('无法预览摄像头，请重试或从设备选择文件');
            } }); });
        }
        catch (e) {
            if (current !== cameraGeneration.current)
                return;
            setCamera('off');
            setError((e as DOMException).name === 'NotFoundError' ? '未找到摄像头' : '无法使用摄像头，请允许访问，或从设备选择文件');
        }
    };
    const takePhoto = async () => {
        if (!format || !video.current || camera !== 'preview')
            return;
        const current = cameraGeneration.current;
        setCamera('capturing');
        setError('');
        try {
            const result = await capture.current.capture(video.current, format);
            if (current !== cameraGeneration.current)
                return;
            setCandidates(result);
            setSelected([]);
        }
        catch (e) {
            if (current === cameraGeneration.current)
                setError(e instanceof Error ? e.message : '无法处理照片');
        }
        finally {
            if (current === cameraGeneration.current)
                stopCamera();
        }
    };
    const cancel = async () => {
        stopCamera();
        generation.current++;
        controller.current?.abort();
        setBusy(true);
        setError('');
        try {
            const result = await rpc.cancel(request.id, uploadId.current);
            if (!mounted.current)
                return;
            if (result.state === 'validating') {
                setWaiting(true);
                setError('文件已在验证，正在等待页面确认');
            }
            else if (result.state === 'selected') {
                setWaiting(true);
                setError('文件已交给页面');
            }
            else {
                setFiles([]);
                setCandidates([]);
                setSelected([]);
                setWaiting(true);
            }
        }
        catch {
            if (mounted.current)
                setError('暂时无法取消，请重试');
        }
        finally {
            if (mounted.current)
                setBusy(false);
        }
    };
    const submit = async () => {
        if (busy || waiting || !online)
            return;
        const selection = allFiles(), problem = validateSelection(selection, request);
        if (problem) {
            setError(problem);
            return;
        }
        stopCamera();
        setBusy(true);
        setError('');
        setSent(0);
        const current = ++generation.current, abort = new AbortController();
        controller.current = abort;
        const valid = () => mounted.current && generation.current === current && !abort.signal.aborted;
        try {
            if (!commitPending.current) {
                const begin = await rpc.begin(request.id, selection);
                if (!valid()) {
                    void rpc.cancel(request.id, begin.uploadId).catch(() => { });
                    return;
                }
                uploadId.current = begin.uploadId;
                if (begin.files.length !== selection.length)
                    throw new Error('上传文件数量不一致');
                let completed = 0;
                for (let i = 0; i < selection.length; i++) {
                    await uploadFile(begin.files[i].url, selection[i], abort.signal, bytes => { if (valid())
                        setSent(completed + bytes); });
                    completed += selection[i].size;
                    if (!valid())
                        return;
                }
                commitPending.current = true;
            }
            const result = await rpc.commit(uploadId.current!);
            if (!valid())
                return;
            setWaiting(result.state !== 'cancelled');
            if (result.state === 'cancelled')
                throw new Error('文件选择已取消');
        }
        catch (e) {
            if (valid()) {
                setError(commitPending.current ? '正在确认页面是否收到文件，请重试确认' : e instanceof Error ? e.message : '文件未发送，请重试');
            }
        }
        finally {
            if (valid()) {
                setBusy(false);
                controller.current = null;
            }
        }
    };
    // Commit is idempotent. Poll only for asynchronous Browser validation of this upload.
    useEffect(() => { if (!waiting || !uploadId.current || !online)
        return; let active = true, timer: ReturnType<typeof setTimeout>; const poll = async () => { try {
        const result = await rpc.commit(uploadId.current!);
        if (!active)
            return;
        if (result.state === 'validating')
            timer = setTimeout(poll, 500);
        else if (result.state === 'cancelled') {
            setWaiting(false);
            setError('文件选择已取消');
        }
    }
    catch {
        if (active)
            setError('无法确认文件状态，请恢复连接后重试');
    } }; timer = setTimeout(poll, 500); return () => { active = false; clearTimeout(timer); }; }, [waiting, online, rpc]);
    const total = allFiles().reduce((sum, f) => sum + f.size, 0);
    return <Dialog open fullWidth maxWidth="sm" fullScreen={narrow} onClose={online ? () => void cancel() : undefined} aria-labelledby="file-chooser-title" aria-describedby="file-chooser-origin">
    <DialogTitle id="file-chooser-title" sx={{ pr: 7 }}>选择文件<IconButton aria-label="取消文件选择" disabled={!online} onClick={() => void cancel()} sx={{ position: 'absolute', right: 8, top: 8, minWidth: 44, minHeight: 44 }}><Close /></IconButton></DialogTitle>
    <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography id="file-chooser-origin" variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{request.origin}</Typography>
      {error && <Alert severity="warning">{error}</Alert>}
      {!waiting && <>
        <input hidden ref={input} type="file" accept={request.accept.join(',')} multiple={request.multiple} onChange={event => { const chosen=Array.from(event.target.files??[]);setFiles(previous => mergeSelection(previous, chosen, request.multiple)); event.target.value = ''; if (!request.multiple)
            setSelected([]); setError(''); }}/>
        {camera === 'off' ? <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}><Button disabled={busy || !online || commitPending.current} onClick={() => input.current?.click()}>从设备选择</Button><Button startIcon={<CameraAltOutlined />} disabled={busy || !online || commitPending.current || !format} onClick={() => void openCamera()}>{candidates.length ? '重新拍照' : '摄像头拍照'}</Button>{!format && <Typography variant="caption">此页面不接受支持的照片格式</Typography>}</Box> : <Box>
          <video ref={video} muted playsInline style={{ width: '100%', maxHeight: '40vh', objectFit: 'contain', background: '#111' }}/>
          <Box sx={{ display: 'flex', gap: 1 }}><Button disabled={camera !== 'preview' || busy} onClick={() => void takePhoto()}>{camera === 'opening' ? '正在打开摄像头…' : camera === 'capturing' ? '正在选取照片…' : '拍照'}</Button><Button onClick={stopCamera}>关闭摄像头</Button></Box>
        </Box>}
        {files.map((file, index) => <Box key={`${file.name}-${index}`} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}><InsertDriveFileOutlined /><Box sx={{ flex: 1, minWidth: 0 }}><Typography sx={{ overflowWrap: 'anywhere' }}>{file.name}</Typography><Typography variant="caption">{(file.size / 1024).toFixed(1)} KB</Typography></Box><IconButton aria-label={`移除 ${file.name}`} disabled={busy || commitPending.current} onClick={() => setFiles(previous => previous.filter((_, i) => i !== index))} sx={{ minWidth: 44, minHeight: 44 }}><DeleteOutline /></IconButton></Box>)}
        {!!candidates.length && <Box sx={{ display: 'grid', gridTemplateColumns: zoom === null ? 'repeat(3,minmax(0,1fr))' : '1fr', gap: 1 }}>{candidates.filter(c => zoom === null || zoom === c.id).map((candidate, index) => <Photo key={candidate.id} candidate={candidate} label={`照片 ${index + 1}`} selected={selected.includes(candidate.id)} multiple={request.multiple} disabled={busy || commitPending.current} onSelect={() => { setSelected(previous => request.multiple ? previous.includes(candidate.id) ? previous.filter(id => id !== candidate.id) : [...previous, candidate.id] : [candidate.id]); if (!request.multiple)
            setFiles([]); }} onZoom={() => setZoom(zoom === null ? candidate.id : null)} zoomed={zoom !== null}/>)}</Box>}
      </>}
      <Typography role="status" aria-live="polite" variant="body2">{waiting ? '正在等待页面确认…' : busy ? '正在发送…' : allFiles().length ? `已选择 ${allFiles().length} 个文件` : ''}</Typography>
      {busy && <LinearProgress variant={total ? 'determinate' : 'indeterminate'} value={total ? sent / total * 100 : undefined}/>}
    </DialogContent>
    <DialogActions sx={{ px: 2, pb: 'max(16px, env(safe-area-inset-bottom))' }}><Button disabled={!online} onClick={() => void cancel()}>{busy ? '取消发送' : '取消'}</Button><Button variant="contained" disabled={!online || busy || waiting || !allFiles().length} onClick={() => void submit()}>{allFiles().length > 1 ? `使用 ${allFiles().length} 个文件` : '使用文件'}</Button></DialogActions>
  </Dialog>;
}
function Photo({ candidate, label, selected, multiple, disabled, onSelect, onZoom, zoomed }: {
    candidate: CameraCandidate;
    label: string;
    selected: boolean;
    multiple: boolean;
    disabled: boolean;
    onSelect: () => void;
    onZoom: () => void;
    zoomed: boolean;
}) {
    const [url, setUrl] = useState('');
    useEffect(() => { const next = URL.createObjectURL(candidate.blob); setUrl(next); return () => URL.revokeObjectURL(next); }, [candidate.blob]);
    return <Box sx={{ minWidth: 0 }}><Box component="label" sx={{ display: 'block', border: 2, borderColor: selected ? 'primary.main' : 'divider', borderRadius: 1, cursor: 'pointer', p: .5 }}><input type={multiple ? 'checkbox' : 'radio'} name="camera-photo" aria-label={label} checked={selected} disabled={disabled} onChange={onSelect}/><Typography component="span" variant="caption">{label}</Typography><img src={url} alt="" style={{ display: 'block', width: '100%', height: zoomed ? 'auto' : 96, objectFit: 'contain' }}/></Box><Button size="small" onClick={onZoom} sx={{ minHeight: 44 }}>{zoomed ? '返回候选' : '查看照片'}</Button></Box>;
}
