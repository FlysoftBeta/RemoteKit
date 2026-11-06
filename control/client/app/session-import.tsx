import Close from '@mui/icons-material/Close';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Stack,
  TextField,
  Typography,
  useMediaQuery,
} from '@mui/material';
import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionImportState, SessionImportSocketMethods } from '../../shared/session-import';
import type { Action } from './product-dialogs';
import { formatError } from '../util/format-error';

export type SessionImportCall = <K extends keyof SessionImportSocketMethods>(
  method: K,
  params: SessionImportSocketMethods[K]['params'],
) => Promise<SessionImportSocketMethods[K]['result']>;
type Call = SessionImportCall;
const time = (value: number | null) => (value === null ? '暂无' : new Date(value).toLocaleString('zh-CN'));
const states = { pending: '等待会话活跃', applied: '已导入', rejected: '已拒绝', failed: '导入失败' };
function PairingQr({ code }: { code: string }) {
  const qr = useMemo(() => {
    const value = qrcode(0, 'M');
    value.addData(code);
    value.make();
    return value;
  }, [code]);
  const modules = qr.getModuleCount();
  const cells: string[] = [];
  for (let row = 0; row < modules; row++)
    for (let col = 0; col < modules; col++)
      if (qr.isDark(row, col)) cells.push(`M${col + 4} ${row + 4}h1v1h-1z`);
  return (
    <svg
      role="img"
      aria-label="会话导入配对二维码"
      viewBox={`0 0 ${modules + 8} ${modules + 8}`}
      style={{ display: 'block', width: '100%', maxWidth: 420, margin: '0 auto' }}
      shapeRendering="crispEdges"
    >
      <rect width="100%" height="100%" fill="white" />
      <path d={cells.join('')} fill="black" />
    </svg>
  );
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
          在手机上登录后，将登录状态导入此浏览器。
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
  const [confirm, setConfirm] = useState(false);
  const [pairing, setPairing] = useState<{ code: string; createdAt: number }>();
  const [copied, setCopied] = useState(false);
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
        <Stack spacing={2}>
          {error && <Alert severity="error">{error}</Alert>}
          <Box>
            <Typography fontWeight={600}>
              {state ? (state.mailbox.configured ? '邮箱已配置' : '邮箱未配置') : '正在读取…'}
            </Typography>
            {state?.mailbox.configured && (
              <>
                <Typography variant="body2">最近拉取：{time(state.mailbox.lastSuccessAt)}</Typography>
                <Typography variant="body2" color={state.mailbox.lastError ? 'error' : 'text.secondary'}>
                  最近错误：
                  {state.mailbox.lastError
                    ? `${time(state.mailbox.lastErrorAt)} · ${state.mailbox.lastError}`
                    : '暂无'}
                </Typography>
              </>
            )}
            <Typography sx={{ mt: 1 }}>
              {state?.pairing ? `已配对 · ${time(state.pairing.createdAt)}` : '未配对'}
            </Typography>
            <Button disabled={!online || busy || !state?.mailbox.configured} onClick={() => setConfirm(true)}>
              生成配对码
            </Button>
            <Button
              disabled={!online || busy || !state?.pairing}
              onClick={() =>
                void run(async () => {
                  await call('sessionImport.unpair', {});
                  setPairing(undefined);
                })
              }
            >
              解除配对
            </Button>
          </Box>
          {pairing && (
            <Stack spacing={1}>
              <Alert severity="info">配对码仅显示这一次，关闭后无法再次查看。</Alert>
              <PairingQr code={pairing.code} />
              <TextField
                label="配对码"
                multiline
                maxRows={5}
                fullWidth
                value={pairing.code}
                slotProps={{ input: { readOnly: true } }}
              />
              <Button
                onClick={() =>
                  void run(async () => {
                    await navigator.clipboard.writeText(pairing.code);
                    setCopied(true);
                  })
                }
              >
                {copied ? '已复制' : '复制配对码'}
              </Button>
            </Stack>
          )}
          <Divider />
          <Typography fontWeight={600}>导入记录</Typography>
          {state?.imports.length === 0 && <Typography color="text.secondary">暂无导入记录</Typography>}
          {state?.imports.map((record) => (
            <Box key={record.id} sx={{ borderBottom: 1, borderColor: 'divider', pb: 1 }}>
              <Typography fontWeight={600} sx={{ overflowWrap: 'anywhere' }}>
                {record.siteName || record.siteUrl}
              </Typography>
              <Typography variant="body2">设备：{record.device || '未命名'}</Typography>
              <Typography variant="body2">
                生成：{time(record.createdAt)}
                <br />
                接收：{time(record.receivedAt)}
              </Typography>
              <Typography variant="body2">
                {states[record.state]} · Cookie {record.cookies} 条 · 来源 {record.origins} 个 · 拒绝{' '}
                {record.rejectedItems} 项
              </Typography>
              {record.error && (
                <Typography variant="body2" color="error">
                  {record.error}
                </Typography>
              )}
              {record.state === 'applied' && (
                <Button
                  disabled={!online || busy || !windowId}
                  onClick={() =>
                    void run(async () => {
                      await action({ type: 'tab.create', windowId: windowId!, url: record.siteUrl });
                      opened();
                    })
                  }
                >
                  打开
                </Button>
              )}
              <Button
                disabled={!online || busy}
                color="error"
                onClick={() =>
                  void run(async () => {
                    await call('sessionImport.delete', { id: record.id });
                  })
                }
              >
                删除
              </Button>
            </Box>
          ))}
        </Stack>
      </DialogContent>
      <Dialog open={confirm} onClose={busy ? undefined : () => setConfirm(false)} fullWidth maxWidth="xs">
        <DialogTitle>生成配对码？</DialogTitle>
        <DialogContent>旧配对码立即失效。请用手机重新扫码或粘贴新配对码。</DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setConfirm(false)}>
            取消
          </Button>
          <Button
            disabled={!online || busy}
            onClick={() =>
              void run(async () => {
                const value = await call('sessionImport.pair', {});
                if (mounted.current) {
                  setPairing(value);
                  setCopied(false);
                  setConfirm(false);
                }
              })
            }
          >
            生成
          </Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  );
}
