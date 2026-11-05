import React from 'react';
import { Box, Button, FormControlLabel, Switch, Typography } from '@mui/material';
import type { AudioChannels, AudioPlaybackState } from './audio-output';
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
  return (
    <Box role="group" aria-label="整个工作空间的声音" sx={{ px: 2, py: 0.5, maxWidth: '100%' }}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.5, minHeight: 44 }}>
        <Typography variant="body2" sx={{ mr: 0.5 }}>
          声音
        </Typography>
        <FormControlLabel
          sx={{ m: 0, minHeight: 44 }}
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
          sx={{ m: 0, minHeight: 44 }}
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
          disabled={!online || busy}
          sx={{
            minHeight: 44,
            minWidth: 48,
            bgcolor: !channels.left && !channels.right ? 'action.selected' : undefined,
          }}
          onClick={() => change({ left: false, right: false })}
        >
          不播放
        </Button>
      </Box>
      <Typography variant="caption" aria-live="polite" color={error ? 'error' : 'text.secondary'}>
        {error || (busy ? '正在保存…' : '')}
      </Typography>
      {(channels.left || channels.right) && playback === 'blocked' && (
        <Button size="small" onClick={resume}>
          点击开启声音
        </Button>
      )}
    </Box>
  );
}
