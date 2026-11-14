import { ExpandMore } from '@mui/icons-material';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
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
import { RemoteKitError } from '../../shared/errors';
import type { AppDefinition, AppInspectResult, ProductState } from '../../shared/product';
import { failureError, FailureNote } from '../failures';
import { recoverRead as recover } from '../failures/recovery';
import './app-editor.css';
import type { Action } from './product-dialogs';
import { ScaledSelect } from './scaled-select';
import { SiteSettingsBody } from './site-settings';
import type { WorkspaceCall } from './window-state';

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
  const [error, setError] = useState<RemoteKitError | undefined>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    const abort = new AbortController();
    void recover(() => call('app.inspect', { tabId }), abort.signal, setError)
      .then((value) => {
        if (!disposed) {
          setValue(value);
          setError(undefined);
        }
      })
      .catch((error) => {
        if (!disposed) setError(failureError(error));
      });
    return () => {
      disposed = true;
      abort.abort();
    };
  }, [tabId, call]);
  let origin = '';
  try {
    const url = new URL(value?.startUrl ?? '');
    if (url.protocol === 'http:' || url.protocol === 'https:') origin = url.origin;
  } catch {
    origin = '网址格式无效';
  }
  return (
    <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>安装为 App</DialogTitle>
      <DialogContent className="install-content">
        {error && (
          <FailureNote error={error} context={{ operation: '安装应用', scope: 'surface', input: true }} />
        )}
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
                {origin && (
                  <>
                    <Typography variant="subtitle2" sx={{ mt: 2 }}>
                      网站设置 · {origin}
                    </Typography>
                    <SiteSettingsBody origin={origin} state={state} action={action} online tabId={tabId} />
                  </>
                )}
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
              .catch((error) => setError(failureError(error)))
              .finally(() => setBusy(false));
          }}
        >
          安装
        </Button>
      </DialogActions>
    </Dialog>
  );
}
