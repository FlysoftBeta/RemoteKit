import {
  AccountCircleOutlined,
  AppsOutlined,
  ArrowBack,
  BugReportOutlined,
  ExpandMore,
  ImportExportOutlined,
  LockOutlined,
  PaletteOutlined,
  TvOutlined,
} from '@mui/icons-material';
import {
  Alert,
  Avatar,
  Button,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppDefinition, InstalledApp, ProductState } from '../../shared/product';
import type { Action } from './product-dialogs';
import type { WorkspaceCall } from './window-state';
import { AppFields } from './app-editor';
import { AppIcon } from './app-icon';
import { WorkspacePreferences } from './workspace-preferences';
import { formatError } from '../util/format-error';

const sections = [
  ['appearance', '外观', <PaletteOutlined />],
  ['media', '画面', <TvOutlined />],
  ['security', '安全', <LockOutlined />],
  ['apps', 'App', <AppsOutlined />],
  ['import', '会话导入', <ImportExportOutlined />],
  ['diagnostics', '诊断', <BugReportOutlined />],
  ['account', '账户', <AccountCircleOutlined />],
] as const;

export function SettingsApp({
  state,
  viewState,
  onState,
  action,
  call,
  online,
  security,
  diagnostics,
  sessionImport,
  logout,
  admin,
}: {
  state: ProductState;
  viewState: Record<string, unknown>;
  onState(value: unknown): void;
  action: Action;
  call: WorkspaceCall;
  online: boolean;
  security: ReactNode;
  diagnostics: ReactNode;
  sessionImport: ReactNode;
  logout(): void;
  admin(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [pushed, setPushed] = useState(!!viewState.section);
  const [message, setMessage] = useState('');
  const [clearing, setClearing] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const section = typeof viewState.section === 'string' ? viewState.section : 'appearance';
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const measure = () => setNarrow(node.offsetWidth < 640);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={host} className={`settings-app${narrow ? ' settings-narrow' : ''}`}>
      {(!narrow || !pushed) && (
        <nav className="settings-navigation" aria-label="设置分区">
          <List dense>
            {sections.map(([key, title, icon]) => (
              <ListItemButton
                key={key}
                selected={!narrow && section === key}
                sx={{ borderRadius: 1, minHeight: 40 }}
                onClick={() => {
                  onState({ ...viewState, section: key });
                  setPushed(true);
                }}
              >
                <ListItemIcon sx={{ minWidth: 36, '& svg': { fontSize: 20 } }}>{icon}</ListItemIcon>
                <ListItemText primary={title} slotProps={{ primary: { fontSize: 14 } }} />
              </ListItemButton>
            ))}
          </List>
        </nav>
      )}
      {(!narrow || pushed) && (
        <div className="settings-detail">
          <div className="settings-detail-title">
            {narrow && (
              <IconButton aria-label="返回设置分区" onClick={() => setPushed(false)}>
                <ArrowBack />
              </IconButton>
            )}
            <Typography variant="h6">{sections.find(([key]) => key === section)?.[1] ?? '设置'}</Typography>
          </div>
          <WorkspacePreferences section={section} state={state} online={online} action={action} />
          {section === 'security' && security}
          {section === 'diagnostics' && diagnostics}
          {section === 'import' && sessionImport}
          {section === 'apps' && (
            <div className="installed-apps">
              {state.workspace.apps.length === 0 && (
                <Typography color="text.secondary">尚未安装网页 App</Typography>
              )}
              {state.workspace.apps.map((app) => (
                <InstalledAppEditor
                  key={app.id}
                  app={app}
                  action={action}
                  online={online}
                  expanded={editing === app.id}
                  onToggle={() => setEditing(editing === app.id ? null : app.id)}
                />
              ))}
            </div>
          )}
          {section === 'account' && (
            <div className="account-settings">
              <div className="account-identity">
                <Avatar>{state.user.username.slice(0, 1).toUpperCase()}</Avatar>
                <Typography variant="subtitle1" sx={{ fontWeight: 600, ml: 1.5, mr: 1 }} noWrap>
                  {state.user.username}
                </Typography>
                {state.user.isAdmin && <Chip size="small" label="管理员" />}
              </div>
              <div className="account-actions">
                {state.user.isAdmin && (
                  <Button variant="outlined" onClick={admin}>
                    管理员面板
                  </Button>
                )}
                <Button variant="outlined" disabled={!online} onClick={() => setClearing(true)}>
                  清除使用记录
                </Button>
                <Button variant="outlined" color="error" onClick={logout}>
                  退出登录
                </Button>
              </div>
              {message && (
                <Typography variant="body2" color="text.secondary" role="status">
                  {message}
                </Typography>
              )}
              <Dialog open={clearing} onClose={() => setClearing(false)}>
                <DialogTitle>清除使用记录？</DialogTitle>
                <DialogContent>
                  <Typography variant="body2" color="text.secondary">
                    开始屏幕的常用项会从头学习。已收藏的网页、已安装的 App 和文件不受影响。
                  </Typography>
                </DialogContent>
                <DialogActions>
                  <Button onClick={() => setClearing(false)}>取消</Button>
                  <Button
                    color="error"
                    onClick={() => {
                      setClearing(false);
                      void call('usage.clear', { scope: 'all' })
                        .then(() => setMessage('已清除使用记录'))
                        .catch((error) => setMessage(formatError(error)));
                    }}
                  >
                    清除
                  </Button>
                </DialogActions>
              </Dialog>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InstalledAppEditor({
  app,
  action,
  online,
  expanded,
  onToggle,
}: {
  app: InstalledApp;
  action: Action;
  online: boolean;
  expanded: boolean;
  onToggle(): void;
}) {
  const [value, setValue] = useState<AppDefinition>({
    name: app.name,
    startUrl: app.startUrl,
    scope: app.scope,
    display: app.display,
    themeColor: app.themeColor,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uninstalling, setUninstalling] = useState(false);
  const run = (command: Parameters<Action>[0]) => {
    setBusy(true);
    setError('');
    void action(command)
      .catch((error) => setError(formatError(error)))
      .finally(() => setBusy(false));
  };
  return (
    <section className={`installed-app${expanded ? ' expanded' : ''}`}>
      <ListItemButton className="installed-app-summary" onClick={onToggle} aria-expanded={expanded}>
        <span className="installed-app-icon">
          <AppIcon appId={`web:${app.id}`} iconUrl={app.iconUrl} />
        </span>
        <ListItemText
          primary={app.name}
          secondary={app.scope}
          slotProps={{ primary: { noWrap: true }, secondary: { noWrap: true } }}
        />
        <ExpandMore className="installed-app-chevron" />
      </ListItemButton>
      <Collapse in={expanded} unmountOnExit>
        <div className="installed-app-editor">
          <TextField
            label="名称"
            fullWidth
            size="small"
            value={value.name}
            onChange={(e) => setValue({ ...value, name: e.target.value })}
          />
          <AppFields value={value} onChange={setValue} />
          {error && <Alert severity="error">{error}</Alert>}
          <div className="installed-app-actions">
            <Button color="error" disabled={!online || busy} onClick={() => setUninstalling(true)}>
              卸载
            </Button>
            <Button
              variant="contained"
              disabled={!online || busy || !value.name.trim()}
              onClick={() => run({ type: 'app.update', appId: `web:${app.id}`, ...value })}
            >
              保存
            </Button>
          </div>
        </div>
      </Collapse>
      <Dialog open={uninstalling} onClose={() => setUninstalling(false)}>
        <DialogTitle>卸载 {app.name}？</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            它打开的窗口会关闭。网站数据和文件保留，可以随时重新安装。
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUninstalling(false)}>取消</Button>
          <Button
            color="error"
            onClick={() => {
              setUninstalling(false);
              run({ type: 'app.uninstall', appId: `web:${app.id}` });
            }}
          >
            卸载
          </Button>
        </DialogActions>
      </Dialog>
    </section>
  );
}
