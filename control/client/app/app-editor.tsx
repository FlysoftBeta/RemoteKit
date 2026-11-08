import './app-editor.css';
import { ExpandMore } from '@mui/icons-material';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Avatar,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';
import type { AppDefinition, AppInspectResult, ProductState } from '../../shared/product';
import type { Action } from './product-dialogs';
import type { WorkspaceCall } from './window-state';
import { SettingSwitch } from './setting-layout';
import { ScaledSelect } from './scaled-select';
import { formatError } from '../util/format-error';

export function SiteCompatibility({
  origin,
  state,
  action,
  online,
  tabId,
}: {
  origin: string;
  state: ProductState;
  action: Action;
  online: boolean;
  tabId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div>
      {(['tabletUa', 'manualKeyboard'] as const).map((key) => (
        <SettingSwitch
          key={key}
          title={key === 'tabletUa' ? '使用平板版网站' : '不自动弹出键盘'}
          checked={!!state.workspace.sites[origin]?.[key]}
          disabled={!online || busy || !origin || (key === 'tabletUa' && !state.integrations.siteUa)}
          onChange={(value) => {
            setBusy(true);
            setError('');
            void action({ type: 'site.set', origin, tabId, ...{ [key]: value } } as Parameters<Action>[0])
              .catch((error) => setError(formatError(error)))
              .finally(() => setBusy(false));
          }}
        />
      ))}
      {error && <Alert severity="error">{error}</Alert>}
    </div>
  );
}

export function AppFields({
  value,
  onChange,
}: {
  value: AppDefinition;
  onChange(value: AppDefinition): void;
}) {
  return (
    <div className="app-fields">
      <TextField
        label="起始 URL"
        fullWidth
        value={value.startUrl}
        onChange={(e) => onChange({ ...value, startUrl: e.target.value })}
      />
      <TextField
        label="作用域"
        fullWidth
        value={value.scope ?? ''}
        onChange={(e) => onChange({ ...value, scope: e.target.value })}
      />
      <ScaledSelect
        label="显示方式"
        value={value.display ?? 'standalone'}
        options={[
          { value: 'standalone', label: '独立窗口' },
          { value: 'browser', label: '显示地址条' },
        ]}
        onChange={(display) => onChange({ ...value, display: display as AppDefinition['display'] })}
      />
      <div className="theme-color-field">
        <input
          aria-label="主题色拾色器"
          type="color"
          value={/^#[\da-f]{6}$/i.test(value.themeColor ?? '') ? value.themeColor : '#245db5'}
          onChange={(e) => onChange({ ...value, themeColor: e.target.value })}
        />
        <TextField
          label="主题色"
          value={value.themeColor ?? ''}
          placeholder="#245db5"
          error={!!value.themeColor && !/^#[\da-f]{6}$/i.test(value.themeColor)}
          onChange={(e) => onChange({ ...value, themeColor: e.target.value || undefined })}
        />
      </div>
    </div>
  );
}

export function InstallDialog({
  tabId,
  state,
  call,
  action,
  onClose,
}: {
  tabId: string;
  state: ProductState;
  call: WorkspaceCall;
  action: Action;
  onClose(): void;
}) {
  const [value, setValue] = useState<AppInspectResult>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    void call('app.inspect', { tabId })
      .then((value) => {
        if (!disposed) setValue(value);
      })
      .catch((error) => {
        if (!disposed) setError(formatError(error));
      });
    return () => {
      disposed = true;
    };
  }, [tabId, call]);
  let origin = '';
  try {
    origin = new URL(value?.startUrl ?? '').origin;
  } catch {
    /* Editable URL. */
  }
  return (
    <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>安装为 App</DialogTitle>
      <DialogContent className="install-content">
        {error && <Alert severity="error">{error}</Alert>}
        {!value ? (
          <Typography>正在读取网页信息…</Typography>
        ) : (
          <>
            <div className="install-name">
              <Avatar
                src={value.iconDataUrl}
                variant="rounded"
                sx={{ width: 64, height: 64, borderRadius: '14px' }}
              >
                {value.name.slice(0, 1)}
              </Avatar>
              <TextField
                label="名称"
                fullWidth
                value={value.name}
                onChange={(e) => setValue({ ...value, name: e.target.value })}
              />
            </div>
            <Accordion disableGutters elevation={0}>
              <AccordionSummary expandIcon={<ExpandMore />}>高级选项</AccordionSummary>
              <AccordionDetails>
                <AppFields value={value} onChange={(next) => setValue({ ...value, ...next })} />
                <Typography variant="subtitle2" sx={{ mt: 2 }}>
                  网页兼容性 · {origin}
                </Typography>
                <SiteCompatibility origin={origin} state={state} action={action} online tabId={tabId} />
              </AccordionDetails>
            </Accordion>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button
          variant="contained"
          disabled={!value || busy || !value.name.trim()}
          onClick={() => {
            if (!value) return;
            setBusy(true);
            const { iconDataUrl, ...definition } = value;
            void action({ type: 'app.install', ...definition })
              .then(onClose)
              .catch((error) => setError(formatError(error)))
              .finally(() => setBusy(false));
          }}
        >
          安装
        </Button>
      </DialogActions>
    </Dialog>
  );
}
