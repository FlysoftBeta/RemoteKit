import React, { useState } from 'react';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, ListSubheader, Menu, MenuItem, Typography } from '@mui/material';
import type { LibraryEntry } from '../shared/file-library';
import { FileCard } from './file-card';
import { fileSize } from './basket-rows';
import { canPreviewFile, FileImagePreview } from './file-image-preview';

export const fileGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(128px, 1fr))', gap: 1.25 };

export function ArchivePicker({ entries, onAdd, onClose }: { entries: LibraryEntry[]; onAdd: (id: string) => void; onClose: () => void }) {
    const [menu, setMenu] = useState<{ anchor: HTMLElement; entry: LibraryEntry }>();
    const [preview, setPreview] = useState<LibraryEntry>();
    const [limit, setLimit] = useState(48);
    return <Dialog open fullWidth maxWidth="sm" onClose={onClose}>
        <DialogTitle>从我的文件加入</DialogTitle>
        <DialogContent>
            {!entries.length && <Typography color="text.secondary">没有可加入的文件</Typography>}
            <Box sx={fileGrid}>
                {entries.slice(0, limit).map(entry => <Box key={entry.id} sx={{ minWidth: 0, maxWidth: 180 }}>
                    <FileCard id={entry.id} title={entry.name} assetId={entry.assetId} type={entry.type} detail={fileSize(entry.size)}
                        open={menu?.entry.id === entry.id} onOpen={anchor => setMenu({ anchor, entry })} />
                </Box>)}
            </Box>
            {entries.length > limit && <Button onClick={() => setLimit(n => n + 48)}>显示更多</Button>}
        </DialogContent>
        <DialogActions><Button onClick={onClose}>取消</Button></DialogActions>
        <Menu anchorEl={menu?.anchor} open={!!menu} onClose={() => setMenu(undefined)}>
            <ListSubheader disableSticky sx={{ py: .5, maxWidth: 300, overflowWrap: 'anywhere', lineHeight: 1.4 }}>
                <Typography variant="subtitle2">{menu?.entry.name}</Typography>
            </ListSubheader>
            {menu && canPreviewFile(menu.entry) && <MenuItem onClick={() => { setPreview(menu.entry); setMenu(undefined); }}>查看大图</MenuItem>}
            <MenuItem onClick={() => { if (menu) onAdd(menu.entry.id); }}>加入文件篮</MenuItem>
        </Menu>
        {preview && <FileImagePreview entry={preview} onClose={() => setPreview(undefined)} />}
    </Dialog>;
}
