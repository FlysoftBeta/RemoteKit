import { Close } from '@mui/icons-material';
import { Button, Dialog, DialogContent, DialogTitle, IconButton, Typography } from '@mui/material';
import { useState } from 'react';
import { SEARCH_ENGINES, type ProductState, type SearchEngine } from '../../shared/product';
import type { Action } from './product-dialogs';
import type { WorkspaceCall } from './window-state';
import { SiteCompatibility } from './app-editor';
import { SettingSection, SettingSwitch } from './setting-layout';
import { ScaledSelect } from './scaled-select';
import { formatError } from '../util/format-error';

export function BrowserSettingsSheet({
  state,
  action,
  call,
  online,
  onClose,
}: {
  state: ProductState;
  action: Action;
  call: WorkspaceCall;
  online: boolean;
  onClose(): void;
}) {
  const [message, setMessage] = useState('');
  const run = (command: Parameters<Action>[0]) =>
    void action(command).catch((error) => setMessage(formatError(error)));
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
            value={state.workspace.settings.browser.searchEngine}
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
        <SettingSection title="内存">
          <SettingSwitch
            title="Memory Saver"
            checked={state.workspace.settings.browser.memorySaverEnabled}
            disabled={!online}
            onChange={(memorySaverEnabled) =>
              run({ type: 'settings.update', settings: { browser: { memorySaverEnabled } } })
            }
          />
        </SettingSection>
        <SettingSection title="网页兼容性">
          {Object.entries(state.workspace.sites).map(([origin]) => (
            <div key={origin} className="site-preference">
              <Typography variant="subtitle2">{origin}</Typography>
              <SiteCompatibility origin={origin} state={state} action={action} online={online} />
              <Button
                size="small"
                disabled={!online}
                onClick={() => run({ type: 'site.set', origin, tabletUa: false, manualKeyboard: false })}
              >
                移除
              </Button>
            </div>
          ))}
          {!Object.keys(state.workspace.sites).length && (
            <Typography color="text.secondary">没有站点偏好</Typography>
          )}
        </SettingSection>
        <SettingSection title="收藏">
          {state.workspace.favorites.map((favorite) => (
            <div className="favorite-row" key={favorite.id}>
              <div>
                <Typography>{favorite.title}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {favorite.url}
                </Typography>
              </div>
              <Button disabled={!online} onClick={() => run({ type: 'favorite.remove', id: favorite.id })}>
                删除
              </Button>
            </div>
          ))}
        </SettingSection>
        <Button
          disabled={!online}
          onClick={() =>
            void call('usage.clear', { scope: 'pages' })
              .then(() => setMessage('已清除浏览记录'))
              .catch((error) => setMessage(formatError(error)))
          }
        >
          清除浏览记录
        </Button>
        {message && <Typography role="status">{message}</Typography>}
      </DialogContent>
    </Dialog>
  );
}
