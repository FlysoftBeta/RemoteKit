import { useAutoFocus } from '../../editing/local-autofocus';
import Add from '@mui/icons-material/Add';
import { Box, Button, Checkbox, FormControlLabel, Paper, TextField, Typography } from '@mui/material';
import { useState } from 'react';
import type { AdminAnnouncement } from '../../../shared/admin';
import { ANNOUNCEMENT_LIMITS } from '../../../shared/product';
import {
  ConfirmDialog,
  LoadState,
  SectionHeader,
  formatDateTime,
  useAdminResource,
  type AdminCall,
} from './shared';

type Editing =
  { kind: 'new' } | { kind: 'edit'; item: AdminAnnouncement } | { kind: 'delete'; item: AdminAnnouncement };

export function AdminAnnouncementsSection({ online, call }: { online: boolean; call: AdminCall }) {
  const { data, setData, error } = useAdminResource(online, () => call('admin.announcements', {}), 15000);
  const [editing, setEditing] = useState<Editing>();
  return (
    <Box className="admin-section">
      <SectionHeader
        title="公告"
        detail="发布后所有用户会在下次打开时看到；用户关闭公告即视为已读"
        action={
          <Button
            variant="contained"
            startIcon={<Add />}
            disabled={!online}
            onClick={() => setEditing({ kind: 'new' })}
          >
            发布公告
          </Button>
        }
      />
      <LoadState error={error} loading={!data} />
      {data && !data.length && <Typography color="text.secondary">尚未发布公告</Typography>}
      {data?.map((item) => (
        <Paper key={item.id} variant="outlined" className="admin-panel admin-announcement">
          <Box className="admin-panel-heading">
            <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600, minWidth: 0 }}>
              {item.title}
            </Typography>
            <Box sx={{ display: 'flex', gap: 1, flex: 'none' }}>
              <Button size="small" disabled={!online} onClick={() => setEditing({ kind: 'edit', item })}>
                编辑
              </Button>
              <Button
                size="small"
                color="error"
                disabled={!online}
                onClick={() => setEditing({ kind: 'delete', item })}
              >
                删除
              </Button>
            </Box>
          </Box>
          <Typography variant="caption" color="text.secondary" component="p">
            {formatDateTime(item.publishedAt)} 发布
            {item.updatedAt !== item.publishedAt && ` · ${formatDateTime(item.updatedAt)} 修改`} ·{' '}
            {item.reads}/{item.recipients} 人已读
          </Typography>
          <Typography variant="body2" className="admin-announcement-body">
            {item.body}
          </Typography>
        </Paper>
      ))}
      {(editing?.kind === 'new' || editing?.kind === 'edit') && (
        <AnnouncementEditor
          key={editing.kind === 'edit' ? editing.item.id : 'new'}
          item={editing.kind === 'edit' ? editing.item : undefined}
          onClose={() => setEditing(undefined)}
          onSave={async (draft) =>
            setData(
              editing.kind === 'edit'
                ? await call('admin.updateAnnouncement', draft)
                : await call('admin.publishAnnouncement', {
                    id: draft.id,
                    title: draft.title,
                    body: draft.body,
                  }),
            )
          }
        />
      )}
      <ConfirmDialog
        open={editing?.kind === 'delete'}
        title="删除公告"
        confirmLabel="删除"
        danger
        onClose={() => setEditing(undefined)}
        onConfirm={async () => {
          if (editing?.kind === 'delete')
            setData(await call('admin.deleteAnnouncement', { id: editing.item.id }));
        }}
      >
        <Typography variant="body2">
          删除“{editing?.kind === 'delete' ? editing.item.title : ''}”后，用户将不再看到这条公告。
        </Typography>
      </ConfirmDialog>
    </Box>
  );
}

function AnnouncementEditor({
  item,
  onClose,
  onSave,
}: {
  item?: AdminAnnouncement;
  onClose(): void;
  onSave(draft: { id: string; title: string; body: string; republish: boolean }): Promise<void>;
}) {
  const autoFocusRef = useAutoFocus<HTMLInputElement>();
  const [id] = useState(() => item?.id ?? crypto.randomUUID());
  const [title, setTitle] = useState(item?.title ?? ''),
    [body, setBody] = useState(item?.body ?? ''),
    [republish, setRepublish] = useState(false);
  return (
    <ConfirmDialog
      open
      title={item ? '编辑公告' : '发布公告'}
      confirmLabel={item ? '保存' : '发布'}
      disabled={!title.trim() || !body.trim()}
      onClose={onClose}
      retryIdentity={item ? undefined : id}
      onConfirm={() => onSave({ id, title, body, republish })}
    >
      <TextField
        label="标题"
        value={title}
        inputRef={autoFocusRef}
        fullWidth
        slotProps={{ htmlInput: { maxLength: ANNOUNCEMENT_LIMITS.title } }}
        onChange={(event) => setTitle(event.target.value)}
      />
      <TextField
        label="内容"
        value={body}
        multiline
        minRows={4}
        maxRows={12}
        fullWidth
        slotProps={{ htmlInput: { maxLength: ANNOUNCEMENT_LIMITS.body } }}
        helperText={`${body.length}/${ANNOUNCEMENT_LIMITS.body}`}
        onChange={(event) => setBody(event.target.value)}
      />
      {item && (
        <FormControlLabel
          control={<Checkbox checked={republish} onChange={(event) => setRepublish(event.target.checked)} />}
          label="重新提醒已读的用户"
        />
      )}
    </ConfirmDialog>
  );
}
