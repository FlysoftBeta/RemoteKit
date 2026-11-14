import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Paper,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AdminSocketMethods } from '../../../shared/admin';
import { RemoteKitError } from '../../../shared/errors';
import type { ErrorSearchMethods } from '../../control/socket-methods';
import { failureError, FailureNote } from '../../failures';
import { recover } from '../../failures/recovery';
import { RetryUnit } from '../../../shared/retry-unit';
import { diagnostics } from '../../media/diagnostics';
export type { ErrorSearchResult } from '../../control/socket-methods';

type AdminMethods = AdminSocketMethods & ErrorSearchMethods;
export type AdminCall = <K extends keyof AdminMethods>(
  method: K,
  params: AdminMethods[K]['params'],
) => Promise<AdminMethods[K]['result']>;

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

export function formatTime(at: number | null, now = Date.now()) {
  if (at === null) return '—';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  const date = new Date(at);
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)} 天前 ${time}`;
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });
}

export function formatDateTime(at: number) {
  return new Date(at).toLocaleString('zh-CN', { hour12: false });
}

export function randomPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

/** Loads one admin resource while its section is visible and refreshes it periodically. */
export function useAdminResource<T>(online: boolean, load: () => Promise<T>, intervalMs = 5000) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState<RemoteKitError | undefined>();
  const loader = useRef(load);
  const retry = useRef(
    new RetryUnit({
      failed: (error) => diagnostics.record('admin_poll_failed', error),
      recovered: () => diagnostics.record('admin_poll_recovered', {}),
    }),
  );
  const input = useRef(0);
  const pending = useRef(false);
  loader.current = load;
  const refresh = useCallback(async (manual = true) => {
    if (pending.current) return;
    if (manual) input.current++;
    if (!retry.current.ready(String(input.current))) return;
    pending.current = true;
    try {
      setData(await loader.current());
      retry.current.succeed();
      setError(undefined);
    } catch (e) {
      retry.current.fail(e);
      setError(failureError(e));
    } finally {
      pending.current = false;
    }
  }, []);
  useEffect(() => {
    if (!online) return;
    let active = true;
    const tick = () => {
      if (active && document.visibilityState === 'visible') void refresh(false);
    };
    void refresh();
    const timer = setInterval(tick, intervalMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [online, refresh, intervalMs]);
  return { data, setData, error, refresh };
}

export function SectionHeader({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Box className="admin-section-header">
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="h6" component="h2">
          {title}
        </Typography>
        {detail && (
          <Typography variant="body2" color="text.secondary">
            {detail}
          </Typography>
        )}
      </Box>
      {action}
    </Box>
  );
}

export function LoadState({ error, loading }: { error: RemoteKitError | undefined; loading: boolean }) {
  if (error) return <FailureNote error={error} context={{ operation: '完成管理操作', scope: 'surface' }} />;
  if (loading) return <LinearProgress sx={{ my: 2 }} />;
  return null;
}

export function Meter({ label, value, detail }: { label: string; value: number; detail: string }) {
  const level = value >= 0.9 ? 'error' : value >= 0.75 ? 'warning' : 'primary';
  return (
    <Box className="admin-meter">
      <Box className="admin-meter-label">
        <Typography variant="body2">{label}</Typography>
        <Typography variant="body2" color="text.secondary">
          {detail}
        </Typography>
      </Box>
      <LinearProgress variant="determinate" color={level} value={Math.min(100, Math.max(0, value * 100))} />
    </Box>
  );
}

export function StatTile({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: 'warning' | 'error';
}) {
  return (
    <Paper variant="outlined" className={`admin-stat${tone ? ` admin-stat-${tone}` : ''}`}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography className="admin-stat-value">{value}</Typography>
      {detail && (
        <Typography variant="caption" color="text.secondary" component="div">
          {detail}
        </Typography>
      )}
    </Paper>
  );
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = '确认',
  danger,
  disabled,
  onConfirm,
  retryIdentity,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  disabled?: boolean;
  onConfirm: () => Promise<void>;
  retryIdentity?: string;
  onClose: () => void;
}) {
  const abort = useRef(new AbortController());
  useEffect(() => () => abort.current.abort(), []);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<RemoteKitError | undefined>();
  useEffect(() => {
    if (open) setError(undefined);
  }, [open]);
  return (
    <Dialog open={open} onClose={() => !busy && onClose()} fullWidth maxWidth="xs">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent
        onChangeCapture={() => setError(undefined)}
        sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}
      >
        {error && <FailureNote error={error} context={{ operation: '完成管理操作', scope: 'surface' }} />}
        {children}
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button
          variant="contained"
          color={danger ? 'error' : 'primary'}
          disabled={busy || disabled || !!error}
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              await recover(onConfirm, abort.current.signal, setError, { identity: retryIdentity });
              onClose();
            } catch (e) {
              setError(failureError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? '请稍候…' : confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
