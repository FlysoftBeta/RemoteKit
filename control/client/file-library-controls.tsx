import React, { useEffect, useRef, useState } from 'react';
import { Box, Button, Dialog, MenuItem, TextField, Typography } from '@mui/material';
import type { LibraryEntry, LibraryGroup, LibrarySnapshot } from '../shared/file-library';
import { FILE_LIMITS } from '../shared/product';
import { operationId } from './product-operations';
import { useLibrary } from './file-library-state';

export function fileError(error: unknown) {
    return error instanceof Error ? error.message : '文件操作未完成，请重试';
}

export function basketEntries(snapshot?: LibrarySnapshot): LibraryEntry[] {
    if (!snapshot) return [];
    const entries = new Map(snapshot.entries.map(entry => [entry.id, entry]));
    return snapshot.basket.flatMap(id => {
        const entry = entries.get(id);
        return entry ? [entry] : [];
    });
}

export const touchButton = { minWidth: 44, minHeight: 44 };
export function GroupField({ groups, value, onChange, includeAll = false }: {
    groups: LibraryGroup[];
    value: string | null;
    onChange: (value: string | null) => void;
    includeAll?: boolean;
}) {
    return <TextField select size="small" fullWidth label="分组" value={value ?? ''} onChange={event => onChange(event.target.value || null)}>
        {includeAll && <MenuItem value="*">全部文件</MenuItem>}
        <MenuItem value="">未分组</MenuItem>
        {groups.map(group => <MenuItem key={group.id} value={group.id}>{group.name}</MenuItem>)}
    </TextField>;
}

export function GroupConfirm({ groups, title, onClose, onChoose, initial = null, disabled = false }: {
    groups: LibraryGroup[];
    title: string;
    initial?: string | null;
    disabled?: boolean;
    onClose: () => void;
    onChoose: (groupId: string | null) => void;
}) {
    const [group, setGroup] = useState(initial);
    return <Box sx={{ p: 1, display: 'flex', flexDirection: 'column', gap: .75 }}>
        <Typography variant="subtitle2">{title}</Typography>
        <GroupField groups={groups} value={group} onChange={setGroup} />
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={onClose}>返回</Button>
            <Button variant="contained" disabled={disabled} onClick={() => onChoose(group)}>确认</Button>
        </Box>
    </Box>;
}

export function GroupPicker(props: Parameters<typeof GroupConfirm>[0]) {
    return <Dialog open fullWidth maxWidth="xs" onClose={props.onClose}><GroupConfirm {...props} /></Dialog>;
}
export interface ImportJob {
    file: File;
    operationId: string;
    assetId?: string;
}

export function DeviceImport({ destination, accept, disabled, afterId, onDone, onError, inputRef, onBusy, inline = false }: {
    destination: 'library' | 'basket';
    accept?: string[];
    inline?: boolean;
    disabled: boolean;
    afterId?: string;
    onDone?: () => void;
    onError: (message: string) => void;
    inputRef: React.RefObject<HTMLInputElement | null>;
    onBusy?: (busy: boolean) => void;
}) {
    const { rpc, snapshot, mutate, online } = useLibrary();
    const groups = snapshot?.groups ?? [];
    const [picking, setPicking] = useState(false);
    const [remaining, setRemaining] = useState<number>(0);
    const pending = useRef<{ jobs: ImportJob[]; groupId: string | null; afterId?: string } | undefined>(undefined);
    const controller = useRef<AbortController | undefined>(undefined);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            controller.current?.abort();
            onBusy?.(false);
        };
    }, []);
    useEffect(() => { if (!online) controller.current?.abort(); }, [online]);
    const discard = () => { pending.current = undefined; setRemaining(0); setPicking(false); onDone?.(); };

    async function upload() {
        const batch = pending.current;
        if (!batch || controller.current) return;
        const abort = new AbortController();
        controller.current = abort;
        onBusy?.(true);
        onError('');
        try {
            while (batch.jobs.length && !abort.signal.aborted) {
                const job = batch.jobs[0];
                job.assetId ??= (await rpc.uploadAsset(job.file, job.operationId, abort.signal)).assetId;
                if (abort.signal.aborted) break;
                const next = await mutate('library.import', {
                    operationId: job.operationId, assetId: job.assetId, name: job.file.name,
                    groupId: batch.groupId, destination, afterId: batch.afterId,
                });
                // The next insertion follows the entry that this import created.
                if (destination === 'basket' && batch.afterId) {
                    const index = next.basket.indexOf(batch.afterId);
                    if (index >= 0) batch.afterId = next.basket[index + 1] ?? batch.afterId;
                }
                batch.jobs.shift();
                if (mounted.current) setRemaining(batch.jobs.length);
            }
            if (mounted.current && !batch.jobs.length) discard();
        } catch (error) {
            if (!abort.signal.aborted) onError(fileError(error));
        } finally {
            controller.current = undefined;
            if (mounted.current) onBusy?.(false);
        }
    }
    const ChooseGroup = inline ? GroupConfirm : GroupPicker;
    return <>
        <input ref={inputRef} hidden type="file" multiple accept={accept?.join(',') || undefined} onChange={event => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (!files.length || pending.current) return;
            const maxFiles = destination === 'basket' ? 64 - (snapshot?.basket.length ?? 0) : 64;
            if (files.length > maxFiles || files.some(file => file.size > FILE_LIMITS.maxFileBytes)) {
                onError('选择的文件数量或大小超出限制');
                return;
            }
            pending.current = { jobs: files.map(file => ({ file, operationId: operationId() })), groupId: null, afterId };
            setRemaining(files.length);
            if (groups.length) setPicking(true);
            else void upload();
        }} />
        {picking && <ChooseGroup title="选择上传分组" disabled={disabled} groups={groups} onClose={discard} onChoose={groupId => {
            setPicking(false);
            if (pending.current) pending.current.groupId = groupId;
            void upload();
        }} />}
        {!!remaining && !picking && !disabled && <Box sx={{ display: 'flex', gap: 1 }}>
            <Button onClick={() => void upload()}>继续上传（{remaining}）</Button><Button onClick={discard}>放弃剩余上传</Button>
        </Box>}
    </>;
}
