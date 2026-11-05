import { ArrowForward, Search } from '@mui/icons-material';
import { IconButton, InputBase, Typography } from '@mui/material';
import { useRef, useState } from 'react';

export function StartPage({
  engineLabel,
  online,
  onSubmit,
}: {
  engineLabel: string;
  online: boolean;
  onSubmit: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const composing = useRef(false),
    pending = useRef(false),
    input = useRef<HTMLInputElement>(null);
  return (
    <div className="start-page">
      <div className="start-page-body">
        <Typography component="h1" className="start-page-title">
          RemoteKit
        </Typography>
        <form
          className="start-page-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!online || pending.current || composing.current || !value.trim()) return;
            pending.current = true;
            setBusy(true);
            setError('');
            void onSubmit(value.trim())
              .catch((reason) => {
                setError(`未能打开，请重试：${reason instanceof Error ? reason.message : String(reason)}`);
                input.current?.focus();
              })
              .finally(() => {
                pending.current = false;
                setBusy(false);
              });
          }}
        >
          <Search color="action" />
          <InputBase
            inputRef={input}
            value={value}
            disabled={!online}
            readOnly={busy}
            placeholder="搜索或输入网址"
            inputProps={{ 'aria-label': '搜索或输入网址', autoComplete: 'off', spellCheck: false }}
            onChange={(event) => setValue(event.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)
              )
                event.preventDefault();
              if (event.key === 'Escape') {
                setValue('');
                setError('');
              }
            }}
          />
          <IconButton type="submit" aria-label="搜索或打开" disabled={!online || busy || !value.trim()}>
            <ArrowForward />
          </IconButton>
        </form>
        <Typography className="start-page-hint" color="text.secondary">
          使用 {engineLabel} 搜索 · 可在更多 → 设置中更改
        </Typography>
        {error && (
          <Typography className="start-page-error" color="error" role="alert">
            {error}
          </Typography>
        )}
      </div>
    </div>
  );
}
