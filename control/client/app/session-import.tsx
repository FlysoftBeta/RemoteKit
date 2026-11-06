import Close from '@mui/icons-material/Close';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import MoveToInbox from '@mui/icons-material/MoveToInbox';
import OpenInNew from '@mui/icons-material/OpenInNew';
import {
  Alert,
  Avatar,
  Button,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  LinearProgress,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import type {
  ImportRecord,
  SessionImportState,
  SessionImportSocketMethods,
} from '../../shared/session-import';
import type { Action } from './product-dialogs';
import { formatError } from '../util/format-error';
import { formatTime } from './admin/shared';

export type SessionImportCall = <K extends keyof SessionImportSocketMethods>(
  method: K,
  params: SessionImportSocketMethods[K]['params'],
) => Promise<SessionImportSocketMethods[K]['result']>;
type Call = SessionImportCall;
const states = { pending: '等待会话', applied: '已导入', rejected: '已拒绝', failed: '导入失败' };
const stateColor = { pending: 'default', applied: 'success', rejected: 'error', failed: 'error' } as const;

function host(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function siteTitle(record: ImportRecord) {
  return record.sites.map((site) => site.name || host(site.url)).join('、');
}

export function SessionImportSettings({
  online,
  call,
  action,
  windowId,
  opened,
}: {
  online: boolean;
  call: Call;
  action: Action;
  windowId: string | null;
  opened: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="setting-section">
        <Typography fontWeight={600}>会话导入</Typography>
        <Typography variant="body2" color="text.secondary">
          提前在手机上登录需要二次验证的网站，再把登录状态发到这里。
        </Typography>
        <Button disabled={!online} onClick={() => setOpen(true)}>
          管理会话导入
        </Button>
      </div>
      <Divider />
      {open && (
        <ImportDialog
          online={online}
          call={call}
          action={action}
          windowId={windowId}
          close={() => setOpen(false)}
          opened={() => {
            setOpen(false);
            opened();
          }}
        />
      )}
    </>
  );
}

function ImportDialog({
  online,
  call,
  action,
  windowId,
  close,
  opened,
}: {
  online: boolean;
  call: Call;
  action: Action;
  windowId: string | null;
  close: () => void;
  opened: () => void;
}) {
  const compact = useMediaQuery('(max-width:600px)');
  const [state, setState] = useState<SessionImportState>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const refreshing = useRef(false);
  const refresh = async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const value = await call('sessionImport.state', {});
      if (mounted.current) setState(value);
    } catch (e) {
      if (mounted.current) setError(formatError(e));
    } finally {
      refreshing.current = false;
    }
  };
  useEffect(() => {
    mounted.current = true;
    if (online) void refresh();
    const timer = online
      ? setInterval(() => {
          void refresh();
        }, 5000)
      : undefined;
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [call, online]);
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
      if (mounted.current) await refresh();
    } catch (e) {
      if (mounted.current) setError(formatError(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const openSite = (url: string) =>
    run(async () => {
      await action({ type: 'tab.create', windowId: windowId!, url });
      opened();
    });
  const deleteRecord = (record: ImportRecord) =>
    run(async () => {
      await call('sessionImport.delete', { id: record.id });
    });
  return (
    <Dialog
      open
      onClose={busy ? undefined : close}
      fullScreen={compact}
      fullWidth
      maxWidth="sm"
      PaperProps={{ className: 'settings-paper' }}
    >
      <DialogTitle className="dialog-heading">
        会话导入
        <IconButton aria-label="关闭会话导入" disabled={busy} onClick={close}>
          <Close />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        {!state ? (
          <LinearProgress sx={{ my: 1 }} />
        ) : (
          !state.receiving && (
            <Alert severity="info" sx={{ mb: 1 }}>
              管理员尚未开启会话导入，暂时无法接收手机发来的登录状态。
            </Alert>
          )
        )}
        {state?.imports.length === 0 && (
          <div className="import-empty">
            <MoveToInbox color="disabled" sx={{ fontSize: 40 }} />
            <Typography variant="body2" color="text.secondary">
              在手机 App 里登录网站并发送后，记录会出现在这里。
            </Typography>
          </div>
        )}
        {state?.imports.map((record) => (
          <div className="import-record" key={record.id}>
            <Avatar
              sx={{ width: 36, height: 36, fontSize: 16, bgcolor: 'action.selected', color: 'text.primary' }}
            >
              {siteTitle(record).slice(0, 1).toUpperCase()}
            </Avatar>
            <div className="import-record-text">
              <div className="import-record-title">
                <Typography fontWeight={600} noWrap>
                  {siteTitle(record)}
                </Typography>
                <Chip
                  size="small"
                  variant="outlined"
                  color={stateColor[record.state]}
                  label={states[record.state]}
                />
              </div>
              <Typography variant="body2" color="text.secondary">
                {record.device || '未命名设备'} · {formatTime(record.receivedAt)}收到
              </Typography>
              {record.state === 'applied' && (
                <Typography variant="body2" color="text.secondary">
                  {record.cookies} 个 Cookie · {record.origins} 个站点存储
                  {record.rejectedItems > 0 && ` · ${record.rejectedItems} 项未写入`}
                </Typography>
              )}
              {record.state === 'applied' && (
                <div className="import-record-sites">
                  {record.sites.map((site) => (
                    <Tooltip key={site.url} title={`在新标签页打开 ${host(site.url)}`}>
                      <span>
                        <Chip
                          size="small"
                          icon={<OpenInNew />}
                          label={site.name || host(site.url)}
                          disabled={!online || busy || !windowId}
                          onClick={() => void openSite(site.url)}
                        />
                      </span>
                    </Tooltip>
                  ))}
                </div>
              )}
              {record.error && (
                <Typography variant="body2" color="error">
                  {record.error}
                </Typography>
              )}
            </div>
            <div className="import-record-actions">
              <Tooltip title={record.state === 'pending' ? '放弃导入' : '删除记录'}>
                <span>
                  <IconButton
                    aria-label={record.state === 'pending' ? '放弃导入' : '删除记录'}
                    disabled={!online || busy}
                    onClick={() => void deleteRecord(record)}
                  >
                    <DeleteOutline fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </div>
          </div>
        ))}
      </DialogContent>
    </Dialog>
  );
}
