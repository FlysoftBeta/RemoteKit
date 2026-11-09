import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { appClipboard } from '../clipboard/app-clipboard';
import { LocalInputTarget, inputOffsetAt, isTextInput } from './local-input';
import { LocalTextTarget } from './local-text';
import { SelectionUI } from './selection-ui';
import type { Point, SelectionTarget } from './target';
import { applyingSelection, selectionSession } from './selection-session';
import { diagnostics } from '../media/diagnostics';

function selectable(event: Event): HTMLElement | undefined {
  for (const node of event.composedPath()) {
    if (node instanceof HTMLElement && (node.hasAttribute('data-selectable') || isTextInput(node)))
      return node;
  }
}

export function LocalSelection() {
  const revision = useSyncExternalStore(selectionSession.subscribe, selectionSession.getSnapshot);
  const target = selectionSession.current();
  const close = selectionSession.hide;
  const dismiss = useCallback(() => {
    if (target) selectionSession.dismiss(target);
  }, [target]);
  useEffect(() => {
    let touch = false;
    let pressed: { node: HTMLElement; point: Point; id: number; fired: boolean } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let suppressClickUntil = 0;
    let suppressClickNode: HTMLElement | undefined;
    let lastTap: { node: HTMLElement; at: number; point: Point } | undefined;
    const cancel = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const select = (node: HTMLElement, point: Point) => {
      selectionSession.current()?.collapse();
      const value = isTextInput(node)
        ? new LocalInputTarget(node, appClipboard)
        : new LocalTextTarget(node, appClipboard);
      if (value.selectWord(point) !== false) selectionSession.show(value);
    };
    const down = (event: PointerEvent) => {
      touch = event.pointerType === 'touch';
      cancel();
      if (!touch || !event.isPrimary) return;
      const node = selectable(event);
      if (!node) return;
      const point = { x: event.clientX, y: event.clientY };
      const input = isTextInput(node) ? new LocalInputTarget(node, appClipboard) : undefined;
      pressed = { node, point, id: event.pointerId, fired: false };
      if (input) {
        selectionSession.current()?.collapse();
        event.preventDefault();
        const offset = inputOffsetAt(input.input, point);
        const previous = input.input.selectionStart;
        const focused = document.activeElement === node;
        input.input.focus({ preventScroll: true });
        input.input.setSelectionRange(offset, offset);
        if (focused && previous === offset) selectionSession.show(input);
      }
      timer = setTimeout(() => {
        if (!pressed) return;
        pressed.fired = true;
        suppressClickUntil = performance.now() + 1000;
        suppressClickNode = node;
        select(node, point);
      }, 500);
    };
    const move = (event: PointerEvent) => {
      if (
        pressed?.id === event.pointerId &&
        Math.hypot(event.clientX - pressed.point.x, event.clientY - pressed.point.y) > 10
      ) {
        cancel();
        pressed = undefined;
      }
    };
    const up = (event: PointerEvent) => {
      cancel();
      if (!pressed || pressed.id !== event.pointerId) return;
      if (!pressed.fired) {
        if (
          lastTap?.node === pressed.node &&
          performance.now() - lastTap.at < 350 &&
          Math.hypot(event.clientX - lastTap.point.x, event.clientY - lastTap.point.y) < 24
        ) {
          event.preventDefault();
          suppressClickUntil = performance.now() + 1000;
          suppressClickNode = pressed.node;
          select(pressed.node, pressed.point);
          lastTap = undefined;
        } else lastTap = { node: pressed.node, at: performance.now(), point: pressed.point };
      }
      pressed = undefined;
    };
    const context = (event: Event) => {
      event.preventDefault();
      if (!touch && selectable(event)) {
        const value = commandTarget(event, 'mouse');
        if (value) selectionSession.show(value);
      }
    };
    const selectStart = (event: Event) => {
      if (touch && !applyingSelection) event.preventDefault();
    };
    const click = (event: MouseEvent) => {
      if (
        performance.now() < suppressClickUntil &&
        suppressClickNode &&
        event.composedPath().includes(suppressClickNode)
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const touchEnd = (event: TouchEvent) => {
      if (
        performance.now() < suppressClickUntil &&
        suppressClickNode &&
        event.composedPath().includes(suppressClickNode)
      )
        event.preventDefault();
      touch = false;
    };
    const commandTarget = (event: Event, pointerType: 'touch' | 'mouse' = 'touch') => {
      const node = selectable(event);
      let value: SelectionTarget | undefined;
      if (node && isTextInput(node)) value = new LocalInputTarget(node, appClipboard, pointerType);
      else {
        let selection = document.getSelection();
        const shadow = selection?.anchorNode instanceof Element ? selection.anchorNode.shadowRoot : undefined;
        if (shadow && 'getSelection' in shadow)
          selection = (shadow as ShadowRoot & { getSelection(): Selection | null }).getSelection();
        const active = selectionSession.current();
        const content =
          node ??
          selection?.anchorNode?.parentElement?.closest<HTMLElement>('[data-selectable]') ??
          (active instanceof LocalTextTarget && active.alive() ? active.content : undefined);
        if (content) {
          const text = new LocalTextTarget(content, appClipboard, pointerType);
          text.adoptSelection();
          value = text;
        }
      }
      return value;
    };
    const run = (value: SelectionTarget, command: 'copy' | 'cut' | 'paste' | 'selectAll') => {
      void Promise.resolve(value.run(command)).catch((error: unknown) =>
        diagnostics.record('selection-command', error),
      );
    };
    const clipboard = (event: ClipboardEvent) => {
      const value = commandTarget(event);
      if (!value) return;
      event.preventDefault();
      run(value, event.type === 'paste' ? 'paste' : event.type === 'cut' ? 'cut' : 'copy');
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        const active = selectionSession.current();
        if (active) selectionSession.dismiss(active);
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const commands = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste' } as const;
      const command = commands[event.key.toLowerCase() as keyof typeof commands];
      if (!command) return;
      const value = commandTarget(event);
      if (!value) return;
      event.preventDefault();
      event.stopPropagation();
      run(value, command);
    };
    const reset = () => {
      cancel();
      pressed = undefined;
    };
    const markInputs = () => {
      document.querySelectorAll('input,textarea').forEach((node) => {
        if (isTextInput(node)) node.setAttribute('data-selectable', '');
      });
    };
    markInputs();
    const observer = new MutationObserver(markInputs);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('pointerdown', down, { capture: true, passive: false });
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', reset, true);
    document.addEventListener('contextmenu', context, true);
    document.addEventListener('selectstart', selectStart, true);
    document.addEventListener('click', click, true);
    document.addEventListener('touchend', touchEnd, { capture: true, passive: false });
    document.addEventListener('keydown', key, true);
    for (const type of ['copy', 'cut', 'paste'])
      document.addEventListener(type, clipboard as EventListener, true);
    return () => {
      reset();
      observer.disconnect();
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', reset, true);
      document.removeEventListener('contextmenu', context, true);
      document.removeEventListener('selectstart', selectStart, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('touchend', touchEnd, true);
      document.removeEventListener('keydown', key, true);
      for (const type of ['copy', 'cut', 'paste'])
        document.removeEventListener(type, clipboard as EventListener, true);
    };
  }, [close]);
  return target ? <SelectionUI target={target} changed={revision} close={close} dismiss={dismiss} /> : null;
}
