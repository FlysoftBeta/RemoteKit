import './security-settings.css';
import { LockOutlined } from '@mui/icons-material';
import { formatError } from '../util/format-error';
import { diagnostics } from '../media/diagnostics';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import React, { useEffect, useRef, useState } from 'react';
import type { AuthSettings, AuthState } from '../../shared/security';
import type { AuthCamera, AuthRequest } from './auth-camera';
import type { useAutoLock } from './auth-idle';
import { SettingRow, SettingSection, SettingSwitch } from '../app/setting-layout';

type Change = 'password' | 'pin' | 'removePin' | 'enroll' | 'removeFace' | 'policy';
const titles: Record<Change, string> = {
  password: '更改账户密码',
  pin: '设置 PIN',
  removePin: '删除 PIN',
  enroll: '录入人脸',
  removeFace: '删除人脸',
  policy: '保存自动锁定和人脸设置',
};

function CameraPreview({ stream }: { stream?: MediaStream }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.srcObject = stream ?? null;
    if (stream) void element.play().catch((error) => diagnostics.record('security-settings', error));
    return () => {
      element.srcObject = null;
    };
  }, [stream]);
  return stream ? (
    <video
      ref={video}
      autoPlay
      muted
      playsInline
      disablePictureInPicture
      className="auth-camera-preview"
      aria-label="摄像头预览"
    />
  ) : null;
}

export function SecuritySettings({
  auth,
  online,
  request,
  camera,
  idle,
  lock,
}: {
  auth: AuthState;
  online: boolean;
  request: AuthRequest;
  camera: AuthCamera;
  idle: ReturnType<typeof useAutoLock>;
  lock: () => void;
}) {
  const [change, setChange] = useState<Change>();
  const [currentPassword, setCurrentPassword] = useState('');
  const [replacement, setReplacement] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [policy, setPolicy] = useState<Partial<AuthSettings>>({});
  const [seconds, setSeconds] = useState(String(auth.settings.idleSeconds));
  const [enrollmentStarted, setEnrollmentStarted] = useState(false);
  const settings = { ...auth.settings, ...policy };
  const enrolled = auth.face.enrolled;
  const pin = change === 'pin';
  const validIdle =
    Number.isInteger(settings.idleSeconds) && settings.idleSeconds >= 15 && settings.idleSeconds <= 3600;
  const close = () => {
    if (change === 'enroll' && camera.explicit === 'enroll') camera.cancel();
    setChange(undefined);
    setCurrentPassword('');
    setReplacement('');
    setConfirmation('');
    setError('');
    setBusy(false);
    setEnrollmentStarted(false);
  };
  useEffect(() => {
    if (change !== 'enroll') return;
    return () => {
      if (camera.explicit === 'enroll') camera.cancel();
    };
  }, [camera.cancel, camera.explicit, change]);
  useEffect(() => {
    if (
      change === 'enroll' &&
      enrollmentStarted &&
      auth.face.purpose === 'enroll' &&
      auth.face.status === 'enrolled'
    ) {
      close();
      setNotice('人脸已录入。');
    }
  }, [auth.face.purpose, auth.face.status, change, enrollmentStarted]);
  useEffect(() => {
    if (policy.idleSeconds === undefined) setSeconds(String(auth.settings.idleSeconds));
  }, [auth.settings.idleSeconds, policy.idleSeconds]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!online || !change || busy) return;
    if ((change === 'pin' || change === 'password') && replacement !== confirmation) {
      setError('两次输入不一致。');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      switch (change) {
        case 'password':
          await request('auth.password', { currentPassword, newPassword: replacement });
          break;
        case 'pin':
          await request('auth.settings', { currentPassword, pin: replacement });
          break;
        case 'removePin':
          await request('auth.settings', { currentPassword, pin: null });
          break;
        case 'policy':
          await request('auth.settings', { currentPassword, settings: policy });
          setPolicy({});
          break;
        case 'removeFace':
          await request('auth.face.remove', { currentPassword });
          break;
        case 'enroll':
          await camera.start('enroll', currentPassword);
          setCurrentPassword('');
          setEnrollmentStarted(true);
          return;
      }
      close();
      setNotice('已保存。');
    } catch (failure) {
      setError(formatError(failure));
      setEnrollmentStarted(false);
    } finally {
      setBusy(false);
    }
  };
  const setSwitch = (
    key: 'faceEnabled' | 'lockOnDeparture' | 'lockOnHidden' | 'lockOnIdle',
    value: boolean,
  ) => {
    setPolicy((previous) => ({
      ...previous,
      [key]: value,
      ...(key === 'faceEnabled' && !value ? { lockOnDeparture: false } : {}),
    }));
  };
  const enrollmentStatus = enrollmentStarted && auth.face.purpose === 'enroll' ? auth.face.status : undefined;
  return (
    <>
      <SettingSection
        title="安全"
        action={
          <Button size="small" startIcon={<LockOutlined />} disabled={!online} onClick={lock}>
            立即锁定
          </Button>
        }
      >
        <SettingRow title="账户密码">
          <Button disabled={!online} onClick={() => setChange('password')}>
            更改
          </Button>
        </SettingRow>
        <SettingRow title="PIN" description={auth.methods.pin ? '已设置' : '未设置'}>
          <Button disabled={!online} onClick={() => setChange('pin')}>
            {auth.methods.pin ? '修改' : '设置'}
          </Button>
          {auth.methods.pin && (
            <Button color="inherit" disabled={!online} onClick={() => setChange('removePin')}>
              删除
            </Button>
          )}
        </SettingRow>
        <SettingRow
          title="人脸"
          description={auth.face.available ? (enrolled ? '已录入' : '未录入') : '当前服务无法进行人脸验证'}
        >
          <Button disabled={!online || !auth.face.available} onClick={() => setChange('enroll')}>
            {enrolled ? '重新录入' : '录入'}
          </Button>
          {enrolled && (
            <Button color="inherit" disabled={!online} onClick={() => setChange('removeFace')}>
              删除
            </Button>
          )}
        </SettingRow>
        <SettingSwitch
          title="启用人脸验证"
          description={enrolled ? undefined : '录入人脸后可用'}
          checked={settings.faceEnabled}
          disabled={!online || !enrolled}
          onChange={(checked) => setSwitch('faceEnabled', checked)}
        />
      </SettingSection>
      <SettingSection title="自动锁定">
        <SettingSwitch
          title="无操作时锁定"
          description={idle.system ? '已启用系统锁定和闲置检测' : '使用此页面的活动判断闲置'}
          checked={settings.lockOnIdle}
          disabled={!online}
          onChange={(checked) => setSwitch('lockOnIdle', checked)}
        />
        <div className="setting-indent">
          <TextField
            type="number"
            size="small"
            label="无操作时长（秒）"
            sx={{ width: 180 }}
            value={seconds}
            disabled={!online || !settings.lockOnIdle}
            slotProps={{ htmlInput: { min: 15, max: 3600 } }}
            error={!validIdle}
            helperText={!validIdle ? '请输入 15–3600 秒。' : undefined}
            onChange={(event) => {
              const value = event.target.value;
              setSeconds(value);
              setPolicy((previous) => ({ ...previous, idleSeconds: value === '' ? NaN : Number(value) }));
            }}
          />
          {idle.systemSupported && !idle.system && (
            <Button
              size="small"
              disabled={!online}
              onClick={() => {
                void idle.requestSystem().catch(() => setNotice('无法启用系统锁定检测。'));
              }}
            >
              授权系统锁定检测
            </Button>
          )}
        </div>
        <SettingSwitch
          title="切到后台时锁定"
          checked={settings.lockOnHidden}
          disabled={!online}
          onChange={(checked) => setSwitch('lockOnHidden', checked)}
        />
        <SettingSwitch
          title="离开摄像头时锁定"
          description={settings.faceEnabled ? undefined : '启用人脸验证后可用'}
          checked={settings.lockOnDeparture}
          disabled={!online || !settings.faceEnabled}
          onChange={(checked) => setSwitch('lockOnDeparture', checked)}
        />
        <div className="setting-actions">
          {notice && (
            <Typography variant="body2" color="text.secondary" role="status">
              {notice}
            </Typography>
          )}
          <Button
            variant="contained"
            disabled={!online || !Object.keys(policy).length || !validIdle}
            onClick={() => setChange('policy')}
          >
            保存安全设置
          </Button>
        </div>
      </SettingSection>
      {change && (
        <Dialog open onClose={close} fullWidth maxWidth="xs">
          <form onSubmit={submit}>
            <DialogTitle>{titles[change]}</DialogTitle>
            <DialogContent>
              <Stack spacing={2} sx={{ pt: 1 }}>
                {change === 'enroll' && (
                  <>
                    <Typography color="text.secondary">
                      摄像头画面通过当前连接发送给验证服务。请正对摄像头完成录入。
                    </Typography>
                    {camera.explicit === 'enroll' && <CameraPreview stream={camera.stream} />}
                    {enrollmentStatus && (
                      <Typography role="status">
                        {enrollmentStatus === 'pending'
                          ? '正在录入，请正对摄像头。'
                          : enrollmentStatus === 'expired'
                            ? '录入已超时，请重试。'
                            : enrollmentStatus === 'failed' || enrollmentStatus === 'absent'
                              ? '录入失败，请重试。'
                              : '录入已完成。'}
                      </Typography>
                    )}
                  </>
                )}
                {enrollmentStatus !== 'pending' && (
                  <TextField
                    autoFocus
                    fullWidth
                    required
                    type="password"
                    label="当前账户密码"
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                  />
                )}
                {(change === 'pin' || change === 'password') && (
                  <>
                    <TextField
                      required
                      type="password"
                      label={pin ? '新 PIN（6–12 位数字）' : '新账户密码'}
                      value={replacement}
                      autoComplete={pin ? 'off' : 'new-password'}
                      slotProps={{
                        htmlInput: pin ? { inputMode: 'numeric', pattern: '[0-9]{6,12}', maxLength: 12 } : {},
                      }}
                      onChange={(event) => setReplacement(event.target.value)}
                    />
                    <TextField
                      required
                      type="password"
                      label={pin ? '确认新 PIN' : '确认新密码'}
                      value={confirmation}
                      autoComplete={pin ? 'off' : 'new-password'}
                      slotProps={{
                        htmlInput: pin ? { inputMode: 'numeric', pattern: '[0-9]{6,12}', maxLength: 12 } : {},
                      }}
                      onChange={(event) => setConfirmation(event.target.value)}
                    />
                  </>
                )}
                {error && <Alert severity="error">{error}</Alert>}
              </Stack>
            </DialogContent>
            <DialogActions>
              <Button onClick={close}>取消</Button>
              <Button
                type="submit"
                variant="contained"
                disabled={busy || !online || enrollmentStatus === 'pending'}
              >
                {busy ? '正在处理…' : change === 'enroll' ? '开启摄像头' : '确认'}
              </Button>
            </DialogActions>
          </form>
        </Dialog>
      )}
    </>
  );
}
