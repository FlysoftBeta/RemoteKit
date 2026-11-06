import { AdminNodes } from './admin-nodes';
import Close from '@mui/icons-material/Close';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { formatError } from '../util/format-error';

import type { AdminNode, AdminStatus } from '../../shared/product';

export function AdminDialog({
  open,
  online,
  onClose,
  load,
  save,
  loadNodes,
  changeNode,
}: {
  open: boolean;
  online: boolean;
  onClose: () => void;
  load: () => Promise<AdminStatus>;
  save: (serverCredential: string) => Promise<AdminStatus>;
  loadNodes: () => Promise<AdminNode[]>;
  changeNode: (nodeId: string, action: 'remove' | 'readd') => Promise<AdminNode[]>;
}) {
  const [configuration, setConfiguration] = useState<AdminStatus | null>(null),
    [credential, setCredential] = useState(''),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false),
    [retry, setRetry] = useState(0);
  const submitting = useRef(false);
  useEffect(() => {
    setCredential('');
    setError('');
    setSaved(false);
    setConfiguration(null);
    if (!open || !online) return;
    let active = true;
    setLoading(true);
    void load()
      .then((result) => {
        if (active) setConfiguration(result);
      })
      .catch((e) => {
        if (active) setError(formatError(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, online, load, retry]);
  const close = () => {
    if (!submitting.current) onClose();
  };
  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="sm" disableScrollLock>
      <Box
        component="form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting.current || !online || !configuration) return;
          if (credential.length < 8 || credential.length > 256) {
            setError('注册口令须为 8–256 个字符');
            return;
          }
          submitting.current = true;
          setBusy(true);
          setError('');
          setSaved(false);
          try {
            setConfiguration(await save(credential));
            setCredential('');
            setSaved(true);
          } catch (e) {
            setError(formatError(e));
          } finally {
            submitting.current = false;
            setBusy(false);
          }
        }}
      >
        <DialogTitle className="dialog-heading">
          管理员面板
          <IconButton aria-label="关闭管理员面板" onClick={close} disabled={busy}>
            <Close />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Typography color="text.secondary">
              设置注册口令后，新用户需要提供此口令才能创建账户。已有账户登录不受影响。
            </Typography>
            {!online && <Alert severity="warning">连接恢复后可配置注册口令。</Alert>}
            {error && (
              <Alert
                severity="error"
                action={
                  !configuration && online && !loading ? (
                    <Button color="inherit" onClick={() => setRetry((value) => value + 1)}>
                      重试
                    </Button>
                  ) : undefined
                }
              >
                {error}
              </Alert>
            )}
            {saved && <Alert severity="success">注册口令已保存。</Alert>}
            <Typography role="status">
              当前状态：
              {!online
                ? '未连接'
                : loading
                  ? '正在读取…'
                  : configuration
                    ? configuration.registrationCredentialConfigured
                      ? '已设置'
                      : '未设置，后续注册暂未开放'
                    : '读取失败'}
            </Typography>
            <TextField
              fullWidth
              required
              type="password"
              label="注册口令（Server credential）"
              value={credential}
              autoComplete="off"
              disabled={!online || loading || !configuration || busy}
              inputProps={{ minLength: 8, maxLength: 256 }}
              helperText={
                configuration?.registrationCredentialConfigured
                  ? '输入 8–256 个字符以替换现有口令，旧口令不会显示。'
                  : '请输入 8–256 个字符，并将口令提供给需要注册的用户。'
              }
              onChange={(event) => {
                setCredential(event.target.value);
                setSaved(false);
              }}
            />
            {open && <AdminNodes online={online} load={loadNodes} change={changeNode} />}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button color="inherit" disabled={busy} onClick={close}>
            关闭
          </Button>
          <Button
            variant="contained"
            type="submit"
            disabled={
              !online || loading || !configuration || busy || credential.length < 8 || credential.length > 256
            }
          >
            {busy ? '正在保存…' : '保存注册口令'}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
