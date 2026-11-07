import { VolumeOffOutlined, VolumeUpOutlined } from '@mui/icons-material';
import { Button, FormControlLabel, Switch, Typography } from '@mui/material';
import type { AudioChannels, AudioPlaybackState } from '../media/audio-output';
export function AudioControls({
  channels,
  online,
  playback,
  save,
  resume,
  busy,
  error,
}: {
  channels: AudioChannels;
  online: boolean;
  playback: AudioPlaybackState;
  save: (channels: AudioChannels) => void;
  resume: () => void;
  busy: boolean;
  error: string;
}) {
  const change = (next: AudioChannels) => {
    if (busy || !online) return;
    if (next.left || next.right) resume();
    save(next);
  };
  const silent = !channels.left && !channels.right;
  const status = error || (busy ? '正在保存…' : '');
  return (
    <div role="group" aria-label="整个工作空间的声音" className="menu-audio">
      <div className="menu-audio-row">
        {silent ? (
          <VolumeOffOutlined fontSize="small" color="action" />
        ) : (
          <VolumeUpOutlined fontSize="small" color="action" />
        )}
        <FormControlLabel
          className="menu-audio-channel"
          control={
            <Switch
              size="small"
              disabled={!online || busy}
              checked={channels.left}
              onChange={(_, left) => change({ ...channels, left })}
            />
          }
          label={<Typography variant="body2">左声道</Typography>}
        />
        <FormControlLabel
          className="menu-audio-channel"
          control={
            <Switch
              size="small"
              disabled={!online || busy}
              checked={channels.right}
              onChange={(_, right) => change({ ...channels, right })}
            />
          }
          label={<Typography variant="body2">右声道</Typography>}
        />
        <Button
          size="small"
          variant={silent ? 'contained' : 'outlined'}
          color={silent ? 'primary' : 'inherit'}
          aria-pressed={silent}
          disabled={!online || busy}
          className="menu-audio-mute"
          onClick={() => change({ left: false, right: false })}
        >
          不播放
        </Button>
      </div>
      <Typography
        variant="caption"
        aria-live="polite"
        color={error ? 'error' : 'text.secondary'}
        className="menu-audio-status"
      >
        {status}
      </Typography>
      {!silent && playback === 'blocked' && (
        <Button size="small" startIcon={<VolumeUpOutlined />} onClick={resume}>
          点击开启声音
        </Button>
      )}
    </div>
  );
}
