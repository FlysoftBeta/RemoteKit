import Close from '@mui/icons-material/Close';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Switch,
  TextField,
  Typography,
  useMediaQuery,
} from '@mui/material';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ProductSettings, ProductState, ProductUser, RegistrationStatus } from '../../shared/product';
import { SEARCH_ENGINES } from '../../shared/product';
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
  const [register, setRegister] = useState(false),
    [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [serverCredential, setServerCredential] = useState(''),
    [registration, setRegistration] = useState<RegistrationStatus | null>(null),
    [registrationError, setRegistrationError] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const submitting = useRef(false),
    registrationRequest = useRef(0);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting.current) close();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [close]);
  const refreshRegistration = useCallback(async () => {
    const sequence = ++registrationRequest.current;
    setRegistration(null);
    setRegistrationError('');
    try {
      const result = await request<RegistrationStatus>('/api/auth/registration');
      if (sequence === registrationRequest.current) setRegistration(result);
    } catch (e) {
      if (sequence === registrationRequest.current) setRegistrationError(formatError(e));
    }
  }, []);
  useEffect(() => {
    void refreshRegistration();
    const refresh = () => {
      void refreshRegistration();
    };
    window.addEventListener('focus', refresh);
    return () => {
      registrationRequest.current++;
      window.removeEventListener('focus', refresh);
    };
  }, [register, refreshRegistration]);
  return (
    <main className="auth-page">
      <Box
        component="form"
        className="auth-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting.current || (register && !registration?.registrationOpen)) return;
          if (
            register &&
            registration?.credentialRequired &&
            (serverCredential.length < 8 || serverCredential.length > 256)
          ) {
            setError('注册口令须为 8–256 个字符');
            return;
          }
          submitting.current = true;
          setBusy(true);
          setError('');
          try {
            const result = await request<{ user: ProductUser }>(
              `/api/auth/${register ? 'register' : 'login'}`,
              { username, password, ...(register ? { serverCredential } : {}) },
            );
            onLogin(result.user);
          } catch (e) {
            setError(formatError(e));
            if (register) void refreshRegistration();
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
          {register ? '创建账户' : '登录 RemoteKit'}
        </Typography>
        <Typography color="text.secondary">继续你的浏览器工作空间</Typography>
        {error && <Alert severity="error">{error}</Alert>}
        {register &&
          (registrationError ? (
            <Alert
              severity="error"
              action={
                <Button color="inherit" onClick={() => void refreshRegistration()}>
                  重试
                </Button>
              }
            >
              无法读取注册状态：{registrationError}
            </Alert>
          ) : !registration ? (
            <Typography color="text.secondary" role="status">
              正在读取注册状态…
            </Typography>
          ) : !registration.hasAdmin ? (
            <Alert severity="info">首个账户将成为管理员。创建后，请在更多 → 管理员面板设置注册口令。</Alert>
          ) : !registration.registrationOpen ? (
            <Alert
              severity="info"
              action={
                <Button color="inherit" onClick={() => void refreshRegistration()}>
                  刷新
                </Button>
              }
            >
              注册暂未开放，请联系管理员先设置注册口令。
            </Alert>
          ) : null)}
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
          autoComplete={register ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {register && registration?.credentialRequired && (
          <TextField
            required
            label="注册口令（Server credential）"
            disabled={busy}
            type="password"
            autoComplete="off"
            value={serverCredential}
            onChange={(e) => setServerCredential(e.target.value)}
            helperText="由管理员提供，与账户密码不同。"
            inputProps={{ minLength: 8, maxLength: 256 }}
          />
        )}
        <Button
          variant="contained"
          type="submit"
          disabled={busy || (register && !registration?.registrationOpen)}
        >
          {busy ? '请稍候…' : register ? '创建账户' : '登录'}
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            setRegister(!register);
            setServerCredential('');
            setError('');
          }}
        >
          {register ? '已有账户？登录' : '创建账户'}
        </Button>
      </Box>
    </main>
  );
}
export function SettingsDialog({
  online,
  state,
  open,
  onClose,
  action,
  logout,
  security,
  diagnostics,
}: {
  state: ProductState;
  online: boolean;
  open: boolean;
  onClose: () => void;
  action: Action;
  logout: () => void;
  security?: React.ReactNode;
  diagnostics?: React.ReactNode;
}) {
  const compact = useMediaQuery('(max-width:600px)'),
    settings = state.workspace.settings;
  const [scale, setScale] = useState(String(settings.clientScaleOverride ?? window.devicePixelRatio ?? 1)),
    [result, setResult] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (open) {
      setScale(String(settings.clientScaleOverride ?? window.devicePixelRatio ?? 1));
      setResult({});
    }
  }, [open]);
  const save = async (key: string, value: Partial<ProductSettings>) => {
    if (!online) return;
    setBusy((p) => ({ ...p, [key]: true }));
    setResult((p) => ({ ...p, [key]: '' }));
    try {
      const receipt = await action({ type: 'settings.update', settings: value });
      setResult((p) => ({
        ...p,
        [key]:
          receipt.status === 'committed'
            ? '已保存'
            : receipt.status === 'unknown'
              ? '结果未知，请核对'
              : '正在同步',
      }));
    } catch (e) {
      setResult((p) => ({ ...p, [key]: `未保存，请重试：${formatError(e)}` }));
    } finally {
      setBusy((p) => ({ ...p, [key]: false }));
    }
  };
  const note = (key: string) => (
    <Typography
      className="setting-result"
      role="status"
      color={busy[key] || !result[key] || result[key] === '已保存' ? 'text.secondary' : 'error'}
    >
      {busy[key] ? '正在保存…' : result[key] || ' '}
    </Typography>
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={compact}
      fullWidth
      maxWidth="sm"
      PaperProps={{ className: 'settings-paper' }}
    >
      <DialogTitle className="dialog-heading">
        设置
        <IconButton aria-label="关闭设置" onClick={onClose}>
          <Close />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <div className="setting-section">
          <Typography fontWeight={600} sx={{ mb: 2 }}>
            搜索
          </Typography>
          <FormControl fullWidth size="small" disabled={!online || busy.search}>
            <InputLabel id="search-engine-label">默认搜索引擎</InputLabel>
            <Select
              labelId="search-engine-label"
              label="默认搜索引擎"
              value={settings.searchEngine}
              onChange={(event) =>
                void save('search', { searchEngine: event.target.value as ProductSettings['searchEngine'] })
              }
            >
              {SEARCH_ENGINES.map((engine) => (
                <MenuItem key={engine.value} value={engine.value}>
                  {engine.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Typography variant="caption" color="text.secondary">
            用于地址栏和起始页中的搜索
          </Typography>
          {note('search')}
        </div>
        <Divider sx={{ mb: 2 }} />
        <Typography fontWeight={600}>画面质量</Typography>
        <RadioGroup
          aria-label="画面质量"
          value={settings.qualityPreference}
          onChange={(e) =>
            void save('quality', {
              qualityPreference: e.target.value as ProductSettings['qualityPreference'],
            })
          }
        >
          {(
            [
              ['quality', '优先高画质', '尽量保留画面细节'],
              ['auto', '自动', '平衡清晰度与响应速度'],
              ['smooth', '优先流畅', '优先保持操作顺畅'],
            ] as const
          ).map(([value, title, detail]) => (
            <FormControlLabel
              className="quality-option"
              key={value}
              value={value}
              disabled={!online || busy.quality}
              control={<Radio size="small" />}
              label={
                <>
                  <Typography>{title}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {detail}
                  </Typography>
                </>
              }
            />
          ))}
        </RadioGroup>
        {note('quality')}
        <Divider />
        <div className="setting-section">
          <Typography fontWeight={600}>
            显示像素比例{' '}
            <Typography component="span" variant="caption" color="text.secondary">
              Client Scale
            </Typography>
          </Typography>
          <FormControlLabel
            control={
              <Switch
                checked={settings.clientScaleOverride === null}
                disabled={!online || busy.scale}
                onChange={(_, checked) =>
                  void save('scale', {
                    clientScaleOverride: checked ? null : Number(scale) || window.devicePixelRatio || 1,
                  })
                }
              />
            }
            label={`跟随此设备 · 当前 ${Number((window.devicePixelRatio || 1).toFixed(2))}×`}
          />
          {settings.clientScaleOverride !== null && (
            <div className="scale-row">
              <TextField
                size="small"
                label="像素比例"
                type="number"
                disabled={!online}
                value={scale}
                onChange={(e) => setScale(e.target.value)}
                inputProps={{
                  min: state.constraints.clientScaleMin,
                  max: state.constraints.clientScaleMax,
                  step: 0.1,
                }}
                helperText="点击应用后生效"
              />
              <Button
                disabled={
                  !online ||
                  busy.scale ||
                  !Number.isFinite(Number(scale)) ||
                  Number(scale) < state.constraints.clientScaleMin ||
                  Number(scale) > state.constraints.clientScaleMax
                }
                onClick={() => void save('scale', { clientScaleOverride: Number(scale) })}
              >
                应用
              </Button>
            </div>
          )}
          {note('scale')}
        </div>
        <Divider />
        <div className="setting-section">
          <FormControlLabel
            className="setting-switch"
            labelPlacement="start"
            control={
              <Switch
                checked={settings.autoFullscreen}
                disabled={!online || busy.fullscreen}
                onChange={(_, checked) => void save('fullscreen', { autoFullscreen: checked })}
              />
            }
            label="打开或激活时全屏"
          />
          {note('fullscreen')}
        </div>
        <Divider />
        <div className="setting-section">
          <FormControlLabel
            className="setting-switch"
            labelPlacement="start"
            control={
              <Switch
                checked={settings.memorySaverEnabled}
                disabled={!online || busy.memory}
                onChange={(_, checked) => void save('memory', { memorySaverEnabled: checked })}
              />
            }
            label="内存节省"
          />
          <Typography variant="body2" color="text.secondary">
            暂不使用的页面可以休眠，返回时自动恢复。
          </Typography>
          {note('memory')}
          <FormControlLabel
            control={
              <Checkbox
                checked={settings.showStats ?? false}
                disabled={!online || busy.stats}
                onChange={(_, checked) => void save('stats', { showStats: checked })}
              />
            }
            label="显示连接统计"
          />
          {note('stats')}
        </div>
        <Divider />
        {diagnostics}
        {security}
        <div className="account-row">
          <Typography color="text.secondary">{state.user.username}</Typography>
          <Button color="inherit" onClick={logout}>
            退出登录
          </Button>
        </div>
      </DialogContent>
    </Dialog>
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
  return dialog ? <PageDialogForm key={dialog.id} dialog={dialog} action={action} /> : null;
}
function PageDialogForm({
  dialog,
  action,
}: {
  dialog: NonNullable<ProductState['pageDialogs']>[number];
  action: Action;
}) {
  const [text, setText] = useState(dialog.defaultPrompt ?? '');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const reply = async (accept: boolean) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action({
        type: 'page.reply',
        dialogId: dialog.id,
        accept,
        ...(dialog.kind === 'prompt' ? { text } : {}),
      });
    } catch (e) {
      setError(formatError(e));
      setBusy(false);
    }
  };
  const leaving = dialog.kind === 'beforeunload';
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
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 2 }}>
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
