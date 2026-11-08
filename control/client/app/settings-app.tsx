import { ArrowBack } from '@mui/icons-material';
import {
  Alert,
  Button,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppDefinition, InstalledApp, ProductState } from '../../shared/product';
import type { Action } from './product-dialogs';
import type { WorkspaceCall } from './window-state';
import { AppFields } from './app-editor';
import { WorkspacePreferences } from './workspace-preferences';
import { formatError } from '../util/format-error';

const sections = [
  ['appearance', '外观'],
  ['media', '画面与声音'],
  ['security', '安全'],
  ['apps', 'App'],
  ['import', '会话导入'],
  ['diagnostics', '诊断'],
  ['account', '账户'],
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
  audio,
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
  audio: ReactNode;
  logout(): void;
  admin(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [pushed, setPushed] = useState(!!viewState.section);
  const [message, setMessage] = useState('');
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
          <List>
            {sections.map(([key, title]) => (
              <ListItemButton
                key={key}
                selected={section === key}
                onClick={() => {
                  onState({ ...viewState, section: key });
                  setPushed(true);
                }}
              >
                <ListItemText primary={title} />
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
          <WorkspacePreferences
            section={section}
            state={state}
            online={online}
            action={action}
            audio={audio}
          />
          {section === 'security' && security}
          {section === 'diagnostics' && diagnostics}
          {section === 'import' && sessionImport}
          {section === 'apps' && (
            <div className="installed-apps">
              {state.workspace.apps.length === 0 && (
                <Typography color="text.secondary">尚未安装网页 App</Typography>
              )}
              {state.workspace.apps.map((app) => (
                <InstalledAppEditor key={app.id} app={app} action={action} online={online} />
              ))}
            </div>
          )}
          {section === 'account' && (
            <div className="account-settings">
              <Typography>{state.user.username}</Typography>
              <Button onClick={logout}>退出登录</Button>
              {state.user.isAdmin && <Button onClick={admin}>管理员面板</Button>}
              <Button
                disabled={!online}
                onClick={() =>
                  void call('usage.clear', { scope: 'all' })
                    .then(() => setMessage('已清除使用记录'))
                    .catch((error) => setMessage(formatError(error)))
                }
              >
                清除使用记录
              </Button>
              {message && <Typography role="status">{message}</Typography>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InstalledAppEditor({ app, action, online }: { app: InstalledApp; action: Action; online: boolean }) {
  const [value, setValue] = useState<AppDefinition>({
    name: app.name,
    startUrl: app.startUrl,
    scope: app.scope,
    display: app.display,
    themeColor: app.themeColor,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = (command: Parameters<Action>[0]) => {
    setBusy(true);
    setError('');
    void action(command)
      .catch((error) => setError(formatError(error)))
      .finally(() => setBusy(false));
  };
  return (
    <section className="installed-app-editor">
      <TextField
        label="名称"
        fullWidth
        value={value.name}
        onChange={(e) => setValue({ ...value, name: e.target.value })}
      />
      <AppFields value={value} onChange={setValue} />
      {error && <Alert severity="error">{error}</Alert>}
      <div>
        <Button
          disabled={!online || busy}
          onClick={() => run({ type: 'app.update', appId: `web:${app.id}`, ...value })}
        >
          保存
        </Button>
        <Button
          color="error"
          disabled={!online || busy}
          onClick={() => run({ type: 'app.uninstall', appId: `web:${app.id}` })}
        >
          卸载
        </Button>
      </div>
    </section>
  );
}
