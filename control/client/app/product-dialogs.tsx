import { AccountCircleOutlined, Close, Logout } from '@mui/icons-material';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormHelperText,
  IconButton,
  InputLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  TextField,
  Typography,
  useMediaQuery,
} from '@mui/material';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ProductSettings, ProductState, ProductUser, SetupStatus } from '../../shared/product';
import { RemoteKitError } from '../../shared/errors';
import { SEARCH_ENGINES } from '../../shared/product';
import type { ProductActionHandler as Action } from '../control/product-operations';
import { formatError } from '../util/format-error';
import { request } from '../control/http-request';
import { SettingNote, SettingSection, SettingSwitch } from './setting-layout';
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
export function SettingsDialog({
  online,
  state,
  open,
  onClose,
  action,
  logout,
  security,
  diagnostics,
  sessionImport,
}: {
  state: ProductState;
  online: boolean;
  open: boolean;
  onClose: () => void;
  action: Action;
  logout: () => void;
  security?: React.ReactNode;
  diagnostics?: React.ReactNode;
  sessionImport?: React.ReactNode;
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
  const note = (key: string) => {
    const text = busy[key] ? '正在保存…' : (result[key] ?? '');
    return <SettingNote text={text} error={!busy[key] && !!text && text !== '已保存'} />;
  };
  const deviceScale = Number((window.devicePixelRatio || 1).toFixed(2));
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
      <DialogContent dividers className="settings-content">
        <SettingSection title="搜索">
          <FormControl fullWidth size="small" disabled={!online || busy.search} sx={{ mt: 0.5 }}>
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
            <FormHelperText>用于地址栏和起始页中的搜索</FormHelperText>
          </FormControl>
          {note('search')}
        </SettingSection>
        <SettingSection title="画面">
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
          <SettingSwitch
            title="像素比例跟随此设备"
            description={`Client Scale · 此设备为 ${deviceScale}×`}
            checked={settings.clientScaleOverride === null}
            disabled={!online || busy.scale}
            onChange={(checked) =>
              void save('scale', {
                clientScaleOverride: checked ? null : Number(scale) || window.devicePixelRatio || 1,
              })
            }
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
                helperText={`${state.constraints.clientScaleMin}–${state.constraints.clientScaleMax}，点击应用后生效`}
              />
              <Button
                variant="outlined"
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
          <SettingSwitch
            title="显示连接统计"
            description="在页面右上角叠加帧率、码率与延迟"
            checked={settings.showStats ?? false}
            disabled={!online || busy.stats}
            onChange={(checked) => void save('stats', { showStats: checked })}
          />
          {note('stats')}
        </SettingSection>
        <SettingSection title="浏览">
          <SettingSwitch
            title="打开或激活时全屏"
            checked={settings.autoFullscreen}
            disabled={!online || busy.fullscreen}
            onChange={(checked) => void save('fullscreen', { autoFullscreen: checked })}
          />
          {note('fullscreen')}
          <SettingSwitch
            title="音视频同步"
            description="声音与画面对齐，画面延迟会增加；切换时重新建立媒体连接"
            checked={settings.avSync}
            disabled={!online || busy.avSync}
            onChange={(checked) => void save('avSync', { avSync: checked })}
          />
          {note('avSync')}
          <SettingSwitch
            title="内存节省"
            description="暂不使用的页面可以休眠，返回时自动恢复"
            checked={settings.memorySaverEnabled}
            disabled={!online || busy.memory}
            onChange={(checked) => void save('memory', { memorySaverEnabled: checked })}
          />
          {note('memory')}
        </SettingSection>
        {security}
        {sessionImport}
        {diagnostics}
        <div className="account-row">
          <AccountCircleOutlined color="action" />
          <Typography sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
            {state.user.username}
          </Typography>
          <Button color="inherit" startIcon={<Logout />} onClick={logout}>
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
