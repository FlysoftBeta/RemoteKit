import './context-menu.css';
import { Divider, Menu, MenuItem } from '@mui/material';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ProductTab, SearchEngine } from '../../shared/product';
import { sameEditingDocument } from '../editing/mobile-editing-state';
import type { Surface } from '../presentation/types';
import type { ContextMenu as RemoteMenu } from '../rtc/protocol';
import type { ViewerSession } from '../viewer-session';
import { ContextMenuInteraction, contextMenuItems } from './context-menu-items';
import { scaledAnchor, useUiScale } from './ui-scale';
import { projectRootRect, type ViewportGeometry } from './viewport-geometry';
import { clipboardCommand } from '../clipboard/device-clipboard';

export function ContextMenu({
  menu,
  surface,
  geometry,
  viewport,
  editor,
  transport,
  tab,
  engine,
  onClosed,
}: {
  menu: RemoteMenu;
  surface: Surface;
  geometry: ViewportGeometry;
  viewport: RefObject<HTMLElement | null>;
  editor: RefObject<HTMLTextAreaElement | null>;
  transport: ViewerSession;
  tab: ProductTab;
  engine: SearchEngine;
  onClosed(): void;
}) {
  const scale = useUiScale();
  const latest = useRef({ onClosed });
  latest.current = { onClosed };
  const [restoreEditor] = useState(() => document.activeElement === editor.current);
  const [interaction] = useState(
    () =>
      new ContextMenuInteraction({
        command: (command) =>
          clipboardCommand(command, () => {
            const current = command === 'dismiss' ? surface : transport.presentation.layout?.views.find((view) =>
              sameEditingDocument(view, surface),
            );
            if (!current) return;
            if (command !== 'dismiss') transport.input.ensureInputFocus(current);
            transport.input.sendInput(current, { type: 'context_command', menu: menu.id, command });
          }),
        product: (action) => {
          void transport.operations.action(action).catch(transport.workspace.report);
        },
        closed: () => latest.current.onClosed(),
      }),
  );
  useLayoutEffect(() => {
    const blur = () => interaction.close('blur');
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('blur', blur);
      const current = transport.editing.getSnapshot().contextMenu;
      interaction.close(current && current.menu?.id !== menu.id ? 'browser' : 'hidden');
      if (restoreEditor && (!current?.menu || current.menu.id === menu.id))
        queueMicrotask(() => {
          const currentSurface = transport.presentation.layout?.views.find((view) =>
            sameEditingDocument(view, surface),
          );
          if (editor.current?.isConnected && currentSurface) editor.current.focus({ preventScroll: true });
        });
    };
  }, [interaction, transport, menu.id, editor, restoreEditor]);
  const point = projectRootRect(surface, geometry, { x: menu.x, y: menu.y, width: 0, height: 0 });
  const section = viewport.current?.getBoundingClientRect();
  const position = {
    left: (section?.left ?? 0) / scale + point.left,
    top: (section?.top ?? 0) / scale + point.top + (menu.source === 'touch' ? 24 : 0),
  };
  return (
    <Menu
      open
      anchorEl={scaledAnchor(viewport.current)}
      anchorReference="anchorPosition"
      anchorPosition={position}
      transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      disableRestoreFocus
      onClose={(_event, reason) => interaction.close(reason === 'escapeKeyDown' ? 'escape' : 'outside')}
      onContextMenu={(event) => event.preventDefault()}
      slotProps={{
        paper: { className: 'page-context-menu' },
        list: { dense: true, 'aria-label': '页面菜单' },
      }}
    >
      {contextMenuItems(menu, tab, engine).flatMap((group, index) => [
        ...(index > 0 ? [<Divider key={`divider:${index}`} />] : []),
        ...group.map((item) => (
          <MenuItem
            key={`${index}:${item.label}`}
            disabled={item.disabled}
            onClick={() => interaction.choose(item)}
          >
            {item.label}
          </MenuItem>
        )),
      ])}
    </Menu>
  );
}
