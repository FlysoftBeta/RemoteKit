import './start-page.css';
import { formatError } from '../util/format-error';
import { ArrowForward, Search } from '@mui/icons-material';
import type { Favorite } from '../../shared/product';
import { ButtonBase, IconButton, InputBase, Typography } from '@mui/material';
import { useRef, useState } from 'react';

export function StartPage({
  engineLabel,
  online,
  onSubmit,
  favorites,
}: {
  favorites: Favorite[];
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
                setError(`未能打开，请重试：${formatError(reason)}`);
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
        <div className="start-favorites">
          {favorites.map((favorite) => (
            <ButtonBase
              key={favorite.id}
              className="start-favorite"
              disabled={!online || busy}
              onClick={() => {
                setBusy(true);
                void onSubmit(favorite.url)
                  .catch((error) => setError(formatError(error)))
                  .finally(() => setBusy(false));
              }}
            >
              <span>★</span>
              <Typography variant="body2" noWrap>
                {favorite.title}
              </Typography>
            </ButtonBase>
          ))}
        </div>
        {error && (
          <Typography className="start-page-error" color="error" role="alert">
            {error}
          </Typography>
        )}
      </div>
    </div>
  );
}
