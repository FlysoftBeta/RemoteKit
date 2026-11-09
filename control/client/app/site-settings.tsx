import './site-settings.css';
import React, { useId, useState } from 'react';
import { Close } from '@mui/icons-material';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Select,
  Typography,
} from '@mui/material';
import { SITE_PERMISSIONS, type ProductAction, type ProductState } from '../../shared/product';
import { PERMISSION_LABELS, protocolName, siteHost } from './permission-prompt';
import type { Action } from './product-dialogs';
import { formatError } from '../util/format-error';
import { SettingSection, SettingSwitch } from './setting-layout';

interface SiteSettingsProps {
  origin: string;
  state: ProductState;
  action: Action;
  online: boolean;
  tabId?: string;
}

export function SiteSettings({ onClose, ...props }: SiteSettingsProps & { onClose(): void }) {
  return (
    <Dialog
      open
      maxWidth="xs"
      fullWidth
      onClose={onClose}
      slotProps={{ paper: { 'aria-label': '网站设置' } }}
    >
      <DialogTitle sx={{ overflowWrap: 'anywhere' }}>
        {siteHost(props.origin)}
        <Typography component="div" variant="body2" color="text.secondary">
          网站设置
        </Typography>
      </DialogTitle>
      <DialogContent>
        <SiteSettingsBody {...props} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}

export function SiteSettingsBody({
  origin,
  state,
  action,
  online,
  tabId,
  onClose,
}: SiteSettingsProps & { onClose?(): void }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const permissionId = useId();
  const site = state.workspace.sites[origin];
  const run = async (command: ProductAction) => {
    setBusy(true);
    setError('');
    try {
      await action(command);
    } catch (error) {
      setError(formatError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="site-settings-body">
      {error && <Alert severity="error">{error}</Alert>}
      <SettingSection title="兼容性">
        <SettingSwitch
          title="平板版网站"
          checked={!!site?.tabletUa}
          disabled={!online || busy || !origin || !state.integrations.siteUa}
          onChange={(tabletUa) => void run({ type: 'site.set', origin, tabId, tabletUa })}
        />
      </SettingSection>
      <SettingSection title="权限">
        {SITE_PERMISSIONS.map((permission) => {
          const { icon: Icon, label } = PERMISSION_LABELS[permission];
          return (
            <Box key={permission} className="site-settings-row">
              <Icon sx={{ fontSize: 20 }} />
              <Typography id={`${permissionId}-${permission}`}>{label}</Typography>
              <Select
                size="small"
                labelId={`${permissionId}-${permission}`}
                value={site?.permissions?.[permission] ?? 'ask'}
                disabled={busy || !online}
                onChange={(event) =>
                  void run({
                    type: 'site.permission',
                    origin,
                    permission,
                    setting: event.target.value as 'ask' | 'allow' | 'block',
                  })
                }
              >
                <MenuItem value="ask">询问</MenuItem>
                <MenuItem value="allow">允许</MenuItem>
                <MenuItem value="block">阻止</MenuItem>
              </Select>
            </Box>
          );
        })}
      </SettingSection>
      {!!site?.protocolHandlers?.length && (
        <SettingSection title="协议处理程序">
          {site.protocolHandlers.map((handler) => (
            <Box className="site-settings-row" key={handler.protocol}>
              <Typography>
                {protocolName(handler.protocol)} 链接 · {handler.allowed ? '已允许' : '已阻止'}
              </Typography>
              <IconButton
                aria-label={`移除 ${protocolName(handler.protocol)} 协议处理程序`}
                disabled={busy || !online}
                onClick={() =>
                  void run({ type: 'site.protocolHandler.remove', origin, protocol: handler.protocol })
                }
              >
                <Close fontSize="small" />
              </IconButton>
            </Box>
          ))}
        </SettingSection>
      )}
      <div className="site-settings-actions">
        <Button
          disabled={
            busy ||
            !online ||
            (!SITE_PERMISSIONS.some((permission) => site?.permissions?.[permission]) &&
              !site?.protocolHandlers?.length)
          }
          onClick={() => void run({ type: 'site.permissions.reset', origin })}
        >
          重置权限
        </Button>
        {onClose && (
          <Button disabled={busy} onClick={onClose}>
            完成
          </Button>
        )}
      </div>
    </div>
  );
}
