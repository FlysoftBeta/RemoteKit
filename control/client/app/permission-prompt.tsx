import './permission-prompt.css';
import React, { useEffect, useRef, useState } from 'react';
import {
  AccessTimeOutlined,
  Close,
  ContentPasteOutlined,
  FontDownloadOutlined,
  LinkOutlined,
  LocationOnOutlined,
  PianoOutlined,
  WebAssetOutlined,
} from '@mui/icons-material';
import { Alert, Box, Button, IconButton, Paper, Typography } from '@mui/material';
import type { PageDialog, PageDialogReply, SitePermission } from '../../shared/product';
import type { Action } from './product-dialogs';
import { formatError } from '../util/format-error';

export const PERMISSION_LABELS: Record<
  SitePermission,
  { icon: typeof LocationOnOutlined; label: string; request: string }
> = {
  geolocation: { icon: LocationOnOutlined, label: '位置信息', request: '了解您的位置' },
  clipboard_read: { icon: ContentPasteOutlined, label: '剪贴板', request: '查看剪贴板中的文字和图片' },
  local_fonts: { icon: FontDownloadOutlined, label: '字体', request: '使用您电脑上的字体' },
  window_management: { icon: WebAssetOutlined, label: '窗口管理', request: '管理您所有屏幕上的窗口' },
  midi_sysex: { icon: PianoOutlined, label: 'MIDI 设备', request: '完全控制 MIDI 设备' },
  idle_detection: { icon: AccessTimeOutlined, label: '设备使用情况', request: '了解您何时在积极使用此设备' },
};

// Decode the RFC 3492 labels that URL.hostname exposes as ASCII in browsers.
function unicodeLabel(label: string): string {
  if (!label.startsWith('xn--')) return label;
  const input = label.slice(4),
    output: number[] = [];
  let cursor = input.lastIndexOf('-');
  if (cursor >= 0) for (const char of input.slice(0, cursor)) output.push(char.charCodeAt(0));
  cursor++;
  let point = 128,
    index = 0,
    bias = 72;
  while (cursor < input.length) {
    const previous = index;
    let weight = 1;
    for (let k = 36; ; k += 36) {
      const code = input.charCodeAt(cursor++);
      const digit = code >= 97 && code <= 122 ? code - 97 : code >= 48 && code <= 57 ? code - 22 : 36;
      if (digit >= 36) return label;
      index += digit * weight;
      const threshold = Math.max(1, Math.min(26, k - bias));
      if (digit < threshold) break;
      weight *= 36 - threshold;
      if (!Number.isSafeInteger(weight)) return label;
    }
    const length = output.length + 1;
    let delta = Math.floor((index - previous) / (previous === 0 ? 700 : 2));
    delta += Math.floor(delta / length);
    let adjustment = 0;
    while (delta > 455) {
      delta = Math.floor(delta / 35);
      adjustment += 36;
    }
    bias = adjustment + Math.floor((36 * delta) / (delta + 38));
    point += Math.floor(index / length);
    index %= length;
    if (point > 0x10ffff) return label;
    output.splice(index++, 0, point);
  }
  return String.fromCodePoint(...output);
}
export function siteHost(origin: string) {
  const url = new URL(origin);
  return url.hostname.split('.').map(unicodeLabel).join('.') + (url.port ? `:${url.port}` : '');
}
export function protocolName(protocol: string) {
  return protocol.replace(/^web\+/, '');
}
type BubbleDialog = Extract<PageDialog, { kind: 'permission' | 'protocol_handler' }>;
export function PermissionPrompt({ dialog, action }: { dialog: BubbleDialog; action: Action }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const card = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const parent = card.current?.parentElement;
    if (!parent) return;
    const measure = () => setNarrow(parent.clientWidth < 352);
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    measure();
    return () => observer.disconnect();
  }, []);
  const reply = async (reply: PageDialogReply) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action({ type: 'page.reply', dialogId: dialog.id, reply });
    } catch (error) {
      setError(formatError(error));
      setBusy(false);
    }
  };
  return (
    <Paper
      ref={card}
      elevation={8}
      className="permission-prompt"
      style={{ width: narrow ? 'calc(100% - 16px)' : 320 }}
      role="region"
      aria-label="网站请求"
    >
      <Box className="permission-prompt-header">
        <Typography fontWeight={500} sx={{ overflowWrap: 'anywhere' }}>
          {siteHost(dialog.origin)} 想要
        </Typography>
        <IconButton
          aria-label="关闭"
          disabled={busy}
          onClick={() =>
            void reply(
              dialog.kind === 'permission'
                ? { kind: 'permission', decision: 'dismiss' }
                : { kind: 'protocol_handler', accept: false, remember: false },
            )
          }
        >
          <Close fontSize="small" />
        </IconButton>
      </Box>
      {dialog.kind === 'permission' && dialog.embeddingOrigin !== dialog.origin && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2, overflowWrap: 'anywhere' }}>
          嵌入在 {siteHost(dialog.embeddingOrigin)} 中
        </Typography>
      )}
      {dialog.kind === 'permission' ? (
        dialog.permissions.map((permission) => {
          const { icon: Icon, request } = PERMISSION_LABELS[permission];
          return (
            <Box className="permission-prompt-row" key={permission}>
              <Icon sx={{ fontSize: 20 }} />
              <Typography variant="body2">{request}</Typography>
            </Box>
          );
        })
      ) : (
        <Box className="permission-prompt-row">
          <LinkOutlined sx={{ fontSize: 20 }} />
          <Typography variant="body2">打开 {protocolName(dialog.protocol)} 链接</Typography>
        </Box>
      )}
      {error && <Alert severity="error">{error}</Alert>}
      <Box className="permission-prompt-actions">
        {dialog.kind === 'permission'
          ? (
              [
                ['allow', '访问该网站时允许'],
                ['allow_once', '仅限这一次'],
                ['block', '不允许'],
              ] as const
            ).map(([decision, label]) => (
              <Button
                fullWidth
                variant="outlined"
                key={decision}
                disabled={busy}
                onClick={() => void reply({ kind: 'permission', decision })}
              >
                {label}
              </Button>
            ))
          : ([true, false] as const).map((accept) => (
              <Button
                fullWidth
                variant="outlined"
                key={String(accept)}
                disabled={busy}
                onClick={() => void reply({ kind: 'protocol_handler', accept, remember: true })}
              >
                {accept ? '允许' : '阻止'}
              </Button>
            ))}
      </Box>
    </Paper>
  );
}
