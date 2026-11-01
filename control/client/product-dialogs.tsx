import React, { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  Radio,
  RadioGroup,
  Switch,
  TextField,
  Typography,
  useMediaQuery,
} from "@mui/material";
import Close from "@mui/icons-material/Close";
import type {
  ProductAction,
  ProductSettings,
  ProductState,
  ProductUser,
} from "../shared/product";
import { request } from "./types";
export type Action = (action: ProductAction) => Promise<unknown>;
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export function AuthView({
  onLogin,
}: {
  onLogin: (user: ProductUser) => void;
}) {
  const [register, setRegister] = useState(false),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <main className="auth-page">
      <Box
        component="form"
        className="auth-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            const result = await request<{ user: ProductUser }>(
              `/api/auth/${register ? "register" : "login"}`,
              { username, password },
            );
            onLogin(result.user);
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Typography variant="h5" component="h1">
          {register ? "创建账户" : "登录 RemoteKit"}
        </Typography>
        <Typography color="text.secondary">继续你的浏览器工作空间</Typography>
        {error && <Alert severity="error">{error}</Alert>}
        <TextField
          required
          autoFocus
          label="用户名"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <TextField
          required
          label="密码"
          type="password"
          autoComplete={register ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button variant="contained" type="submit" disabled={busy}>
          {busy ? "请稍候…" : register ? "创建账户" : "登录"}
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            setRegister(!register);
            setError("");
          }}
        >
          {register ? "已有账户？登录" : "创建账户"}
        </Button>
      </Box>
    </main>
  );
}
export function SettingsDialog({
  state,
  open,
  onClose,
  action,
  logout,
}: {
  state: ProductState;
  open: boolean;
  onClose: () => void;
  action: Action;
  logout: () => void;
}) {
  const compact = useMediaQuery("(max-width:600px)"),
    settings = state.workspace.settings;
  const [scale, setScale] = useState(
      String(settings.clientScaleOverride ?? window.devicePixelRatio ?? 1),
    ),
    [result, setResult] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (open) {
      setScale(
        String(settings.clientScaleOverride ?? window.devicePixelRatio ?? 1),
      );
      setResult({});
    }
  }, [open]);
  const save = async (key: string, value: Partial<ProductSettings>) => {
    setBusy((p) => ({ ...p, [key]: true }));
    setResult((p) => ({ ...p, [key]: "" }));
    try {
      await action({ type: "settings.update", settings: value });
      setResult((p) => ({ ...p, [key]: "已保存" }));
    } catch (e) {
      setResult((p) => ({ ...p, [key]: errorMessage(e) }));
    } finally {
      setBusy((p) => ({ ...p, [key]: false }));
    }
  };
  const note = (key: string) => (
    <Typography
      className="setting-result"
      role="status"
      color={result[key] === "已保存" ? "text.secondary" : "error"}
    >
      {result[key] || " "}
    </Typography>
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={compact}
      fullWidth
      maxWidth="sm"
      PaperProps={{ className: "settings-paper" }}
    >
      <DialogTitle className="dialog-heading">
        设置
        <IconButton aria-label="关闭设置" onClick={onClose}>
          <Close />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Typography fontWeight={600}>画面质量</Typography>
        <RadioGroup
          aria-label="画面质量"
          value={settings.qualityPreference}
          onChange={(e) =>
            void save("quality", {
              qualityPreference: e.target
                .value as ProductSettings["qualityPreference"],
            })
          }
        >
          {(
            [
              ["quality", "优先高画质", "尽量保留画面细节"],
              ["auto", "自动", "平衡清晰度与响应速度"],
              ["smooth", "优先流畅", "优先保持操作顺畅"],
            ] as const
          ).map(([value, title, detail]) => (
            <FormControlLabel
              className="quality-option"
              key={value}
              value={value}
              disabled={busy.quality}
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
        {note("quality")}
        <Divider />
        <div className="setting-section">
          <Typography fontWeight={600}>
            显示像素比例{" "}
            <Typography
              component="span"
              variant="caption"
              color="text.secondary"
            >
              Client Scale
            </Typography>
          </Typography>
          <FormControlLabel
            control={
              <Switch
                checked={settings.clientScaleOverride === null}
                disabled={busy.scale}
                onChange={(_, checked) =>
                  void save("scale", {
                    clientScaleOverride: checked
                      ? null
                      : Number(scale) || window.devicePixelRatio || 1,
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
                  busy.scale ||
                  !Number.isFinite(Number(scale)) ||
                  Number(scale) < state.constraints.clientScaleMin ||
                  Number(scale) > state.constraints.clientScaleMax
                }
                onClick={() =>
                  void save("scale", { clientScaleOverride: Number(scale) })
                }
              >
                应用
              </Button>
            </div>
          )}
          {note("scale")}
        </div>
        <Divider />
        <div className="setting-section">
          <FormControlLabel
            className="setting-switch"
            labelPlacement="start"
            control={
              <Switch
                checked={settings.memorySaverEnabled}
                disabled={busy.memory}
                onChange={(_, checked) =>
                  void save("memory", { memorySaverEnabled: checked })
                }
              />
            }
            label="内存节省"
          />
          <Typography variant="body2" color="text.secondary">
            暂不使用的页面可以休眠，返回时自动恢复。
          </Typography>
          {note("memory")}
          <FormControlLabel
            control={
              <Checkbox
                checked={settings.showStats ?? false}
                disabled={busy.stats}
                onChange={(_, checked) =>
                  void save("stats", { showStats: checked })
                }
              />
            }
            label="显示连接统计"
          />
          {note("stats")}
        </div>
        <Divider />
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

export function PageDialogs({ state, action }: { state: ProductState; action: Action }) {
  const visible = state.workspace.windows.filter(w => state.workspace.layoutMode === 'side-by-side' && window.innerWidth >= Math.max(720, state.workspace.windows.length * 365 - 5) || w.id === state.workspace.activeWindowId).map(w => w.activeTabId);
  const dialog = state.pageDialogs?.find(d => visible.includes(d.tabId));
  return dialog ? <PageDialogForm key={dialog.id} dialog={dialog} action={action} /> : null;
}
function PageDialogForm({ dialog, action }: { dialog: NonNullable<ProductState['pageDialogs']>[number]; action: Action }) {
  const [text, setText] = useState(dialog.defaultPrompt ?? '');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const reply = async (accept: boolean) => {
    if (busy) return; setBusy(true); setError('');
    try { await action({ type: 'page.reply', dialogId: dialog.id, accept, ...(dialog.kind === 'prompt' ? { text } : {}) }); }
    catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  const leaving = dialog.kind === 'beforeunload';
  return <Dialog open onClose={dialog.kind === 'alert' || busy ? undefined : () => void reply(false)} maxWidth="sm" fullWidth>
    <DialogTitle>{leaving ? '离开此页面？' : dialog.origin || '页面消息'}</DialogTitle>
    <DialogContent><Typography sx={{ whiteSpace: 'pre-wrap' }}>{dialog.message || (leaving ? '此页面可能有未保存的内容。' : '')}</Typography>
      {dialog.kind === 'prompt' && <TextField autoFocus fullWidth value={text} disabled={busy} onChange={e => setText(e.target.value)} sx={{ mt: 2 }} />}
      {error && <Alert severity="error">{error}</Alert>}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 2 }}>
        {dialog.kind !== 'alert' && <Button disabled={busy} onClick={() => void reply(false)}>{leaving ? '留在页面' : '取消'}</Button>}
        <Button disabled={busy} variant="contained" onClick={() => void reply(true)}>{leaving ? '继续离开' : '确认'}</Button>
      </Box>
    </DialogContent>
  </Dialog>;
}
