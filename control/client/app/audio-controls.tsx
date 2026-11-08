import './audio-controls.css';
import { VolumeOffOutlined, VolumeUpOutlined } from '@mui/icons-material';
import { Button, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import type { AudioChannels, AudioPlaybackState } from '../media/audio-output';

type Choice = 'left' | 'right' | 'none';

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
  const silent = !channels.left && !channels.right;
  const selected: Choice[] = silent
    ? ['none']
    : [...(channels.left ? ['left' as const] : []), ...(channels.right ? ['right' as const] : [])];
  const change = (next: Choice[]) => {
    if (busy || !online) return;
    // "none" was just picked when it is the newest entry; it clears both channels.
    const cleared = next[next.length - 1] === 'none' || next.length === 0;
    const value = cleared
      ? { left: false, right: false }
      : { left: next.includes('left'), right: next.includes('right') };
    if (value.left === channels.left && value.right === channels.right) return;
    if (value.left || value.right) resume();
    save(value);
  };
  const status = error;
  return (
    <div className="menu-audio">
      <div className="menu-audio-row">
        {silent ? (
          <VolumeOffOutlined fontSize="small" color="action" />
        ) : (
          <VolumeUpOutlined fontSize="small" color="action" />
        )}
        <ToggleButtonGroup
          size="small"
          color="primary"
          fullWidth
          aria-label="整个工作空间的声音"
          value={selected}
          disabled={!online || busy}
          onChange={(_, next: Choice[]) => change(next)}
        >
          <ToggleButton value="left">左声道</ToggleButton>
          <ToggleButton value="right">右声道</ToggleButton>
          <ToggleButton value="none">不播放</ToggleButton>
        </ToggleButtonGroup>
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
