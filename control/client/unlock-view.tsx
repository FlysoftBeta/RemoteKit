import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  IconButton,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import Close from '@mui/icons-material/Close';
import type { AuthState } from '../shared/security';
import type { AuthCamera, AuthRequest } from './auth-camera';

export function UnlockView({
  auth,
  request,
  camera,
  close,
  retry,
}: {
  auth: AuthState | null;
  request: AuthRequest;
  camera: AuthCamera;
  close: () => void;
  retry: () => void;
}) {
  const [method, setMethod] = useState<'password' | 'pin' | 'face'>('password');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const closePanel = () => {
    if (camera.explicit === 'verify') camera.cancel();
    close();
  };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePanel();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [camera, close]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!auth || busy) return;
    setBusy(true);
    setError('');
    try {
      if (method === 'face') await camera.start('verify');
      else await request('auth.verify', { method, secret });
    } catch (failure) {
      setError(method === 'face' && failure instanceof Error ? failure.message : '验证失败，请重试。');
    } finally {
      setSecret('');
      setBusy(false);
    }
  };
  return (
    <main className="auth-page">
      <Box component="form" className="auth-form" onSubmit={submit}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography component="h1" variant="h5">
            解锁
          </Typography>
          <IconButton aria-label="关闭验证" onClick={closePanel}>
            <Close />
          </IconButton>
        </Stack>
        {!auth ? (
          <>
            <Typography color="text.secondary">正在连接验证服务…</Typography>
            <Button onClick={retry}>重试连接</Button>
          </>
        ) : (
          <>
            <Typography color="text.secondary">{auth.user.username}</Typography>
            {(auth.methods.pin || auth.methods.face) && (
              <ToggleButtonGroup
                exclusive
                size="small"
                value={method}
                aria-label="验证方式"
                onChange={(_, value: typeof method | null) => {
                  if (!value || value === method) return;
                  if (camera.explicit === 'verify') camera.cancel();
                  setMethod(value);
                  setSecret('');
                  setError('');
                }}
              >
                <ToggleButton value="password">密码</ToggleButton>
                {auth.methods.pin && <ToggleButton value="pin">PIN</ToggleButton>}
                {auth.methods.face && <ToggleButton value="face">人脸</ToggleButton>}
              </ToggleButtonGroup>
            )}
            {method !== 'face' ? (
              <TextField
                key={method}
                autoFocus
                required
                type="password"
                value={secret}
                label={method === 'pin' ? 'PIN' : '账户密码'}
                autoComplete={method === 'pin' ? 'off' : 'current-password'}
                slotProps={{
                  htmlInput:
                    method === 'pin' ? { inputMode: 'numeric', pattern: '[0-9]{6,12}', maxLength: 12 } : {},
                }}
                onChange={(event) => setSecret(event.target.value)}
              />
            ) : (
              <Typography role="status" color="text.secondary">
                {!auth.face.available
                  ? '当前服务无法进行人脸验证。'
                  : auth.face.purpose === 'verify' && auth.face.status === 'pending'
                    ? '请正对摄像头。'
                    : auth.face.purpose === 'verify' && auth.face.status === 'expired'
                      ? '验证已超时，请重试。'
                      : auth.face.purpose === 'verify' && auth.face.status === 'failed'
                        ? '人脸验证失败，请重试。'
                        : '开启摄像头后，按提示完成人脸验证。'}
              </Typography>
            )}
            {error && <Alert severity="error">{error}</Alert>}
            <Button
              type="submit"
              variant="contained"
              disabled={busy || (method === 'face' && !auth.face.available)}
            >
              {busy ? '正在验证…' : method === 'face' ? '开启摄像头' : '解锁'}
            </Button>
          </>
        )}
      </Box>
    </main>
  );
}
