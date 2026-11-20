import { Add, Remove } from '@mui/icons-material';
import { Button, FormControlLabel, IconButton, Radio, RadioGroup, Typography } from '@mui/material';
import { useState } from 'react';
import { RemoteKitError } from '../../shared/errors';
import type { ProductState, WorkspaceSettings } from '../../shared/product';
import { failureError, FailureNote } from '../failures';
import type { Action } from './product-dialogs';
import { SettingRow, SettingSection, SettingSwitch } from './setting-layout';
import { UI_SCALE_STEPS } from './ui-scale';
import './workspace-preferences.css';
import { useDevicePreferences, setCompatibility } from './device-preferences';
export function WorkspacePreferences({
  online,
  state,
  action,
  section,
}: {
  state: ProductState;
  online: boolean;
  action: Action;
  section: string;
}) {
  const settings = state.workspace.settings.workspace;
  const { compatibility } = useDevicePreferences();
  const [result, setResult] = useState<
      Record<string, import('../../shared/errors').RemoteKitError | undefined>
    >({}),
    [busy, setBusy] = useState<Record<string, boolean>>({});
  const save = async (key: string, value: Partial<WorkspaceSettings>) => {
    if (!online) return;
    setBusy((p) => ({ ...p, [key]: true }));
    setResult((p) => ({ ...p, [key]: undefined }));
    try {
      const receipt = await action({ type: 'settings.update', settings: { workspace: value } });
      // Progress lives in the Start sync indicator; a setting only reports what needs attention.
      setResult((p) => ({
        ...p,
        [key]: receipt.status === 'unknown' ? new RemoteKitError('outcome_unknown', '') : undefined,
      }));
    } catch (e) {
      setResult((p) => ({ ...p, [key]: failureError(e) }));
    } finally {
      setBusy((p) => ({ ...p, [key]: false }));
    }
  };
  const note = (key: string) => {
    const error = result[key];
    return <FailureNote error={error} context={{ operation: '保存此设置', scope: 'field', input: true }} />;
  };
  const scaleIndex = UI_SCALE_STEPS.findIndex((step) => step >= settings.uiScale - 0.001);
  const stepScale = (direction: 1 | -1) => {
    const index = scaleIndex < 0 ? UI_SCALE_STEPS.length - 1 : scaleIndex;
    const next = UI_SCALE_STEPS[Math.max(0, Math.min(UI_SCALE_STEPS.length - 1, index + direction))];
    if (next !== settings.uiScale) void save('scale', { uiScale: next });
  };
  return (
    <div className="settings-content">
      {section === 'appearance' && (
        <>
          {' '}
          <SettingSection title="显示">
            <SettingRow
              title="界面缩放"
              description="界面与网页内容一起缩放；画面始终按此设备的原生分辨率传输"
            >
              <IconButton
                aria-label="缩小"
                disabled={!online || busy.scale || settings.uiScale <= UI_SCALE_STEPS[0]}
                onClick={() => stepScale(-1)}
              >
                <Remove fontSize="small" />
              </IconButton>
              <Typography className="scale-value" aria-live="polite">
                {Math.round(settings.uiScale * 100)}%
              </Typography>
              <IconButton
                aria-label="放大"
                disabled={
                  !online || busy.scale || settings.uiScale >= UI_SCALE_STEPS[UI_SCALE_STEPS.length - 1]
                }
                onClick={() => stepScale(1)}
              >
                <Add fontSize="small" />
              </IconButton>
              <Button
                size="small"
                disabled={!online || busy.scale || settings.uiScale === 1}
                onClick={() => void save('scale', { uiScale: 1 })}
              >
                重置
              </Button>
            </SettingRow>
            {note('scale')}
            <SettingSwitch
              title="兼容模式"
              description="仅对此设备生效。顶部留出空白，上传文件时使用图片选择器。"
              checked={compatibility}
              onChange={setCompatibility}
            />
            <SettingSwitch
              title="减弱动态效果"
              checked={settings.reduceMotion}
              disabled={!online || busy.motion}
              onChange={(checked) => void save('motion', { reduceMotion: checked })}
            />
            {note('motion')}
          </SettingSection>
          <SettingSection title="全屏">
            {' '}
            <SettingSwitch
              title="打开或激活时全屏"
              checked={settings.autoFullscreen}
              disabled={!online || busy.fullscreen}
              onChange={(checked) => void save('fullscreen', { autoFullscreen: checked })}
            />
            {note('fullscreen')}
          </SettingSection>
        </>
      )}
      {section === 'input' && (
        <SettingSection title="输入">
          <SettingSwitch
            title="聚焦输入框时自动打开键盘"
            description="关闭时，点按输入框才会打开键盘"
            checked={settings.autoKeyboard}
            disabled={!online || busy.autoKeyboard}
            onChange={(autoKeyboard) => void save('autoKeyboard', { autoKeyboard })}
          />
          {note('autoKeyboard')}
          <SettingSwitch
            title="与本机剪贴板同步"
            checked={settings.clipboardSync}
            disabled={!online || busy.clipboardSync}
            onChange={(clipboardSync) => void save('clipboardSync', { clipboardSync })}
          />
          {note('clipboardSync')}
        </SettingSection>
      )}
      {section === 'media' && (
        <>
          {' '}
          <SettingSection title="画面">
            <RadioGroup
              aria-label="画面质量"
              value={settings.qualityPreference}
              onChange={(e) =>
                void save('quality', {
                  qualityPreference: e.target.value as WorkspaceSettings['qualityPreference'],
                })
              }
            >
              {(
                [
                  ['quality', '优先高画质', '尽量保留画面细节'],
                  ['auto', '自动', '平衡清晰度与响应速度'],
                  ['smooth', '优先流畅', '优先保持操作顺畅'],
                ] as const
              ).map(([value, title, detail]) => (
                <FormControlLabel
                  className="quality-option"
                  key={value}
                  value={value}
                  disabled={!online || busy.quality}
                  control={<Radio size="small" />}
                  label={
                    <>
                      <Typography>{title}</Typography>
                      <Typography variant="body2" color="text.secondary">
                        {detail}
                      </Typography>
                    </>
                  }
                />
              ))}
            </RadioGroup>
            {note('quality')}
            <SettingSwitch
              title="显示连接统计"
              description="在页面右上角叠加帧率、码率与延迟"
              checked={settings.showStats ?? false}
              disabled={!online || busy.stats}
              onChange={(checked) => void save('stats', { showStats: checked })}
            />
            {note('stats')}
          </SettingSection>
          <SettingSection title="声音">
            <SettingSwitch
              title="音视频同步"
              description="声音与画面对齐，画面延迟会增加；切换时重新建立媒体连接"
              checked={settings.avSync}
              disabled={!online || busy.avSync}
              onChange={(checked) => void save('avSync', { avSync: checked })}
            />
            {note('avSync')}
          </SettingSection>
        </>
      )}
    </div>
  );
}
