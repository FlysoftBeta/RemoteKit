import Close from '@mui/icons-material/Close';
import {
  Box,
  Button,
  IconButton,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import React, { useEffect, useRef, useState } from 'react';
import { RemoteKitError } from '../../shared/errors';
import type { AuthState } from '../../shared/security';
import { useAutoFocus } from '../editing/local-autofocus';
import { failureError, FailureNote } from '../failures';
import { recover } from '../failures/recovery';
import type { AuthCamera, AuthRequest } from './auth-camera';

export function UnlockView({
  auth,
  request,
  camera,
  close,
  connectionError,
  revoked,
}: {
  auth: AuthState | null;
  request: AuthRequest;
  camera: AuthCamera;
  close: () => void;
  connectionError?: RemoteKitError;
  revoked?: boolean;
}) {
  const autoFocusRef = useAutoFocus<HTMLInputElement>();
  const [method, setMethod] = useState<'password' | 'pin' | 'face'>('password');
  const [secret, setSecret] = useState('');
  const [faceUnavailable] = useState(() => new RemoteKitError('rejected', '人脸验证服务不可用'));
  const [error, setError] = useState<RemoteKitError | undefined>();
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
  const lifetime = useRef(new AbortController());
  useEffect(() => () => lifetime.current.abort(), []);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!auth || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (method === 'face') await camera.start('verify');
      else await recover(() => request('auth.verify', { method, secret }), lifetime.current.signal, setError);
    } catch (failure) {
      setError(failureError(failure));
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
            <FailureNote
              error={connectionError ?? new RemoteKitError('unavailable', '')}
              context={{
                operation: '连接验证服务',
                scope: 'full-screen',
                connection: true,
                issue: revoked ? 'lease' : undefined,
                action: revoked ? { label: '重新加载', run: () => location.reload() } : undefined,
              }}
            />
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
                  setError(undefined);
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
                inputRef={autoFocusRef}
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
                      ? '验证已超时，工作区仍锁定。'
                      : auth.face.purpose === 'verify' && auth.face.status === 'failed'
                        ? '未能完成人脸验证，工作区仍锁定。'
                        : '开启摄像头后，按提示完成人脸验证。'}
              </Typography>
            )}
            {method === 'face' && !auth.face.available && (
              <FailureNote
                error={faceUnavailable}
                context={{
                  operation: '完成人脸验证',
                  scope: 'full-screen',
                  consequence: '工作区仍锁定，请使用密码或 PIN',
                }}
              />
            )}
            {method === 'face' && auth.face.error && (
              <FailureNote
                error={auth.face.error}
                context={{
                  operation: '完成人脸验证',
                  scope: 'full-screen',
                  action: {
                    label: '开启摄像头',
                    run: () => {
                      void camera.start('verify').catch((error) => setError(failureError(error)));
                    },
                  },
                }}
              />
            )}
            {error && (
              <FailureNote
                error={error}
                context={{
                  operation: '解锁',
                  scope: 'full-screen',
                  input: true,
                  issue: method === 'face' ? undefined : 'credentials',
                  action: {
                    label: method === 'pin' ? '输入 PIN' : '输入密码',
                    run: () => document.querySelector<HTMLInputElement>('.auth-form input')?.focus(),
                  },
                }}
              />
            )}
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
