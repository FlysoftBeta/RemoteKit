import { Close, DeleteOutline, StarBorder } from '@mui/icons-material';
import {
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  ListItemButton,
  Tooltip,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import { SEARCH_ENGINES, SITE_PERMISSIONS, type ProductState, type SearchEngine } from '../../shared/product';
import { failureError, FailureNote } from '../failures';
import './browser-settings.css';
import { OverflowText } from './overflow-text';
import { siteHost } from './permission-prompt';
import type { Action } from './product-dialogs';
import { ScaledSelect } from './scaled-select';
import { SettingNote, SettingRow, SettingSection } from './setting-layout';
import { SiteSettings } from './site-settings';
import type { WorkspaceCall } from './window-state';

const SITE_OPTIONS = [['tabletUa', '平板版网站']] as const;

export function BrowserSettingsSheet({
  state,
  action,
  call,
  online,
  currentSite,
  onClose,
}: {
  state: ProductState;
  action: Action;
  call: WorkspaceCall;
  online: boolean;
  currentSite?: { origin: string; tabId: string };
  onClose(): void;
}) {
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<import('../../shared/errors').RemoteKitError>();
  const [clearing, setClearing] = useState(false);
  const [siteOrigin, setSiteOrigin] = useState<string>();
  const run = (command: Parameters<Action>[0]) =>
    void action(command).catch((error) => setFailure(failureError(error)));
  const { browser } = state.workspace.settings;
  const sites = Object.entries(state.workspace.sites)
    .map(([origin, preference]) => ({
      origin,
      preference,
      permissionCount: SITE_PERMISSIONS.filter((permission) => preference.permissions?.[permission]).length,
    }))
    .filter(
      ({ preference, permissionCount }) =>
        preference.tabletUa || permissionCount || preference.protocolHandlers?.length,
    );
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm" scroll="paper">
      <DialogTitle className="dialog-heading">
        浏览器设置
        <IconButton aria-label="关闭浏览器设置" onClick={onClose}>
          <Close />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers className="settings-content">
        <SettingSection title="搜索">
          <ScaledSelect
            label="默认搜索引擎"
            value={browser.searchEngine}
            options={SEARCH_ENGINES}
            disabled={!online}
            onChange={(searchEngine) =>
              run({
                type: 'settings.update',
                settings: { browser: { searchEngine: searchEngine as SearchEngine } },
              })
            }
          />
        </SettingSection>
        <SettingSection title="网站设置">
          {sites.map(({ origin, preference, permissionCount }) => (
            <ListItemButton
              key={origin}
              className="site-row site-settings-entry"
              onClick={() => setSiteOrigin(origin)}
            >
              <OverflowText className="site-row-origin" tip={origin}>
                {siteHost(origin)}
              </OverflowText>
              <div className="site-row-options">
                {SITE_OPTIONS.filter(([key]) => preference[key]).map(([key, label]) => (
                  <Chip key={key} size="small" label={label} />
                ))}
                {!!permissionCount && <Chip size="small" label={`${permissionCount} 项权限`} />}
                {!!preference.protocolHandlers?.length && (
                  <Chip size="small" label={`${preference.protocolHandlers.length} 个协议处理程序`} />
                )}
              </div>
            </ListItemButton>
          ))}
          <Typography variant="body2" color="text.secondary">
            在网页的更多菜单 › 网站设置中为单个网站调整
          </Typography>
        </SettingSection>
        <SettingSection title="收藏">
          {state.workspace.favorites.map((favorite) => (
            <div className="favorite-row" key={favorite.id}>
              <div>
                <OverflowText>{favorite.title || favorite.url}</OverflowText>
                <Typography variant="caption" color="text.secondary" noWrap component="div">
                  {favorite.url}
                </Typography>
              </div>
              <Tooltip title="取消收藏">
                <span>
                  <IconButton
                    size="small"
                    aria-label={`取消收藏 ${favorite.title}`}
                    disabled={!online}
                    onClick={() => run({ type: 'favorite.remove', id: favorite.id })}
                  >
                    <DeleteOutline fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </div>
          ))}
          {!state.workspace.favorites.length && (
            <Typography variant="body2" color="text.secondary" className="favorite-empty">
              <StarBorder fontSize="small" />
              点地址栏的星标收藏网页，收藏会优先出现在开始屏幕
            </Typography>
          )}
        </SettingSection>
        <SettingSection title="记录">
          <SettingRow title="清除浏览记录" description="开始屏幕会从头学习常用网页；收藏不受影响">
            <Button variant="outlined" color="error" disabled={!online} onClick={() => setClearing(true)}>
              清除
            </Button>
          </SettingRow>
        </SettingSection>
        <FailureNote error={failure} context={{ operation: '保存浏览器设置', scope: 'field' }} />
        {note && <SettingNote text={note} error={false} />}
      </DialogContent>
      {siteOrigin && (
        <SiteSettings
          origin={siteOrigin}
          tabId={currentSite?.origin === siteOrigin ? currentSite.tabId : undefined}
          state={state}
          action={action}
          online={online}
          onClose={() => setSiteOrigin(undefined)}
        />
      )}
      <Dialog open={clearing} onClose={() => setClearing(false)}>
        <DialogTitle>清除浏览记录？</DialogTitle>
        <DialogActions>
          <Button onClick={() => setClearing(false)}>取消</Button>
          <Button
            color="error"
            onClick={() => {
              setClearing(false);
              void call('usage.clear', { scope: 'pages' })
                .then(() => setNote('已清除浏览记录'))
                .catch((error) => setFailure(failureError(error)));
            }}
          >
            清除
          </Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  );
}
