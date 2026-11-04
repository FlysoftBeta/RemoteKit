import React, { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress } from '@mui/material';
import type { LibraryEntry } from '../shared/file-library';
import { useLibrary } from './file-library-state';
import { fileError } from './file-library-controls';

export function canPreviewFile(entry: Pick<LibraryEntry, 'type' | 'size'>) {
    return /^(image\/jpeg|image\/png)$/i.test(entry.type) && entry.size > 0 && entry.size <= 20 * 1024 * 1024;
}

export function FileImagePreview({ entry, onClose }: { entry: LibraryEntry; onClose: () => void }) {
    const { online, rpc } = useLibrary();
    const [url, setUrl] = useState<string>();
    const [error, setError] = useState('');
    const close = useRef(onClose);
    close.current = onClose;
    useEffect(() => {
        if (!online) { close.current(); return; }
        const abort = new AbortController();
        let objectUrl: string | undefined;
        void rpc.readPhoto({ assetId: entry.assetId, type: entry.type, size: entry.size, hash: '' }, abort.signal).then(blob => {
            if (abort.signal.aborted) return;
            objectUrl = URL.createObjectURL(blob);
            setUrl(objectUrl);
        }, failure => { if (!abort.signal.aborted) setError(fileError(failure)); });
        return () => { abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
    }, [entry, online, rpc]);
    return <Dialog open fullWidth maxWidth="md" onClose={onClose}>
        <DialogTitle sx={{ overflowWrap: 'anywhere' }}>{entry.name}</DialogTitle>
        <DialogContent>
            {error ? <Alert severity="warning">{error}</Alert> : url
                ? <Box component="img" src={url} alt={entry.name} onError={() => setError('预览不可用')}
                    sx={{ width: '100%', display: 'block', maxHeight: '70vh', objectFit: 'contain' }} />
                : <LinearProgress aria-label="正在加载大图" />}
        </DialogContent>
        <DialogActions><Button onClick={onClose}>返回</Button></DialogActions>
    </Dialog>;
}
