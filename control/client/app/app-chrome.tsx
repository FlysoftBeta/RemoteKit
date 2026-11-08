import './app-chrome.css';
import type React from 'react';
import { ArrowBack, MoreVert } from '@mui/icons-material';
import { Typography } from '@mui/material';
import type { ProductState, ProductTab, ProductWindow } from '../../shared/product';
import type { Action } from './product-dialogs';
import { AppIcon } from './app-icon';
import { Tool } from './window-tool';
export function AppChrome({
  win,
  active,
  app,
  title,
  origin,
  online,
  handle,
  run,
  openMore,
}: {
  win: ProductWindow;
  active?: ProductTab;
  app?: ProductState['workspace']['apps'][number];
  title: string;
  origin: string;
  online: boolean;
  handle: React.ReactNode;
  run(command: Parameters<Action>[0]): void;
  openMore(anchor: HTMLElement): void;
}) {
  return (
    <>
      <div className="app-title-bar">
        {handle}
        <span className="app-title-icon">
          <AppIcon appId={win.appId} iconUrl={app?.iconUrl} />
        </span>
        <Typography variant="subtitle2" noWrap sx={{ flex: 1 }}>
          {active?.title || title}
        </Typography>
        <Tool
          title="后退"
          disabled={!online || !active?.canGoBack}
          onClick={() => active && run({ type: 'tab.command', tabId: active.id, command: 'back' })}
        >
          <ArrowBack fontSize="small" />
        </Tool>
        <Tool title="更多" onClick={(e) => openMore(e.currentTarget)}>
          <MoreVert fontSize="small" />
        </Tool>
      </div>
      {(app?.display === 'browser' || (active?.url && !active.url.startsWith(app?.scope ?? ''))) && (
        <div className="app-origin-strip">{app?.display === 'browser' ? active?.url : origin}</div>
      )}
    </>
  );
}
