import './product-dialogs.css';
import { Close } from '@mui/icons-material';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  TextField,
  Typography,
} from '@mui/material';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  PageDialog,
  PageDialogReply,
  ProductState,
  ProductUser,
  SetupStatus,
} from '../../shared/product';
import { RemoteKitError } from '../../shared/errors';
import type { ProductActionHandler as Action } from '../control/product-operations';
import { formatError } from '../util/format-error';
import { request } from '../control/http-request';
export type { ProductActionHandler as Action } from '../control/product-operations';

export function AuthView({
  onLogin,
  close,
  notice,
}: {
  onLogin: (user: ProductUser) => void;
  close: () => void;
  notice: string;
}) {
  const [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [setup, setSetup] = useState<SetupStatus | null>(null),
    [setupError, setSetupError] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const submitting = useRef(false);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting.current) close();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [close]);
  const refreshSetup = useCallback(async () => {
    setSetupError('');
    try {
      setSetup(await request<SetupStatus>('/api/auth/setup'));
    } catch (e) {
      setSetupError(formatError(e));
    }
  }, []);
  useEffect(() => {
    void refreshSetup();
  }, [refreshSetup]);
  const creating = !!setup?.setupRequired;
  return (
    <main className="auth-page">
      <Box
        component="form"
        className="auth-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting.current || !setup) return;
          submitting.current = true;
          setBusy(true);
          setError('');
          try {
            const result = await request<{ user: ProductUser }>(`/api/auth/${creating ? 'setup' : 'login'}`, {
              username,
              password,
            });
            onLogin(result.user);
          } catch (e) {
            // Account refusals carry messages written for this page, such as a disabled account.
            setError(
              e instanceof RemoteKitError &&
                ['invalid_request', 'unauthenticated', 'forbidden', 'conflict'].includes(e.code)
                ? e.message
                : formatError(e),
            );
            if (creating) void refreshSetup();
          } finally {
            submitting.current = false;
            setBusy(false);
          }
        }}
      >
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          <IconButton aria-label="关闭登录" onClick={close} disabled={busy}>
            <Close />
          </IconButton>
        </Box>
        {notice && <Alert severity="warning">{notice}</Alert>}
        <Typography variant="h5" component="h1">
          {creating ? '创建管理员账户' : '登录 RemoteKit'}
        </Typography>
        <Typography color="text.secondary">
          {creating
            ? '这是服务器上的第一个账户，之后的账户由管理员在管理员面板中创建。'
            : '继续你的浏览器工作空间'}
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        {setupError && (
          <Alert
            severity="error"
            action={
              <Button color="inherit" onClick={() => void refreshSetup()}>
                重试
              </Button>
            }
          >
            无法连接服务器：{setupError}
          </Alert>
        )}
        <TextField
          required
          autoFocus
          label="用户名"
          disabled={busy}
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <TextField
          required
          label="账户密码"
          disabled={busy}
          type="password"
          autoComplete={creating ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          helperText={creating ? '8–256 个字符' : undefined}
        />
        <Button variant="contained" type="submit" disabled={busy || !setup}>
          {busy ? '请稍候…' : creating ? '创建并登录' : '登录'}
        </Button>
        {!creating && setup && (
          <Typography variant="body2" color="text.secondary" textAlign="center">
            没有账户？请联系管理员创建。
          </Typography>
        )}
      </Box>
    </main>
  );
}
export function PageDialogs({
  state,
  action,
  activeId,
}: {
  state: ProductState;
  action: Action;
  activeId: string | null;
}) {
  const dialog = state.pageDialogs?.find((dialog) => dialog.id === activeId);
  return dialog && dialog.kind !== 'permission' && dialog.kind !== 'protocol_handler' ? (
    <PageDialogForm key={dialog.id} dialog={dialog} action={action} />
  ) : null;
}
function PageDialogForm({
  dialog,
  action,
}: {
  dialog: Exclude<PageDialog, { kind: 'permission' | 'protocol_handler' }>;
  action: Action;
}) {
  const [text, setText] = useState('defaultPrompt' in dialog ? dialog.defaultPrompt : '');
  const [username, setUsername] = useState(''),
    [password, setPassword] = useState('');
  useEffect(() => () => setPassword(''), []);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const reply = async (accept: boolean) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const reply: PageDialogReply =
        dialog.kind === 'http_auth'
          ? accept
            ? { kind: 'http_auth', accept: true, username, password }
            : { kind: 'http_auth', accept: false }
          : dialog.kind === 'repost'
            ? { kind: 'repost', accept }
            : { kind: 'dialog', accept, ...(dialog.kind === 'prompt' ? { text } : {}) };
      await action({
        type: 'page.reply',
        dialogId: dialog.id,
        reply,
      });
      setPassword('');
    } catch (e) {
      setError(formatError(e));
      setBusy(false);
    }
  };
  const leaving = dialog.kind === 'beforeunload';
  if (dialog.kind === 'http_auth' || dialog.kind === 'repost')
    return (
      <Dialog open maxWidth="xs" fullWidth onClose={busy ? undefined : () => void reply(false)}>
        <DialogTitle>{dialog.kind === 'http_auth' ? '登录' : '确认重新提交表单'}</DialogTitle>
        <DialogContent>
          {dialog.kind === 'http_auth' ? (
            <>
              <Typography sx={{ overflowWrap: 'anywhere' }}>
                {dialog.proxy ? `代理服务器 ${dialog.origin}` : dialog.origin}
              </Typography>
              <Typography>要求提供用户名和密码。</Typography>
              {!dialog.proxy && dialog.origin.startsWith('http:') && (
                <Alert severity="warning" sx={{ mt: 2 }}>
                  您与此网站的连接不是私密连接
                </Alert>
              )}
              <Box
                component="form"
                id="page-http-auth"
                onSubmit={(event) => {
                  event.preventDefault();
                  void reply(true);
                }}
                sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 2 }}
              >
                <TextField
                  autoFocus
                  label="用户名"
                  autoComplete="off"
                  spellCheck={false}
                  value={username}
                  disabled={busy}
                  onChange={(event) => setUsername(event.target.value)}
                />
                <TextField
                  label="密码"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={password}
                  disabled={busy}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button type="submit" hidden />
              </Box>
            </>
          ) : (
            <Typography>
              您所查找的网页使用了您输入的信息。返回此页可能需要重复您已进行的所有操作。是否要继续？
            </Typography>
          )}
          {error && <Alert severity="error">{error}</Alert>}
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 2 }}>
            <Button disabled={busy} onClick={() => void reply(false)}>
              取消
            </Button>
            <Button disabled={busy} variant="contained" onClick={() => void reply(true)}>
              {dialog.kind === 'http_auth' ? '登录' : '继续'}
            </Button>
          </Box>
        </DialogContent>
      </Dialog>
    );
  return (
    <Dialog
      open
      onClose={dialog.kind === 'alert' || busy ? undefined : () => void reply(false)}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>{leaving ? '离开此页面？' : dialog.origin || '页面消息'}</DialogTitle>
      <DialogContent>
        <Typography sx={{ whiteSpace: 'pre-wrap' }}>
          {dialog.message || (leaving ? '此页面可能有未保存的内容。' : '')}
        </Typography>
        {dialog.kind === 'prompt' && (
          <TextField
            autoFocus
            fullWidth
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            sx={{ mt: 2 }}
          />
        )}
        {error && <Alert severity="error">{error}</Alert>}
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 2, '& > * + *': { ml: 1 } }}>
          {dialog.kind !== 'alert' && (
            <Button disabled={busy} onClick={() => void reply(false)}>
              {leaving ? '留在页面' : '取消'}
            </Button>
          )}
          <Button disabled={busy} variant="contained" onClick={() => void reply(true)}>
            {leaving ? '继续离开' : '确认'}
          </Button>
        </Box>
      </DialogContent>
    </Dialog>
  );
}
