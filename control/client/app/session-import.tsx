import Close from '@mui/icons-material/Close';
import ContentCopy from '@mui/icons-material/ContentCopy';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import ExpandMore from '@mui/icons-material/ExpandMore';
import Language from '@mui/icons-material/Language';
import Link from '@mui/icons-material/Link';
import MoveToInbox from '@mui/icons-material/MoveToInbox';
import OpenInNew from '@mui/icons-material/OpenInNew';
import PhoneAndroid from '@mui/icons-material/PhoneAndroid';
import Undo from '@mui/icons-material/Undo';
import {
  Alert,
  Avatar,
  Button,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  LinearProgress,
  Switch,
  Tooltip,
  Typography,
} from '@mui/material';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  ControlEvent,
  ImportDevice,
  PairingState,
  SessionImportState,
  SessionImportSocketMethods,
  TimelineEntry,
} from '../../shared/session-import';
import type { Action } from './product-dialogs';
import { formatError } from '../util/format-error';
import { SettingRow, SettingSection } from './setting-layout';
import { formatTime } from './admin/shared';
import { useLayoutNarrow } from './ui-scale';

export type SessionImportCall = <K extends keyof SessionImportSocketMethods>(
  method: K,
  params: SessionImportSocketMethods[K]['params'],
) => Promise<SessionImportSocketMethods[K]['result']>;
type Call = SessionImportCall;
type Tone = 'default' | 'success' | 'error' | 'warning';
const toneColor = {
  default: 'text.primary',
  success: 'success.main',
  warning: 'warning.main',
  error: 'error.main',
};

const closedReasons = {
  paired: '上次的配对码已用于配对成功。',
  expired: '上次的配对码已过期。',
  failures: '上次的配对码因多次失败已失效。',
  user: '配对已关闭。',
};

function host(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function remaining(until: number) {
  const minutes = Math.max(0, Math.round((until - Date.now()) / 60000));
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)} 天 ${Math.floor((minutes % 1440) / 60)} 小时`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
  return `${minutes} 分钟`;
}

function counts(cookies: number, origins: number) {
  return `${cookies} 个 Cookie · ${origins} 个站点存储`;
}

function title(entry: TimelineEntry) {
  const request = entry.request;
  if (request.type === 'pair') return '配对请求';
  if (request.type === 'withdraw') return '撤回导入';
  return request.sites.map((site) => site.name || host(site.url)).join('、');
}

function status(entry: TimelineEntry): { label: string; tone: Tone } {
  const last = entry.replies[entry.replies.length - 1];
  if (entry.request.type === 'pair') {
    if (last?.type === 'paired') return { label: '已配对', tone: 'success' };
    if (last?.type === 'pairRejected') return { label: '已拒绝', tone: 'error' };
    return { label: '处理中', tone: 'default' };
  }
  if (entry.request.type === 'withdraw') return { label: '已处理', tone: 'default' };
  switch (entry.record?.state) {
    case 'applied':
      return { label: '已导入', tone: 'success' };
    case 'failed':
      return { label: '失败', tone: 'error' };
    case 'discarded':
      return { label: '已放弃', tone: 'default' };
    case 'pending':
      return { label: '等待写入', tone: 'warning' };
    default:
      return { label: '处理中', tone: 'default' };
  }
}

function replyText(event: ControlEvent): { text: string; tone: Tone } {
  switch (event.type) {
    case 'paired':
      return { text: `已配对到账户 ${event.username}，此后无需再验证`, tone: 'success' };
    case 'pairRejected':
      return { text: event.reason, tone: 'error' };
    case 'importReceived':
      return { text: '已收到，等浏览器在线时写入', tone: 'default' };
    case 'importApplied': {
      const rejected = event.cookies.rejected + event.localStorage.rejected;
      return {
        text:
          `已写入 ${event.cookies.applied} 个 Cookie、${event.localStorage.applied} 项存储` +
          (rejected ? `，${rejected} 项被浏览器拒绝` : ''),
        tone: rejected ? 'warning' : 'success',
      };
    }
    case 'importFailed':
      return { text: event.reason + (event.retryable ? '（可在手机上重试）' : ''), tone: 'error' };
    case 'importDiscarded':
      return { text: '已放弃，不会写入', tone: 'default' };
    case 'revoked':
      return { text: '设备已移除', tone: 'default' };
  }
}

export function SessionImportSettings({
  online,
  call,
  action,
  windowId,
  opened,
}: {
  online: boolean;
  call: Call;
  action: Action;
  windowId: string | null;
  opened: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <SettingSection title="会话导入">
        <SettingRow
          title="从手机导入登录状态"
          description="提前在手机上登录需要二次验证的网站，再把登录状态发到这里。"
        >
          <Button variant="outlined" disabled={!online} onClick={() => setOpen(true)}>
            管理
          </Button>
        </SettingRow>
      </SettingSection>
      {open && (
        <ImportDialog
          online={online}
          call={call}
          action={action}
          windowId={windowId}
          close={() => setOpen(false)}
          opened={() => {
            setOpen(false);
            opened();
          }}
        />
      )}
    </>
  );
}

function ImportDialog({
  online,
  call,
  action,
  windowId,
  close,
  opened,
}: {
  online: boolean;
  call: Call;
  action: Action;
  windowId: string | null;
  close: () => void;
  opened: () => void;
}) {
  const compact = useLayoutNarrow();
  const [state, setState] = useState<SessionImportState>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<ImportDevice>();
  const mounted = useRef(true);
  const refreshing = useRef(false);
  const refresh = async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const value = await call('sessionImport.state', {});
      if (mounted.current) setState(value);
    } catch (e) {
      if (mounted.current) setError(formatError(e));
    } finally {
      refreshing.current = false;
    }
  };
  useEffect(() => {
    mounted.current = true;
    if (online) void refresh();
    const timer = online
      ? setInterval(() => {
          void refresh();
        }, 5000)
      : undefined;
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [call, online]);
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
      if (mounted.current) await refresh();
    } catch (e) {
      if (mounted.current) setError(formatError(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const disabled = !online || busy;
  const actions = {
    disabled,
    canOpen: !disabled && !!windowId,
    openSite: (url: string) =>
      run(async () => {
        await action({ type: 'tab.create', windowId: windowId!, url });
        opened();
      }),
    discard: (id: string) =>
      run(async () => {
        await call('sessionImport.discard', { id });
      }),
  };
  return (
    <Dialog
      open
      onClose={busy ? undefined : close}
      fullScreen={compact}
      fullWidth
      maxWidth="sm"
      PaperProps={{ className: 'settings-paper' }}
    >
      <DialogTitle className="dialog-heading">
        会话导入
        <IconButton aria-label="关闭会话导入" disabled={busy} onClick={close}>
          <Close />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        {!state ? (
          <LinearProgress sx={{ my: 1 }} />
        ) : (
          <>
            {!state.receiving && (
              <Alert severity="info" sx={{ mb: 2 }}>
                管理员尚未开启会话导入，暂时无法接收手机发来的请求。
              </Alert>
            )}
            <Section title="设备">
              <Pairing
                pairing={state.pairing}
                disabled={disabled || !state.receiving}
                toggle={(open) =>
                  run(async () => {
                    await call('sessionImport.pairing', { open });
                  })
                }
              />
              {state.devices.length === 0 ? (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                  还没有配对的手机。打开上面的开关，在 App 里输入配对码、账户和密码。
                </Typography>
              ) : (
                <div className="import-devices">
                  {state.devices.map((device) => (
                    <DeviceRow
                      key={device.keyId}
                      device={device}
                      disabled={disabled}
                      remove={() => setRemoving(device)}
                    />
                  ))}
                </div>
              )}
            </Section>
            <Section title="请求记录">
              {state.timeline.length === 0 ? (
                <div className="import-empty">
                  <MoveToInbox color="disabled" sx={{ fontSize: 40 }} />
                  <Typography variant="body2" color="text.secondary">
                    手机发来的配对与导入请求，以及 RemoteKit 的回复，会按顺序出现在这里。
                  </Typography>
                </div>
              ) : (
                <div className="timeline">
                  {state.timeline.map((entry) => (
                    <TimelineCard key={`${entry.keyId}:${entry.seq}`} entry={entry} actions={actions} />
                  ))}
                </div>
              )}
            </Section>
          </>
        )}
      </DialogContent>
      {removing && (
        <Dialog open onClose={() => setRemoving(undefined)} maxWidth="xs" fullWidth>
          <DialogTitle>移除“{removing.name}”？</DialogTitle>
          <DialogContent>
            <DialogContentText>
              这台手机之后发来的请求都不会被处理，尚未写入的导入会被放弃。要再使用，需要重新配对。
            </DialogContentText>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setRemoving(undefined)}>取消</Button>
            <Button
              color="error"
              disabled={disabled}
              onClick={() => {
                const keyId = removing.keyId;
                setRemoving(undefined);
                void run(async () => {
                  await call('sessionImport.removeDevice', { keyId });
                });
              }}
            >
              移除
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="import-section">
      <Typography variant="overline" color="text.secondary" component="h3">
        {title}
      </Typography>
      {children}
    </section>
  );
}

function Pairing({
  pairing,
  disabled,
  toggle,
}: {
  pairing: PairingState;
  disabled: boolean;
  toggle: (open: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(pairing.code!.join(' '));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="pairing">
      <div className="pairing-row">
        <div>
          <Typography fontWeight={600}>允许配对新手机</Typography>
          <Typography variant="body2" color="text.secondary">
            {pairing.open
              ? '在 App 中输入下面的配对码。配对一次成功后自动关闭。'
              : pairing.closedReason
                ? closedReasons[pairing.closedReason]
                : '打开后生成一次性配对码，最长有效 3 天。'}
          </Typography>
        </div>
        <Switch
          checked={pairing.open}
          disabled={disabled}
          onChange={(event) => toggle(event.target.checked)}
          inputProps={{ 'aria-label': '允许配对新手机' }}
        />
      </div>
      {pairing.open && pairing.code && (
        <div className="pair-code">
          <ol className="pair-words">
            {pairing.code.map((word, index) => (
              <li key={index}>
                <span className="pair-index">{index + 1}</span>
                {word}
              </li>
            ))}
          </ol>
          <div className="pair-meta">
            <Typography variant="body2" color="text.secondary">
              {pairing.expiresAt !== null && `还剩 ${remaining(pairing.expiresAt)}`}
              {pairing.failures > 0 && ` · 已失败 ${pairing.failures} 次，10 次后失效`}
            </Typography>
            <Button size="small" startIcon={<ContentCopy />} onClick={() => void copy()}>
              {copied ? '已复制' : '复制'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function DeviceRow({
  device,
  disabled,
  remove,
}: {
  device: ImportDevice;
  disabled: boolean;
  remove: () => void;
}) {
  return (
    <div className="import-device">
      <Avatar sx={{ width: 36, height: 36, bgcolor: 'action.selected', color: 'text.primary' }}>
        <PhoneAndroid fontSize="small" />
      </Avatar>
      <div className="import-device-text">
        <Typography fontWeight={600} noWrap>
          {device.name}
        </Typography>
        <Typography variant="body2" color="text.secondary" noWrap>
          {formatTime(device.pairedAt)}配对
          {device.lastRequestAt !== null && ` · 最近请求 ${formatTime(device.lastRequestAt)}`}
        </Typography>
      </div>
      <Tooltip title="移除这台手机">
        <span>
          <IconButton aria-label={`移除 ${device.name}`} disabled={disabled} onClick={remove}>
            <DeleteOutline fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </div>
  );
}

function TimelineCard({
  entry,
  actions,
}: {
  entry: TimelineEntry;
  actions: {
    disabled: boolean;
    canOpen: boolean;
    openSite: (url: string) => void;
    discard: (id: string) => void;
  };
}) {
  const [expanded, setExpanded] = useState(false);
  const request = entry.request;
  const { label, tone } = status(entry);
  const icon =
    request.type === 'pair' ? (
      <Link fontSize="small" />
    ) : request.type === 'withdraw' ? (
      <Undo fontSize="small" />
    ) : (
      <Language fontSize="small" />
    );
  return (
    <article className="timeline-card">
      <button className="timeline-head" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
        <Avatar sx={{ width: 32, height: 32, bgcolor: 'action.selected', color: 'text.primary' }}>
          {icon}
        </Avatar>
        <span className="timeline-text">
          <Typography component="span" fontWeight={600} noWrap display="block">
            {title(entry)}
          </Typography>
          <Typography component="span" variant="body2" color="text.secondary" noWrap display="block">
            {entry.device}
            {!entry.paired && '（未配对）'} · {formatTime(entry.receivedAt)}
          </Typography>
        </span>
        <Chip size="small" variant="outlined" color={tone} label={label} />
        <ExpandMore className={expanded ? 'timeline-chevron open' : 'timeline-chevron'} fontSize="small" />
      </button>
      {entry.replies.length > 0 && (
        <ol className="timeline-replies">
          {entry.replies.map((reply, index) => {
            const text = replyText(reply);
            return (
              <li key={index} className="timeline-reply">
                <Typography component="span" fontSize="inherit" color={toneColor[text.tone]}>
                  {text.text}
                </Typography>
                <time>{formatTime(reply.at)}</time>
              </li>
            );
          })}
        </ol>
      )}
      <Collapse in={expanded} unmountOnExit>
        <dl className="timeline-details">
          {request.type === 'pair' && (
            <>
              <dt>设备名</dt>
              <dd>{request.device}</dd>
            </>
          )}
          {request.type === 'import' && (
            <>
              <dt>站点</dt>
              <dd>
                <ul className="timeline-sites">
                  {request.sites.map((site) => (
                    <li key={site.url}>
                      <span className="timeline-site-text">
                        <span>{site.name || host(site.url)}</span>
                        <Typography component="span" variant="body2" color="text.secondary" noWrap>
                          {site.url}
                        </Typography>
                      </span>
                      {entry.record?.state === 'applied' && (
                        <Tooltip title="在新标签页打开">
                          <span>
                            <IconButton
                              size="small"
                              aria-label={`在新标签页打开 ${host(site.url)}`}
                              disabled={!actions.canOpen}
                              onClick={() => actions.openSite(site.url)}
                            >
                              <OpenInNew fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      )}
                    </li>
                  ))}
                </ul>
              </dd>
              <dt>内容</dt>
              <dd>{counts(request.cookies, request.origins)}</dd>
              {entry.record?.error && (
                <>
                  <dt>原因</dt>
                  <dd>{entry.record.error}</dd>
                </>
              )}
            </>
          )}
          {request.type === 'withdraw' && (
            <>
              <dt>导入</dt>
              <dd className="timeline-mono">{request.id}</dd>
            </>
          )}
          <dt>手机发出</dt>
          <dd>{formatTime(entry.at)}</dd>
          <dt>RemoteKit 收到</dt>
          <dd>{formatTime(entry.receivedAt)}</dd>
          <dt>设备</dt>
          <dd className="timeline-mono">
            {entry.keyId} · #{entry.seq}
          </dd>
        </dl>
        {request.type === 'import' && entry.record?.state === 'pending' && (
          <div className="timeline-actions">
            <Button
              size="small"
              color="error"
              disabled={actions.disabled}
              onClick={() => actions.discard(request.id)}
            >
              放弃导入
            </Button>
          </div>
        )}
      </Collapse>
    </article>
  );
}
