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
import type { AuthRequest } from './auth-camera';
import { FaceBadge, type FaceUnlock } from './face-unlock';

export function UnlockView({
  auth,
  request,
  face,
  close,
  connectionError,
  revoked,
}: {
  auth: AuthState | null;
  request: AuthRequest;
  face: FaceUnlock;
  close: () => void;
  connectionError?: RemoteKitError;
  revoked?: boolean;
}) {
  const autoFocusRef = useAutoFocus<HTMLInputElement>();
  const [chosen, setChosen] = useState<'password' | 'pin'>();
  const method = chosen === 'password' || !auth?.methods.pin ? 'password' : 'pin';
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<RemoteKitError | undefined>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [close]);
  // Opening the form is a user gesture, so the camera may prompt for permission here.
  const faceStarted = useRef(false);
  useEffect(() => {
    if (faceStarted.current || !face.usable) return;
    faceStarted.current = true;
    if (face.phase === 'idle') face.begin();
  }, [face.usable, face.phase, face.begin]);
  const lifetime = useRef(new AbortController());
  useEffect(() => () => lifetime.current.abort(), []);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!auth || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await recover(() => request('auth.verify', { method, secret }), lifetime.current.signal, setError);
    } catch (failure) {
      setError(failureError(failure));
    } finally {
      setSecret('');
      setBusy(false);
    }
  };
  const switchMethod = (next: 'password' | 'pin') => {
    if (next === method) return;
    setChosen(next);
    setSecret('');
    setError(undefined);
  };
  return (
    <main className="auth-page">
      <Box component="form" className="auth-form unlock-form" onSubmit={submit}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography component="h1" variant="h5">
            解锁
          </Typography>
          <IconButton aria-label="关闭验证" onClick={close}>
            <Close />
          </IconButton>
        </Stack>
        {!auth ? (
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
        ) : (
          <>
            <Typography color="text.secondary">{auth.user.username}</Typography>
            {face.usable ? (
              <FaceBadge face={face} prominent />
            ) : (
              face.enrolled && (
                <Typography variant="caption" color="text.secondary">
                  {auth.face.reason ?? '人脸服务正在连接，请先使用 PIN 或密码'}
                </Typography>
              )
            )}
            {auth.methods.pin && (
              <ToggleButtonGroup
                exclusive
                fullWidth
                size="small"
                value={method}
                aria-label="验证方式"
                onChange={(_, value: 'password' | 'pin' | null) => {
                  if (value) switchMethod(value);
                }}
              >
                <ToggleButton value="pin">PIN</ToggleButton>
                <ToggleButton value="password">密码</ToggleButton>
              </ToggleButtonGroup>
            )}
            <TextField
              key={method}
              className={`unlock-secret ${method}`}
              inputRef={autoFocusRef}
              required
              fullWidth
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
            {error && (
              <FailureNote
                error={error}
                context={{
                  operation: '解锁',
                  scope: 'full-screen',
                  input: true,
                  issue: 'credentials',
                  action: {
                    label: method === 'pin' ? '输入 PIN' : '输入密码',
                    run: () => document.querySelector<HTMLInputElement>('.unlock-form input')?.focus(),
                  },
                }}
              />
            )}
            <Button type="submit" variant="contained" disabled={busy || !secret}>
              {busy ? '正在验证…' : '解锁'}
            </Button>
          </>
        )}
      </Box>
    </main>
  );
}
