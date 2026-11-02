import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@mui/material";
import { RemoteTransport } from "./transport";
import { keyIdentity, mouseButtonModifiers } from "./keys";
import { StatsOverlay } from "./stats-overlay";
import { TouchInput, pointerSampleTime, type TouchPacket } from "./touch-input";
import { touchTerminalResult } from './touch-terminal';
import { momentumPosition, type MomentumPacket, type MomentumPlan } from './client-gestures';
import { EditingInput, EDITOR_SENTINEL } from './editing-input';
import { DeferredEditingInput, editableInputMode, editableOwner, sameEditableView, type EditableView } from './mobile-editing-state';
import { useViewportTransition } from './use-viewport-transition';
import type { Surface } from './types';
import {
  clientPointToDip,
  pointerPointToDip,
  surfacePixelScale,
  type PointerAction,
} from "./coordinates";

const modifiers = (event: {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}) =>
  Number(event.shiftKey) |
  (Number(event.ctrlKey) << 1) |
  (Number(event.altKey) << 2) |
  (Number(event.metaKey) << 3);

export function RemoteViewport({
  transport,
  viewId,
  overlay = false,
  onFocus,
}: {
  transport: RemoteTransport;
  viewId: string;
  overlay?: boolean;
  onFocus?: () => void;
}) {
  const [, render] = useState(0);
  useEffect(
    () => transport.subscribe(() => render((value) => value + 1)),
    [transport],
  );
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<HTMLElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const editing = useRef(new EditingInput());
  const deferredEditing = useRef(new DeferredEditingInput());
  const deferredEditingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [editingError, setEditingError] = useState<string>();
  const [inputRecoveryRequired, setInputRecoveryRequired] = useState(false);
  const mouseCapture = useRef<{
    pointerId: number;
    button: number;
    identity: string;
    x: number;
    y: number;
  } | null>(null);
  const heldKeys = useRef(new Map<string, Record<string, unknown>>());
  const touches = useRef(new TouchInput());
  const touchOwner = useRef<{ surface: Surface; identity: string; packet: TouchPacket } | undefined>(undefined);
  const momentumOwner = useRef<{ surface: Surface; identity: string; origin: number; frame?: number; packet: MomentumPacket } | undefined>(undefined);
  const cancelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const terminalTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keyboardOwner = useRef<string | undefined>(undefined);
  const surface = transport.layout?.views.find((view) => view.id === viewId);
  const layoutEpoch = transport.layout?.epoch,
    layoutGeneration = transport.layout?.generation;
  const [frameReady, setFrameReady] = useState(false);
  const editingIdentity = surface && transport.editingIdentity(surface);
  const remoteEditable = transport.mobileEditing.forView(surface);
  const remoteOwner = remoteEditable?.view ? editableOwner(remoteEditable.view) : undefined;
  const previousEditableOwner = useRef<string | undefined>(undefined);
  const previousEditableView = useRef<EditableView | undefined>(undefined);
  const suppressBlur = useRef(false);
  const resize = useViewportTransition(viewport, transport, viewId, surface, frameReady, editingIdentity);
  const resetEditor = () => { if (editor.current) { editor.current.value = EDITOR_SENTINEL; editor.current.setSelectionRange(1, 1); } };
  useEffect(() => {
    setFrameReady(false);
    if (!canvas.current) return;
    return transport.registerViewport(viewId, canvas.current, setFrameReady);
  }, [transport, viewId]);
  const send = (event: Record<string, unknown>) => {
    return !!(surface && (frameReady && !resize.waiting || event.type === 'touch' && event.action === 'cancel') && transport.sendInput(surface, event));
  };
  const editingDeliveryOwner = `${editingIdentity ?? ''}/${remoteOwner ?? 'keyboard-sink'}`;
  const sendEdit = (event: Record<string, unknown>) => {
    if (send(event)) return;
    const pending = deferredEditing.current.pending;
    if (editingIdentity && remoteOwner && (!frameReady || resize.waiting) && deferredEditing.current.enqueue(editingDeliveryOwner, event)) {
      if (!pending) {
        clearTimeout(deferredEditingTimer.current);
        deferredEditingTimer.current = setTimeout(() => {
          if (!deferredEditing.current.pending) return;
          deferredEditing.current.clear(); setEditingError('画面恢复超时，暂存键盘输入已取消，请重新输入。');
        }, 3000);
      }
      return;
    }
    deferredEditing.current.clear();
    setEditingError('键盘输入暂未送达，请等待画面恢复后重新输入。');
  };
  useLayoutEffect(() => {
    if (!frameReady || resize.waiting) return;
    clearTimeout(deferredEditingTimer.current);
    for (const event of deferredEditing.current.drain(editingDeliveryOwner)) {
      if (!send(event)) { setEditingError('键盘输入暂未送达，请重新输入。'); break; }
    }
  }, [frameReady, resize.waiting, editingDeliveryOwner]);
  const stopMomentum = () => {
    const owner = momentumOwner.current;
    if (!owner) return true;
    if (owner.frame !== undefined) cancelAnimationFrame(owner.frame);
    const current = transport.layout?.views.find(view => view.id === owner.surface.id);
    if (!current || transport.inputIdentity(current) !== owner.identity) { momentumOwner.current = undefined; return true; }
    const accepted = transport.sendInput(current, { ...owner.packet, action: 'cancel' });
    if (accepted) momentumOwner.current = undefined;
    else setInputRecoveryRequired(true);
    return accepted;
  };
  const startMomentum = (packet: TouchPacket, origin: number, plan: MomentumPlan) => {
    if (!surface) return;
    const owner = { surface: { ...surface }, identity: String(packet.inputIdentity), origin, frame: undefined as number | undefined, packet: { type: 'gesture', gestureMode: 'client-v1', sequenceId: packet.sequenceId, inputIdentity: packet.inputIdentity, action: 'momentum', sampleElapsedUs: plan.startElapsedUs, cumulativeX: 0, cumulativeY: 0 } as MomentumPacket };
    momentumOwner.current = owner;
    const tick = () => {
      if (momentumOwner.current !== owner) return;
      const current = transport.layout?.views.find(view => view.id === owner.surface.id);
      if (!current || transport.inputIdentity(current) !== owner.identity || document.hidden) { stopMomentum(); return; }
      const position = momentumPosition(plan, Math.round((performance.now() - origin) * 1000));
      owner.packet = { ...owner.packet, action: position.done ? 'momentumEnd' : 'momentum', sampleElapsedUs: Math.round(position.sampleElapsedUs), cumulativeX: position.cumulativeX, cumulativeY: position.cumulativeY };
      if (!transport.sendInput(current, owner.packet)) { stopMomentum(); return; }
      if (position.done) momentumOwner.current = undefined;
      else owner.frame = requestAnimationFrame(tick);
    };
    owner.frame = requestAnimationFrame(tick);
  };
  const waitTouchTerminal = (owner: NonNullable<typeof touchOwner.current>) => {
    clearTimeout(terminalTimer.current);
    terminalTimer.current = setTimeout(() => {
      if (touchOwner.current !== owner) return;
      // Missing native acceptance is an unresolved owner, never a successful
      // release. Stop new gestures until a reconnect/document invalidates it.
      setInputRecoveryRequired(true);
    }, 2000);
  };
  const cancelTouches = (rejectedTerminal = false) => {
    stopMomentum();
    const ids = touches.current.contactIds;
    const owner = touchOwner.current;
    const current = owner && transport.layout?.views.find(view => view.id === owner.surface.id);
    if (owner && (!current || transport.inputIdentity(current) !== owner.identity)) {
      clearTimeout(terminalTimer.current); touches.current.reset(); touchOwner.current = undefined;
      for (const id of ids) if (canvas.current?.hasPointerCapture(id)) canvas.current.releasePointerCapture(id);
      return;
    }
    const cancelled = touches.current.cancel() ?? (owner && (rejectedTerminal || owner.packet.action !== 'end' && owner.packet.action !== 'cancel') ? { ...owner.packet, action: 'cancel' as const, points: [], samples: undefined, gestures: owner.packet.gestureMode === 'client-v1' ? [] : undefined } : undefined);
    clearTimeout(cancelTimer.current);
    if (cancelled && owner) {
      const started = performance.now();
      const retry = () => {
        if (touchOwner.current !== owner) return;
        // Never re-label an old gesture with the new surface/document/lease.
        const current = transport.layout?.views.find(view => view.id === owner.surface.id);
        if (!current || transport.inputIdentity(current) !== owner.identity) { touches.current.reset(); touchOwner.current = undefined; return; }
        if (transport.sendInput(current, cancelled)) { owner.packet = cancelled; touches.current.accepted(cancelled); waitTouchTerminal(owner); return; }
        if (performance.now() - started < 250) cancelTimer.current = setTimeout(retry, 10);
        else setInputRecoveryRequired(true);
      };
      retry();
    }
    for (const id of ids) if (canvas.current?.hasPointerCapture(id)) canvas.current.releasePointerCapture(id);
  };
  const releaseInput = () => {
    const wasOwner = editing.current.matches(editingIdentity);
    for (const event of heldKeys.current.values())
      if (keyboardOwner.current === editingIdentity) send({ ...event, action: "up", repeat: false, text: '', unmodified_text: '' });
    heldKeys.current.clear();
    const held = mouseCapture.current;
    if (held) {
      if (held.identity === `${surface?.session}:${surface?.id}:${surface?.instance}:${surface?.document}:${layoutGeneration}:${layoutEpoch}`)
      send({
        type: "mouse",
        action: "up",
        x: held.x,
        y: held.y,
        button: held.button,
        modifiers: 0,
        click_count: 1,
      });
      if (canvas.current?.hasPointerCapture(held.pointerId))
        canvas.current.releasePointerCapture(held.pointerId);
      mouseCapture.current = null;
    }
    cancelTouches();
    if (editing.current.composing && editing.current.matches(editingIdentity)) send({ type: 'ime_cancel' });
    deferredEditing.current.clear(); editing.current.invalidate(); keyboardOwner.current = undefined; resetEditor();
    if (surface && wasOwner) transport.focus(surface, false);
  };
  const releaseRef = useRef(releaseInput);
  releaseRef.current = releaseInput;
  const cancelRef = useRef(cancelTouches); cancelRef.current = cancelTouches;
  useEffect(() => { cancelRef.current(); setInputRecoveryRequired(false); }, [layoutEpoch, layoutGeneration, editingIdentity]);
  useEffect(() => {
    if (!editing.current.matches(editingIdentity)) {
      deferredEditing.current.clear();
      editing.current.invalidate(); heldKeys.current.clear(); keyboardOwner.current = undefined; resetEditor();
      // An IME still owned by the previous document must not resume via a late end.
      editor.current?.blur();
    }
  }, [editingIdentity]);
  useEffect(() => {
    const previous = previousEditableOwner.current;
    const previousView = previousEditableView.current;
    previousEditableOwner.current = remoteOwner;
    previousEditableView.current = remoteEditable?.view ?? undefined;
    if (previous && previous !== remoteOwner) {
      deferredEditing.current.clear();
      if (editing.current.composing && editing.current.matches(editingIdentity) && surface && previousView && sameEditableView(surface, previousView)) send({ type: 'ime_cancel' });
      editing.current.invalidate(); heldKeys.current.clear(); keyboardOwner.current = undefined; resetEditor();
      suppressBlur.current = true; editor.current?.blur(); suppressBlur.current = false;
      if (!remoteOwner && frameReady && window.matchMedia('(pointer: fine)').matches && editor.current) {
        editor.current.inputMode = 'none';
        editor.current.focus({ preventScroll: true });
      }
    }
    if (remoteOwner && surface && editor.current) {
      editor.current.inputMode = editableInputMode(remoteEditable!.editable.type);
      editing.current.focus(transport.editingIdentity(surface));
      keyboardOwner.current = transport.editingIdentity(surface);
      // Mobile browsers may require another user activation; the explicit
      // compact keyboard button below always provides that activation.
      editor.current.focus({ preventScroll: true });
    }
  }, [remoteOwner, editingIdentity]);
  const resultRef = useRef((result: Parameters<Parameters<RemoteTransport['subscribeInputResults']>[0]>[0]) => {});
  resultRef.current = result => {
    const momentum = momentumOwner.current;
    if (momentum && result.event.type === 'gesture' && result.event.sequenceId === momentum.packet.sequenceId && !result.ok) stopMomentum();
    const owner = touchOwner.current;
    if (!owner || result.event.type !== 'touch' || result.event.sequenceId !== owner.packet.sequenceId) return;
    const current = transport.layout?.views.find(view => view.id === owner.surface.id);
    const terminal = touchTerminalResult(owner, result, current && transport.inputIdentity(current), touches.current.contactIds.length);
    if (terminal) {
      clearTimeout(terminalTimer.current); clearTimeout(cancelTimer.current);
      if (terminal === 'invalidated') {
        const ids = touches.current.contactIds;
        touches.current.reset();
        const momentum = momentumOwner.current;
        if (momentum?.identity === owner.identity && momentum.packet.sequenceId === owner.packet.sequenceId) {
          if (momentum.frame !== undefined) cancelAnimationFrame(momentum.frame);
          momentumOwner.current = undefined;
        }
        for (const id of ids) if (canvas.current?.hasPointerCapture(id)) canvas.current.releasePointerCapture(id);
      }
      touchOwner.current = undefined; setInputRecoveryRequired(false); return;
    }
    if (result.identity !== owner.identity || !current || transport.inputIdentity(current) !== owner.identity) return;
    if (!result.ok && result.event.action === 'cancel') {
      setInputRecoveryRequired(true);
    } else if (!result.ok) cancelTouches(true);
    else if (result.event === owner.packet && (result.event.action === 'cancel' || result.event.action === 'end' && !touches.current.contactIds.length)) { clearTimeout(terminalTimer.current); touchOwner.current = undefined; }
  };
  useEffect(() => transport.subscribeInputResults(result => resultRef.current(result)), [transport]);
  useEffect(() => {
    const blur = () => releaseRef.current();
    window.addEventListener("blur", blur);
    const visibility = () => { if (document.hidden) releaseRef.current(); };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener("blur", blur);
      document.removeEventListener('visibilitychange', visibility);
      releaseRef.current();
    };
  }, []);
  const point = (
    event: { clientX: number; clientY: number },
    action?: PointerAction,
    captured = false,
  ) => {
    if (!surface || !canvas.current) return null;
    const rect = canvas.current.getBoundingClientRect();
    return action
      ? pointerPointToDip(
          surface,
          rect,
          event.clientX,
          event.clientY,
          action,
          captured,
        )
      : clientPointToDip(surface, rect, event.clientX, event.clientY);
  };
  const pointer = (
    event: React.PointerEvent<HTMLCanvasElement>,
    action: PointerAction,
  ) => {
    if (event.pointerType === 'touch' && action === 'down' && !stopMomentum()) { event.preventDefault(); return; }
    const captured = event.currentTarget.hasPointerCapture(event.pointerId);
    if (event.pointerType === "touch" && action === "cancel") { cancelTouches(); return; }
    // Keep the previous sequence's recovery identity until Endpoint confirms
    // its terminal. A late rejection must not cancel a newer gesture instead.
    if (event.pointerType === 'touch' && action === 'down' && touchOwner.current && !touches.current.contactIds.length) { event.preventDefault(); return; }
    const identity = `${surface?.session}:${surface?.id}:${surface?.instance}:${surface?.document}:${layoutGeneration}:${layoutEpoch}`;
    const pressed =
      mouseCapture.current?.pointerId === event.pointerId &&
      mouseCapture.current.identity === identity
        ? mouseCapture.current
        : null;
    const release = () => {
      if (action !== "up" && action !== "cancel") return;
      if (captured) event.currentTarget.releasePointerCapture(event.pointerId);
      if (mouseCapture.current?.pointerId === event.pointerId)
        mouseCapture.current = null;
    };
    if (!surface || !frameReady || resize.waiting) {
      if (event.pointerType === "touch") cancelTouches();
      release();
      return;
    }
    // Leaving the canvas still needs a viewport point to clear remote hover.
    const position = point(event, action, captured || !!pressed);
    if (position) {
      if (action === "down") {
        event.preventDefault();
        transport.selectedViewId = viewId;
        onFocus?.();
        editing.current.focus(transport.editingIdentity(surface));
        keyboardOwner.current = transport.editingIdentity(surface);
        if (!editing.current.composing) resetEditor();
        if (event.pointerType !== 'touch' || remoteEditable) editor.current?.focus({ preventScroll: true });
        transport.ensureInputFocus(surface);
        event.currentTarget.setPointerCapture(event.pointerId);
        if (event.pointerType !== "touch")
          mouseCapture.current = {
            pointerId: event.pointerId,
            button: [1, 2, 3, 4, 5][event.button] ?? 0,
            identity,
            ...position,
          };
      }
      if (pressed) {
        pressed.x = position.x;
        pressed.y = position.y;
      }
      if (event.pointerType === "touch") {
        const touchIdentity = transport.inputIdentity(surface);
        if (!touches.current.matches(touchIdentity)) { cancelTouches(); release(); return; }
        const now = performance.now(), native = event.nativeEvent;
        const history = action === "move" && typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
        const samples = [...history.slice(-32), native];
        let previousTime = -Infinity;
        for (const sample of samples) {
          const at = pointerSampleTime(sample.timeStamp, now, performance.timeOrigin);
          if (at === undefined) { cancelTouches(); release(); return; }
          if (at <= previousTime) continue;
          previousTime = at;
          const p = point(sample, action, captured || action === "down");
          if (!p) continue;
          const invalid = touches.current.stats.invalidClock;
          const next = touches.current.sample(touchIdentity, action === "down" ? "start" : action === "up" ? "end" : "move", { id: event.pointerId, ...p, pressure: sample.pressure }, at, action === "down" ? transport.touchStartWall(at) : undefined, transport.clientGestures);
          if (next) {
            const owner = { surface: { ...surface }, identity: touchIdentity, packet: next };
            touchOwner.current = owner;
            if (!send(next)) { cancelTouches(); release(); return; }
            const plan = touches.current.takeMomentum();
            touches.current.accepted(next);
            if (next.action === 'end' && !touches.current.contactIds.length) {
              waitTouchTerminal(owner);
              if (plan) startMomentum(next, at - next.sampleElapsedUs / 1000, plan);
            }
          } else if (touches.current.stats.invalidClock !== invalid) { cancelTouches(); release(); return; }
        }
      } else if (action !== "cancel" || pressed)
        send({
          type: "mouse",
          action: action === "cancel" ? "up" : action,
          ...position,
          button:
            action === "cancel"
              ? pressed!.button
              : action === "move" || action === "leave"
                ? 0
                : ([1, 2, 3, 4, 5][event.button] ?? 0),
          modifiers: modifiers(event) | mouseButtonModifiers(event.buttons),
          click_count:
            action === "move" || action === "leave"
              ? 0
              : Math.min(3, Math.max(1, event.detail)),
        });
    }
    release();
  };
  const key = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    action: string,
  ) => {
    if (editing.current.composing || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (!editing.current.matches(editingIdentity)) return;
    if (
      event.key === "Tab" ||
      ['Enter', 'Backspace', 'Delete'].includes(event.key) ||
      event.ctrlKey ||
      event.metaKey ||
      event.key.startsWith("Arrow")
    )
      event.preventDefault();
    const value = {
      type: "key",
      action,
      ...keyIdentity(event.code, event.key),
      windows_key_code: event.keyCode,
      modifiers: modifiers(event),
      repeat: event.repeat,
      text: action === 'down' && event.key === 'Enter' ? '\r' : '',
      unmodified_text: action === 'down' && event.key === 'Enter' ? '\r' : '',
    };
    if (action === 'down') editing.current.physicalKey(event.key, performance.now());
    else editing.current.releasePhysicalKey(event.key);
    if (action === "down") heldKeys.current.set(event.code, value);
    else heldKeys.current.delete(event.code);
    sendEdit(value);
  };
  const wheelRef = useRef<(event: WheelEvent) => void>(() => {});
  wheelRef.current = (event) => {
    if (!surface || !frameReady || resize.waiting) return;
    const position = point(event);
    if (!position) return;
    // React's delegated wheel listener is passive. Prevent browser scrolling
    // with a native listener, and establish the same input lease as a click.
    event.preventDefault();
    transport.ensureInputFocus(surface);
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? surface.height / surfacePixelScale(surface) : 1;
    send({ type: 'wheel', ...position, dx: -event.deltaX * unit, dy: -event.deltaY * unit, modifiers: modifiers(event) });
  };
  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => wheelRef.current(event);
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, []);
  const editRef = useRef<(event: InputEvent, phase: 'before' | 'input') => void>(() => {});
  editRef.current = (event, phase) => {
    if (event.isComposing || editing.current.composing) return;
    const data = phase === 'input' && event.data === null && ['insertText', 'insertFromPaste', 'insertFromDictation'].includes(event.inputType)
      ? editor.current?.value.replace(EDITOR_SENTINEL, '') || null : event.data;
    const operation = editing.current.edit(editingIdentity, event.inputType, data, performance.now(), phase);
    const deferredText = data === null && ['insertText', 'insertFromPaste', 'insertFromDictation'].includes(event.inputType);
    if (phase === 'before' && event.cancelable && !deferredText) event.preventDefault();
    for (const value of operation.events) sendEdit(value);
    if (operation.unsupported) setEditingError(`当前键盘编辑操作尚不支持：${operation.unsupported}。请使用逐字输入或远端选区编辑。`);
    else if (operation.events.length) setEditingError(undefined);
    if (phase === 'input' || event.defaultPrevented) resetEditor();
  };
  useEffect(() => {
    const node = editor.current;
    if (!node) return;
    resetEditor();
    const before = (event: Event) => editRef.current(event as InputEvent, 'before');
    const input = (event: Event) => editRef.current(event as InputEvent, 'input');
    node.addEventListener('beforeinput', before);
    node.addEventListener('input', input);
    return () => { node.removeEventListener('beforeinput', before); node.removeEventListener('input', input); clearTimeout(cancelTimer.current); clearTimeout(terminalTimer.current); clearTimeout(deferredEditingTimer.current); deferredEditing.current.clear(); };
  }, []);
  return (
    <section ref={viewport} style={resize.style} className={`remote-viewport${resize.waiting ? ' resize-waiting' : ''}`} aria-label="远程页面">
      <canvas
        ref={canvas}
        aria-label={"远程页面画面"}
        className={frameReady && !resize.waiting ? "" : "no-frame"}
        onPointerDown={(event) => pointer(event, "down")}
        onPointerMove={(event) => pointer(event, "move")}
        onPointerUp={(event) => pointer(event, "up")}
        onPointerCancel={(event) => pointer(event, "cancel")}
        onLostPointerCapture={(event) => { if (event.pointerType === "touch" && touches.current.contactIds.includes(event.pointerId)) cancelTouches(); }}
        onPointerLeave={(event) => {
          if (event.pointerType !== "touch") pointer(event, "leave");
        }}
        onContextMenu={(event) => event.preventDefault()}
      />
      <textarea
        ref={editor}
        className="remote-input"
        aria-label="远程页面键盘输入"
        inputMode={remoteEditable ? editableInputMode(remoteEditable.editable.type) : 'none'}
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        onFocus={() => { if (surface && frameReady) { editing.current.focus(transport.editingIdentity(surface)); keyboardOwner.current = transport.editingIdentity(surface); resetEditor(); transport.ensureInputFocus(surface); } }}
        onBlur={() => { if (!suppressBlur.current) releaseInput(); }}
        onKeyDown={(event) => key(event, "down")}
        onKeyUp={(event) => key(event, "up")}
        onCompositionStart={() => { editing.current.start(editingIdentity); }}
        onCompositionUpdate={(event) => { const value = editing.current.update(editingIdentity, event.data); if (value) sendEdit(value); }}
        onCompositionEnd={(event) => {
          const value = editing.current.end(editingIdentity, event.data, performance.now());
          if (value) sendEdit(value);
          resetEditor();
        }}
      />
      {remoteEditable && <Button size="small" className="remote-open-keyboard" disabled={!frameReady || resize.waiting} onPointerDown={event => event.preventDefault()} onClick={() => { if (editor.current && surface) { editor.current.inputMode = editableInputMode(remoteEditable.editable.type); editor.current.focus({ preventScroll: true }); transport.ensureInputFocus(surface); } }}>打开键盘</Button>}
      {editingError && <div role="status" style={{ position: 'absolute', bottom: 8, left: 8, right: 8, background: '#222', color: '#fff', padding: 8, zIndex: 3 }} onClick={() => setEditingError(undefined)}>{editingError}</div>}
      {inputRecoveryRequired && <div className="page-overlay" role="status">触控结束尚未确认，请重新连接以恢复输入。<Button onClick={() => void transport.connect()}>重新连接</Button></div>}
      {(!frameReady || resize.waiting) && !resize.frozen && (
        <div className="page-overlay" role="status">
          {transport.diagnostics.connection === "已连接"
            ? "正在恢复页面…"
            : transport.diagnostics.connection === "连接失败"
              ? "画面连接中断"
              : "正在连接浏览器…"}
          {transport.diagnostics.connection === "连接失败" && (
            <Button onClick={() => void transport.connect()}>重新连接</Button>
          )}
        </div>
      )}
      {overlay && (
        <StatsOverlay diagnostics={transport.diagnostics} surface={surface} />
      )}
    </section>
  );
}
