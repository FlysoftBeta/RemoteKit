import { Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { RemoteKitError } from '../../shared/errors';
import type { Announcement } from '../../shared/product';
import { FailureNote, failureError } from '../failures';
import { recover } from '../failures/recovery';
import './announcements.css';

export function formatAnnouncementTime(at: number) {
  return new Date(at).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Shows unread announcements one at a time, oldest first; dismissing marks it read on Control. */
export function AnnouncementDialog({
  announcements,
  read,
}: {
  announcements: Announcement[];
  read(id: string): Promise<unknown>;
}) {
  const [failure, setFailure] = useState<RemoteKitError>();
  const abort = useRef(new AbortController());
  useEffect(() => () => abort.current.abort(), []);
  const [dismissing, setDismissing] = useState<string>();
  const unread = announcements.filter((item) => !item.read && item.id !== dismissing);
  const current = unread[unread.length - 1];
  if (!current) return null;
  const dismiss = () => {
    setDismissing(current.id);
    void recover(() => read(current.id), abort.current.signal, setFailure)
      .catch((error) => setFailure(failureError(error)))
      .finally(() => setDismissing(undefined));
  };
  return (
    <Dialog open onClose={dismiss} fullWidth maxWidth="sm" aria-describedby="announcement-body">
      <DialogTitle sx={{ pb: 0.5 }}>{current.title}</DialogTitle>
      <DialogContent>
        <FailureNote error={failure} context={{ operation: '保存公告已读状态', scope: 'surface' }} />
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1.5 }}>
          公告 · {formatAnnouncementTime(current.publishedAt)}
        </Typography>
        <Typography id="announcement-body" className="announcement-body" variant="body2">
          {current.body}
        </Typography>
      </DialogContent>
      <DialogActions>
        {unread.length > 1 && (
          <Typography variant="caption" color="text.secondary" sx={{ mr: 'auto', pl: 2 }}>
            还有 {unread.length - 1} 条
          </Typography>
        )}
        <Button variant="contained" autoFocus onClick={dismiss}>
          {unread.length > 1 ? '下一条' : '知道了'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function AnnouncementList({ announcements }: { announcements: Announcement[] }) {
  if (!announcements.length) return <Typography color="text.secondary">暂无公告</Typography>;
  return (
    <div className="announcement-list">
      {announcements.map((item) => (
        <article key={item.id} className="announcement-item">
          <div className="announcement-item-heading">
            <Typography variant="subtitle2" component="h3" sx={{ fontWeight: 600 }}>
              {item.title}
            </Typography>
            {!item.read && <Chip size="small" color="primary" label="未读" />}
          </div>
          <Typography variant="caption" color="text.secondary" component="p">
            {formatAnnouncementTime(item.publishedAt)}
          </Typography>
          <Typography className="announcement-body" variant="body2">
            {item.body}
          </Typography>
        </article>
      ))}
    </div>
  );
}
