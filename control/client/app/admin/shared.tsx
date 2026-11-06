import {
  Alert,
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
import { formatError } from '../../util/format-error';

export type AdminCall = <K extends keyof AdminSocketMethods>(
  method: K,
  params: AdminSocketMethods[K]['params'],
) => Promise<AdminSocketMethods[K]['result']>;

// Administrative refusals carry messages written for the administrator.
export function adminError(error: unknown) {
  return error instanceof RemoteKitError &&
    ['invalid_request', 'forbidden', 'not_found', 'conflict'].includes(error.code)
    ? error.message
    : formatError(error);
}

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
    [error, setError] = useState('');
  const loader = useRef(load);
  loader.current = load;
  const refresh = useCallback(async () => {
    try {
      setData(await loader.current());
      setError('');
    } catch (e) {
      setError(adminError(e));
    }
  }, []);
  useEffect(() => {
    if (!online) return;
    let active = true;
    const tick = () => {
      if (active && document.visibilityState === 'visible') void refresh();
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

export function LoadState({ error, loading }: { error: string; loading: boolean }) {
  if (error) return <Alert severity="error">{error}</Alert>;
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
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  disabled?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (open) setError('');
  }, [open]);
  return (
    <Dialog open={open} onClose={() => !busy && onClose()} fullWidth maxWidth="xs">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {error && <Alert severity="error">{error}</Alert>}
        {children}
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button
          variant="contained"
          color={danger ? 'error' : 'primary'}
          disabled={busy || disabled}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await onConfirm();
              onClose();
            } catch (e) {
              setError(adminError(e));
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
