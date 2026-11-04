import React, { useState } from 'react';
import { Box, Button, Divider, ListSubheader, Menu, MenuItem, Radio, Typography } from '@mui/material';
import type { LibraryEntry } from '../shared/file-library';
import { FileCard } from './file-card';
import { canPreviewFile, FileImagePreview } from './file-image-preview';
import { FileThumbnail } from './file-thumbnail';
import { FileViewButton, useFileView } from './file-view';
import { SortableFileItems } from './sortable-file-items';

export const fileSize = (size: number) => `${(size / 1024).toFixed(1)} KB`;
export const compactPreview = { width: 32, height: 32, borderRadius: 1, flexShrink: 0, '& svg': { fontSize: 20 }, '& .MuiTypography-root': { display: 'none' } };

export function BasketRows({ entries, revision, chosen, onChoose, onChange, onInsert, disabled, onDragging, add }: {
    entries: LibraryEntry[];
    revision: number;
    chosen?: string | null;
    onChoose?: (id: string) => void;
    onChange: (ids: string[], revision: number) => Promise<void>;
    onInsert: (afterId: string, anchor: HTMLElement) => void;
    disabled: boolean;
    onDragging: (value: boolean) => void;
    add?: React.ReactNode;
}) {
    const [menu, setMenu] = useState<{ anchor: HTMLElement; id: string; revision: number }>();
    const [preview, setPreview] = useState<LibraryEntry>();
    const [dragging, setDragging] = useState(false);
    const { mode, toggle } = useFileView(entries);
    const menuEntry = menu?.revision === revision ? entries.find(entry => entry.id === menu.id) : undefined;
    const remove = (id: string) => void onChange(entries.filter(entry => entry.id !== id).map(entry => entry.id), revision);
    const canInsert = entries.length < 64;
    const startDrag = React.useCallback((value: boolean) => {
        setDragging(value);
        if (value) setMenu(undefined);
        onDragging(value);
    }, [onDragging]);
    const locked = disabled || dragging;

    return <>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: .5, minHeight: 44 }}>
            <Typography variant="subtitle2" sx={{ flex: 1, whiteSpace: 'nowrap' }}>文件篮 · {entries.length}</Typography>
            {add}
            {!!entries.length && <FileViewButton mode={mode} toggle={() => { setMenu(undefined); toggle(); }} disabled={locked} />}
        </Box>
        {entries.length ? <SortableFileItems mode={mode} items={entries} revision={revision} disabled={disabled} label="文件篮"
            onChange={onChange} onDragging={startDrag} renderItem={(entry, flags) => {
                const selection = onChoose && !flags.overlay && <Radio checked={chosen === entry.id} name="chooser-file" onChange={() => onChoose(entry.id)}
                    disabled={locked} slotProps={{ input: { 'aria-label': entry.name } }}
                    sx={{ width: 44, height: 44, color: 'text.secondary', bgcolor: 'rgba(255,255,255,.82)' }} size="small" />;
                if (mode === 'cards') return <FileCard id={entry.id} title={entry.name} type={entry.type} assetId={entry.assetId}
                    detail={fileSize(entry.size)} index={flags.index + 1} selected={chosen === entry.id} open={menuEntry?.id === entry.id}
                    selection={selection} activator={flags.activator} disabled={disabled || flags.dragging && !flags.activator}
                    onOpen={anchor => setMenu({ anchor, id: entry.id, revision })} />;
                return <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: .5, minHeight: 56, py: .25,
                    borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'background.paper' }}>
                    {flags.handle}
                    {selection}
                    <FileThumbnail assetId={entry.assetId} type={entry.type} sx={compactPreview} />
                    <Box sx={{ flex: '1 1 96px', minWidth: 0 }}><Typography variant="body2" noWrap title={entry.name}>{entry.name}</Typography>
                        <Typography variant="caption" color="text.secondary">{fileSize(entry.size)}</Typography></Box>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', ml: 'auto', justifyContent: 'flex-end' }}>
                        {canPreviewFile(entry) && <Button size="small" disabled={locked} onClick={() => setPreview(entry)}>查看</Button>}
                        <Button size="small" disabled={locked || !canInsert} onClick={event => onInsert(entry.id, event.currentTarget)}>插入</Button>
                        <Button size="small" disabled={locked} onClick={() => remove(entry.id)}>移除</Button>
                    </Box>
                </Box>;
            }} />
            : <Typography variant="body2" color="text.secondary" sx={{ p: 2, bgcolor: 'action.hover', borderRadius: 2 }}>还没有文件</Typography>}
        {entries.length > 1 && <Typography variant="caption" color="text.secondary">{mode === 'cards' ? '拖动卡片排序，触屏长按后拖动' : '拖动左侧手柄排序'}</Typography>}
        <Menu anchorEl={menu?.anchor} open={!!menuEntry && !locked} onClose={() => setMenu(undefined)}>
            <ListSubheader disableSticky sx={{ py: .5, maxWidth: 300, overflowWrap: 'anywhere', lineHeight: 1.4 }}>
                <Typography variant="subtitle2">{menuEntry?.name}</Typography>
                <Typography variant="caption">{menuEntry && fileSize(menuEntry.size)}</Typography>
            </ListSubheader>
            <Divider />
            {menuEntry && canPreviewFile(menuEntry) && <MenuItem onClick={() => { setPreview(menuEntry); setMenu(undefined); }}>查看大图</MenuItem>}
            <MenuItem disabled={!canInsert} onClick={() => {
                if (menuEntry && menu) onInsert(menuEntry.id, menu.anchor);
                setMenu(undefined);
            }}>在后面插入…</MenuItem>
            <MenuItem onClick={() => { if (menuEntry) remove(menuEntry.id); setMenu(undefined); }}>从文件篮移除</MenuItem>
        </Menu>
        {preview && <FileImagePreview entry={preview} onClose={() => setPreview(undefined)} />}
    </>;
}
