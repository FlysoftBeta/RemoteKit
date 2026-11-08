import './browser-settings.css';
import { Close, DeleteOutline, StarBorder } from '@mui/icons-material';
import {
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Tooltip,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import { SEARCH_ENGINES, type ProductState, type SearchEngine } from '../../shared/product';
import type { Action } from './product-dialogs';
import type { WorkspaceCall } from './window-state';
import { SettingNote, SettingRow, SettingSection, SettingSwitch } from './setting-layout';
import { ScaledSelect } from './scaled-select';
import { formatError } from '../util/format-error';

const SITE_OPTIONS = [
  ['tabletUa', '平板版网站'],
  ['manualKeyboard', '不自动弹出键盘'],
] as const;

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
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [clearing, setClearing] = useState(false);
  const run = (command: Parameters<Action>[0]) =>
    void action(command).catch((error) => setNote({ text: formatError(error), error: true }));
  const { browser } = state.workspace.settings;
  const sites = Object.entries(state.workspace.sites).filter(
    ([, preference]) => preference.tabletUa || preference.manualKeyboard,
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
        <SettingSection title="性能">
          <SettingSwitch
            title="Memory Saver"
            description="不在屏幕上的网页一段时间后释放内存，回来时自动恢复"
            checked={browser.memorySaverEnabled}
            disabled={!online}
            onChange={(memorySaverEnabled) =>
              run({ type: 'settings.update', settings: { browser: { memorySaverEnabled } } })
            }
          />
        </SettingSection>
        <SettingSection title="网页兼容性">
          {sites.map(([origin, preference]) => (
            <div key={origin} className="site-row">
              <Typography className="site-row-origin" noWrap title={origin}>
                {origin.replace(/^https?:\/\//, '')}
              </Typography>
              <div className="site-row-options">
                {SITE_OPTIONS.map(([key, label]) => (
                  <Chip
                    key={key}
                    size="small"
                    label={label}
                    color={preference[key] ? 'primary' : 'default'}
                    variant={preference[key] ? 'filled' : 'outlined'}
                    disabled={!online || (key === 'tabletUa' && !state.integrations.siteUa)}
                    onClick={() =>
                      run({ type: 'site.set', origin, [key]: !preference[key] } as Parameters<Action>[0])
                    }
                  />
                ))}
              </div>
              <Tooltip title="移除">
                <span>
                  <IconButton
                    size="small"
                    aria-label={`移除 ${origin} 的设置`}
                    disabled={!online}
                    onClick={() => run({ type: 'site.set', origin, tabletUa: false, manualKeyboard: false })}
                  >
                    <DeleteOutline fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </div>
          ))}
          {!sites.length && (
            <Typography variant="body2" color="text.secondary">
              在网页的更多菜单 › 网页兼容性中为单个网站调整
            </Typography>
          )}
        </SettingSection>
        <SettingSection title="收藏">
          {state.workspace.favorites.map((favorite) => (
            <div className="favorite-row" key={favorite.id}>
              <div>
                <Typography noWrap title={favorite.title}>
                  {favorite.title || favorite.url}
                </Typography>
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
        {note && <SettingNote text={note.text} error={note.error} />}
      </DialogContent>
      <Dialog open={clearing} onClose={() => setClearing(false)}>
        <DialogTitle>清除浏览记录？</DialogTitle>
        <DialogActions>
          <Button onClick={() => setClearing(false)}>取消</Button>
          <Button
            color="error"
            onClick={() => {
              setClearing(false);
              void call('usage.clear', { scope: 'pages' })
                .then(() => setNote({ text: '已清除浏览记录', error: false }))
                .catch((error) => setNote({ text: formatError(error), error: true }));
            }}
          >
            清除
          </Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  );
}
