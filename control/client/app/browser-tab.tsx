import './browser-tab.css';
import { BedtimeOutlined, Close, Language } from '@mui/icons-material';
import { ButtonBase, CircularProgress, IconButton } from '@mui/material';
import React from 'react';
import type { ProductTab } from '../../shared/product';

// One tab of the tab strip: the selectable body is a ButtonBase (ripple, focus-visible, no native
// tap highlight) and the close control is an IconButton. Drag, ordering and commands stay with the
// owner; this component only renders a tab and reports intents.
export function BrowserTab({
  tab,
  selected,
  online,
  attention,
  dragSource,
  shift,
  onPointerDown,
  onContextMenu,
  onSelect,
  onClose,
  onKeyDown,
}: {
  tab: ProductTab;
  selected: boolean;
  online: boolean;
  attention: boolean;
  dragSource: boolean;
  shift: number;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onContextMenu: (anchor: HTMLElement) => void;
  onSelect: () => void;
  onClose: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const title = tab.title || '新标签页';
  return (
    <div
      className={`browser-tab${selected ? ' selected-tab' : ''}${dragSource ? ' tab-drag-source' : ''}`}
      data-tab-id={tab.id}
      style={{ transform: `translateX(${shift}px)` }}
      onPointerDown={onPointerDown}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.currentTarget);
      }}
    >
      <ButtonBase
        className="tab-select"
        role="tab"
        disabled={!online}
        tabIndex={selected ? 0 : -1}
        aria-selected={selected}
        onClick={onSelect}
        onKeyDown={onKeyDown}
      >
        <TabIcon tab={tab} />
        <span className="tab-title">{title}</span>
        {attention && <span className="tab-attention" aria-label="页面等待处理请求" />}
      </ButtonBase>
      <IconButton
        className="tab-close"
        aria-label={`关闭 ${tab.title || '标签页'}`}
        disabled={!online}
        onClick={onClose}
      >
        <Close fontSize="inherit" />
      </IconButton>
    </div>
  );
}

export function TabDragGhost({
  title,
  left,
  top,
  width,
}: {
  title: string;
  left: number;
  top: number;
  width: number;
}) {
  return (
    <div className="browser-tab selected-tab tab-drag-ghost" aria-hidden style={{ left, top, width }}>
      <span className="tab-select">
        <Language className="tab-icon" />
        <span className="tab-title">{title}</span>
      </span>
    </div>
  );
}

function TabIcon({ tab }: { tab: ProductTab }) {
  if (tab.loading) return <CircularProgress className="tab-icon" size={13} />;
  if (tab.residency && tab.residency !== 'live') return <BedtimeOutlined className="tab-icon" />;
  return <Language className="tab-icon" />;
}
