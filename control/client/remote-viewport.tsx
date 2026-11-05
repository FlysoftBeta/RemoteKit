import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@mui/material";
import { KeyboardHideOutlined, KeyboardOutlined } from "@mui/icons-material";
import { RemoteTransport, type InputDelivery, type InputResult, type TouchRetireLease } from "./transport";
import { keyIdentity, mouseButtonModifiers } from "./keys";
import { StatsOverlay } from "./stats-overlay";
import { TouchInput, pointerSampleTime, type TouchPacket } from "./touch-input";
import { touchTerminalResult, type TouchOwner } from './touch-terminal';
import { momentumPosition, type MomentumPacket, type MomentumPlan } from './client-gestures';
import { EditingInput, EDITOR_SENTINEL } from './editing-input';
import { DeferredEditingInput, editableInputMode } from './mobile-editing-state';
import { KeyboardSession } from './keyboard-session';
import { useViewportTransition } from './use-viewport-transition';
import type { Surface } from './types';
import {
  clientPointToDip,
  pointerPointToDip,
  wheelDeltaToDip,
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

interface ViewportTouchOwner extends TouchOwner {
  start: TouchPacket;
  submissions: number;
  lease?: TouchRetireLease;
  retiring?: boolean;
  cleanupAttempts: number;
  terminal?: 'queued' | 'submitted' | 'accepted-pending' | 'unconfirmed' | 'cleanup';
}

const touchCleanupDelays = [100, 250, 500];

export function RemoteViewport({
  transport,
  viewId,
  overlay = false,
  keyboardActive = true,
  manualKeyboard = false,
  onFocus,
}: {
  transport: RemoteTransport;
  viewId: string;
  overlay?: boolean;
  keyboardActive?: boolean;
  manualKeyboard?: boolean;
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
  const [touchNotice, setTouchNotice] = useState<'confirming' | 'unconfirmed' | 'cleanup'>();
  const mouseCapture = useRef<{
    pointerId: number;
    button: number;
    identity: string;
    x: number;
    y: number;
  } | null>(null);
  const heldKeys = useRef(new Map<string, Record<string, unknown>>());
  const touches = useRef(new TouchInput());
  const touchOwner = useRef<ViewportTouchOwner | undefined>(undefined);
  const momentumOwner = useRef<{ surface: Surface; identity: string; origin: number; frame?: number; packet: MomentumPacket } | undefined>(undefined);
  const cancelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const restoreHardwareFocus = useRef<string | undefined>(undefined);
  const ackedEditingOwner = useRef<string | undefined>(undefined);
  const previousEditing = useRef<{ document?: string; owner?: string; transport: RemoteTransport }>(undefined);
  const keyboardTouch = useRef<{ pointer: number; x: number; y: number; at: number }>(undefined);
  const keyboardSession = useRef(new KeyboardSession());
  const [softInputFocused, setSoftInputFocused] = useState(false);
  const [, keyboardTick] = useState(0);
  const surface = transport.layout?.views.find((view) => view.id === viewId);
  const inputIdentity = surface && transport.inputIdentity(surface);
  const layoutEpoch = transport.layout?.epoch,
    layoutGeneration = transport.layout?.generation;
  const [frameReady, setFrameReady] = useState(false);
  const editingSurface = transport.editingSurface(viewId);
  const editingIdentity = editingSurface && transport.editingIdentity(editingSurface);
  const keyboardEnabled = keyboardActive && !!editingIdentity;
  const remoteEditable = transport.mobileEditing.forKeyboard(editingSurface);
  const strictEditable = transport.mobileEditing.forView(surface);
  const editableTarget = remoteEditable?.editable.target;
  const observedOwner = editableTarget && editingIdentity ? `${editingIdentity}/${editableTarget}` : undefined;
  const editableReady = !!strictEditable && strictEditable.editable.target === editableTarget;
  // A known editor may buffer through a layout barrier. A different candidate
  // can keep the local keyboard visible, but cannot acquire input before ACK.
  const remoteOwner = keyboardEnabled && observedOwner && (editableReady || observedOwner === ackedEditingOwner.current)
    ? observedOwner : undefined;
  const editorOwner = remoteOwner ?? (keyboardEnabled && !remoteEditable && !softInputFocused ? editingIdentity : undefined);
  const suppressBlur = useRef(false);
  const resize = useViewportTransition(viewport, transport, viewId, surface, frameReady, editingIdentity, editor);
  const keyboardReady = keyboardEnabled && !!surface && frameReady && !resize.waiting && editableReady;
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const keyboardShown = keyboardSession.current.shown(softInputFocused, resize.keyboardOpen, coarsePointer);
  const candidateDeadline = transport.mobileEditing.keyboardCandidateDeadline(editingSurface);
  const currentEditTarget = () => {
    const current = transport.editingSurface(viewId);
    if (!current || transport.editingIdentity(current) !== editingIdentity) return undefined;
    return transport.mobileEditing.forKeyboard(current)?.editable.target;
  };
  const resetEditor = () => { if (editor.current) { editor.current.value = EDITOR_SENTINEL; editor.current.setSelectionRange(1, 1); } };
  useEffect(() => {
    setFrameReady(false);
    if (!canvas.current) return;
    return transport.registerViewport(viewId, canvas.current, setFrameReady);
  }, [transport, viewId]);
  const send = (event: Record<string, unknown>, options?: { touchTerminal: boolean }) => {
    return !!(surface && (frameReady && !resize.blocksInput() || event.type === 'touch' && event.action === 'cancel') && transport.sendInput(surface, event, options));
  };
  const withEditTarget = (event: Record<string, unknown>) =>
    editableTarget ? { ...event, editableTarget } : event;
  const sendEdit = (event: Record<string, unknown>) => {
    const target = currentEditTarget();
    if (!keyboardEnabled || !editing.current.matches(editorOwner) ||
        (remoteOwner ? target !== editableTarget : target !== undefined || event.type !== 'key')) return;
    const value = withEditTarget(event);
    const waiting = !frameReady || resize.blocksInput() || !!remoteOwner && !editableReady;
    if (!waiting && send(value)) return;
    const pending = deferredEditing.current.pending;
    if (remoteOwner && waiting && deferredEditing.current.enqueue(remoteOwner, value)) {
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
  const finishLocalEditing = () => {
    if (editing.current.matches(editorOwner)) {
      for (const event of heldKeys.current.values())
        sendEdit({ ...event, action: 'up', repeat: false, text: '', unmodified_text: '' });
      const composition = editing.current.finishCurrent(editorOwner, performance.now());
      if (composition) sendEdit(composition);
    }
    heldKeys.current.clear();
    editing.current.blurred(performance.now());
    resetEditor();
  };
  const hideKeyboard = (dismiss = true) => {
    if (dismiss) keyboardSession.current.dismiss();
    setSoftInputFocused(false);
    const node = editor.current;
    if (!node || document.activeElement !== node) {
      editing.current.blurred(performance.now());
      return;
    }
    // Prefer the browser's final compositionend. If blur sends none, commit
    // the latest composition update to the current remote target once.
    suppressBlur.current = true;
    node.blur();
    suppressBlur.current = false;
    node.inputMode = 'none';
    finishLocalEditing();
  };
  const focusEditor = (allowSoftKeyboard: boolean, userRequested = false) => {
    const node = editor.current;
    if (!node || !editorOwner) return false;
    const wantsSoftKeyboard = allowSoftKeyboard && !!remoteEditable;
    const inputMode = wantsSoftKeyboard ? editableInputMode(remoteEditable.editable.type) : 'none';
    if (document.activeElement === node && inputMode !== 'none' &&
        (node.inputMode === 'none' || userRequested && !resize.keyboardOpen)) {
      suppressBlur.current = true;
      node.blur();
      suppressBlur.current = false;
      finishLocalEditing();
    }
    node.inputMode = inputMode;
    editing.current.focus(editorOwner);
    node.focus({ preventScroll: true });
    const focused = document.activeElement === node && wantsSoftKeyboard && inputMode !== 'none';
    setSoftInputFocused(focused);
    if (focused) {
      keyboardSession.current.attached(userRequested);
      if (userRequested) keyboardTick(tick => tick + 1);
    }
    return focused;
  };
  useLayoutEffect(() => {
    if (!frameReady || resize.blocksInput() || !editableReady || !remoteOwner || currentEditTarget() !== editableTarget) return;
    clearTimeout(deferredEditingTimer.current);
    for (const event of deferredEditing.current.drain(remoteOwner)) {
      if (!send(event)) { setEditingError('键盘输入暂未送达，请重新输入。'); break; }
    }
  }, [frameReady, resize.waiting, editableReady, remoteOwner]);
  const stopMomentum = () => {
    const owner = momentumOwner.current;
    if (!owner) return true;
    if (owner.frame !== undefined) cancelAnimationFrame(owner.frame);
    const current = transport.layout?.views.find(view => view.id === owner.surface.id);
    if (!current || transport.inputIdentity(current) !== owner.identity) { momentumOwner.current = undefined; return true; }
    const accepted = transport.sendInput(current, { ...owner.packet, action: 'cancel' });
    // Browser orders a new down after pending momentum and expires a stale
    // momentum owner. Local animation must stop even if its cancel was blocked.
    momentumOwner.current = undefined;
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
  const releaseTouchCaptures = (ids: number[]) => {
    for (const id of ids) if (canvas.current?.hasPointerCapture(id)) canvas.current.releasePointerCapture(id);
  };
  const clearTouchOwner = (owner: ViewportTouchOwner, stopAnimation: boolean) => {
    if (touchOwner.current !== owner) return;
    const ids = touches.current.contactIds;
    clearTimeout(cancelTimer.current);
    touchOwner.current = undefined;
    touches.current.reset();
    const momentum = momentumOwner.current;
    if (stopAnimation && momentum?.identity === owner.identity && momentum.packet.sequenceId === owner.packet.sequenceId) {
      if (momentum.frame !== undefined) cancelAnimationFrame(momentum.frame);
      momentumOwner.current = undefined;
    }
    setTouchNotice(undefined);
    releaseTouchCaptures(ids);
  };
  const scheduleTouchCleanup = (owner: ViewportTouchOwner, notice: 'cleanup' | 'unconfirmed') => {
    clearTimeout(cancelTimer.current);
    const delay = owner.packet.gestureMode === 'client-v1' ? touchCleanupDelays[owner.cleanupAttempts] : undefined;
    if (delay === undefined) { setTouchNotice(notice); return; }
    ++owner.cleanupAttempts;
    const packet = owner.packet;
    cancelTimer.current = setTimeout(() => {
      if (touchOwner.current !== owner || owner.packet !== packet) return;
      owner.terminal = 'cleanup';
      cancelTouches();
    }, delay);
  };
  const cancelTouches = () => {
    stopMomentum();
    const owner = touchOwner.current;
    if (!owner) return;
    const current = transport.layout?.views.find(view => view.id === owner.surface.id);
    const retirement = owner.retiring ? owner.lease : undefined;
    if (retirement ? !transport.touchRetirementCurrent(retirement)
        : !current || transport.inputIdentity(current) !== owner.identity) { clearTouchOwner(owner, true); return; }
    if (owner.terminal && owner.terminal !== 'cleanup') return;
    const ids = touches.current.contactIds;
    const cancelled = touches.current.cancel() ?? {
      ...owner.packet, action: 'cancel' as const, points: [], samples: undefined,
      gestures: owner.packet.gestureMode === 'client-v1' ? [] : undefined,
    };
    owner.packet = cancelled;
    owner.terminal = 'cleanup';
    clearTimeout(cancelTimer.current);
    const started = performance.now();
    const retry = () => {
      if (touchOwner.current !== owner || owner.terminal !== 'cleanup') return;
      const view = transport.layout?.views.find(view => view.id === owner.surface.id);
      if (retirement ? !transport.touchRetirementCurrent(retirement)
          : !view || transport.inputIdentity(view) !== owner.identity) { clearTouchOwner(owner, true); return; }
      if (retirement ? transport.retireTouch(retirement, cancelled) : transport.sendInput(view!, cancelled)) {
        owner.terminal = retirement ? 'submitted' : 'queued';
        touches.current.accepted(cancelled);
        setTouchNotice(undefined);
        return;
      }
      if (performance.now() - started < 250) cancelTimer.current = setTimeout(retry, 10);
      else scheduleTouchCleanup(owner, 'cleanup');
    };
    retry();
    releaseTouchCaptures(ids);
  };
  const releaseInput = (endEditing = true) => {
    const wasOwner = editing.current.matches(editorOwner);
    for (const event of heldKeys.current.values())
      sendEdit({ ...event, action: "up", repeat: false, text: '', unmodified_text: '' });
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
    if (!endEditing) return;
    if (editing.current.composing && editing.current.matches(editorOwner) && editableReady) send(withEditTarget({ type: 'ime_cancel' }));
    deferredEditing.current.clear(); editing.current.invalidate(); resetEditor();
    if (surface && wasOwner) transport.focus(surface, false);
  };
  const releaseRef = useRef(releaseInput);
  releaseRef.current = (endEditing = true) => { releaseInput(endEditing); if (endEditing) hideKeyboard(); };
  const syncTouchOwner = () => {
    const current = transport.layout?.views.find(view => view.id === viewId);
    const identity = current && transport.inputIdentity(current);
    const owner = touchOwner.current;
    if (owner && owner.identity !== identity) {
      const lease = owner.lease;
      if (lease && transport.layout && transport.layout.epoch !== lease.layoutEpoch &&
          transport.touchRetirementCurrent(lease)) {
        if (!owner.retiring) {
          owner.retiring = true;
          owner.terminal = 'cleanup';
          owner.cleanupAttempts = 0;
          cancelTouches();
        }
      } else clearTouchOwner(owner, true);
    }
    const momentum = momentumOwner.current;
    if (momentum && momentum.identity !== identity) {
      if (momentum.frame !== undefined) cancelAnimationFrame(momentum.frame);
      momentumOwner.current = undefined;
    }
  };
  const syncTouchRef = useRef(syncTouchOwner); syncTouchRef.current = syncTouchOwner;
  useLayoutEffect(() => syncTouchRef.current(), [inputIdentity]);
  useEffect(() => transport.subscribe(() => syncTouchRef.current()), [transport]);
  const systemDismissalSeen = useRef(0);
  useLayoutEffect(() => {
    const previous = previousEditing.current;
    const replaced = previous && (previous.document !== editingIdentity || previous.transport !== transport);
    if (replaced || !keyboardEnabled || previous?.owner !== editorOwner) {
      clearTimeout(deferredEditingTimer.current);
      deferredEditing.current.clear();
      editing.current.invalidate();
      heldKeys.current.clear();
      if (!editing.current.composing) resetEditor();
    }
    if (replaced || !keyboardEnabled || observedOwner !== ackedEditingOwner.current) {
      ackedEditingOwner.current = undefined;
    }
    if (editableReady && remoteOwner) ackedEditingOwner.current = remoteOwner;
    previousEditing.current = { document: editingIdentity, owner: editorOwner, transport };

    const node = editor.current;
    const focused = !!node && document.activeElement === node;
    if (replaced) {
      keyboardTouch.current = undefined;
    }
    const policy = keyboardSession.current;
    const observedDismissal = resize.keyboardDismissals !== systemDismissalSeen.current;
    systemDismissalSeen.current = resize.keyboardDismissals;
    const dismissedCurrentKeyboard = observedDismissal && !replaced && softInputFocused;
    if (dismissedCurrentKeyboard) {
      policy.systemDismissed();
    }
    const now = performance.now();
    const command = policy.observe({ document: editingIdentity, enabled: keyboardEnabled, manual: manualKeyboard,
      editor: transport.mobileEditing.keyboardObservation(editingSurface),
      focused: softInputFocused, ready: keyboardReady && !resize.blocksInput(), now });
    const close = command.close;
    const restore = restoreHardwareFocus.current;
    restoreHardwareFocus.current = undefined;
    const closing = focused && (replaced || !keyboardEnabled || close);
    if (closing) {
      if (close === 'editor-lost' && !resize.keyboardOpen && window.matchMedia('(pointer: fine)').matches)
        restoreHardwareFocus.current = editingIdentity;
      hideKeyboard(false);
    } else {
      // After a real remote blur, keep physical navigation available on a
      // desktop that was already routing keys to this same document.
      if (restore && !replaced && restore === editorOwner && !remoteEditable &&
          document.activeElement === document.body) focusEditor(false);
      if (focused && editorOwner && node) {
        editing.current.focus(editorOwner);
        if (softInputFocused && remoteEditable && !editing.current.composing)
          node.inputMode = editableInputMode(remoteEditable.editable.type);
      }
      if (!dismissedCurrentKeyboard && command.open && !softInputFocused)
        focusEditor(true);
    }

    const deadline = policy.deadline;
    const delay = Math.min(deadline === undefined ? Infinity : deadline - now,
      candidateDeadline === undefined ? Infinity : candidateDeadline - Date.now());
    if (!Number.isFinite(delay) || delay <= 0 && deadline === undefined) return;
    const timer = setTimeout(() => keyboardTick(tick => tick + 1), Math.max(1, Math.ceil(delay)));
    return () => clearTimeout(timer);
  });
  const activateKeyboard = () => {
    if (keyboardSession.current.activate().open && !keyboardShown)
      focusEditor(true, true);
  };
  const resultRef = useRef((_result: InputResult) => {});
  resultRef.current = result => {
    const momentum = momentumOwner.current;
    if (momentum?.identity === result.identity && result.event.type === 'gesture' && result.event.sequenceId === momentum.packet.sequenceId && !result.ok) stopMomentum();
    const owner = touchOwner.current;
    if (!owner || result.identity !== owner.identity || result.event.type !== 'touch' || result.event.sequenceId !== owner.packet.sequenceId) return;
    const current = transport.layout?.views.find(view => view.id === owner.surface.id);
    const identity = owner.retiring && owner.lease && transport.touchRetirementCurrent(owner.lease)
      ? owner.identity : current && transport.inputIdentity(current);
    if (identity !== owner.identity) return;
    const terminal = touchTerminalResult(owner, result, identity, touches.current.contactIds.length);
    if (terminal) {
      clearTouchOwner(owner, terminal === 'invalidated');
      return;
    }
    if (!result.ok && result.touchState === 'rejected' && result.event === owner.start &&
        (owner.packet === owner.start || owner.retiring && owner.submissions === 1)) {
      clearTouchOwner(owner, true);
      return;
    }
    if (result.event === owner.packet && owner.terminal) {
      if (result.touchState === 'accepted-pending' && owner.terminal !== 'unconfirmed') owner.terminal = 'accepted-pending';
      if (result.touchState === 'rejected') {
        owner.terminal = 'cleanup';
        if (result.event.action === 'cancel') scheduleTouchCleanup(owner, 'cleanup');
        else cancelTouches();
      }
      return;
    }
    if (!result.ok && !owner.terminal) cancelTouches();
  };
  useEffect(() => transport.subscribeInputResults(result => resultRef.current(result)), [transport]);
  const deliveryRef = useRef((_delivery: InputDelivery) => {});
  deliveryRef.current = delivery => {
    const owner = touchOwner.current;
    if (!owner || delivery.event.type !== 'touch' || delivery.identity !== owner.identity || delivery.event.sequenceId !== owner.packet.sequenceId) return;
    if (delivery.phase === 'submitted') {
      ++owner.submissions;
      if (delivery.layoutEpoch && delivery.event.gestureMode === 'client-v1') {
        owner.surface = delivery.surface;
        owner.lease = { surface: delivery.surface, identity: delivery.identity, layoutEpoch: delivery.layoutEpoch, authorization: delivery.authorization };
      }
      if (delivery.event === owner.packet && owner.terminal === 'queued') owner.terminal = 'submitted';
    }
    if (delivery.phase === 'discarded') {
      syncTouchOwner();
      if (touchOwner.current !== owner || owner.retiring) return;
      if (!owner.submissions && delivery.event.action === 'start') { clearTouchOwner(owner, true); return; }
      if (delivery.event === owner.packet && owner.terminal === 'queued') {
        owner.terminal = 'cleanup';
        if (delivery.event.action === 'cancel') { scheduleTouchCleanup(owner, 'cleanup'); return; }
      }
      if (!owner.terminal || owner.terminal === 'cleanup') cancelTouches();
    }
    if (delivery.phase === 'unconfirmed' && delivery.event === owner.packet && owner.terminal) {
      owner.terminal = 'unconfirmed';
      scheduleTouchCleanup(owner, 'unconfirmed');
    }
  };
  useEffect(() => transport.subscribeInputDelivery(delivery => deliveryRef.current(delivery)), [transport]);
  useEffect(() => {
    // Android IME dialogs may take window focus while the DOM editor remains
    // attached. Release held buttons/keys, but do not tear down its InputConnection.
    const blur = () => releaseRef.current(document.hidden || document.activeElement !== editor.current);
    window.addEventListener("blur", blur);
    const visibility = () => { if (document.hidden) releaseRef.current(); };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener("blur", blur);
      document.removeEventListener('visibilitychange', visibility);
      releaseRef.current();
      clearTimeout(cancelTimer.current);
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
    if (event.pointerType === 'touch') {
      syncTouchOwner();
      if (action === 'down' && (touchOwner.current?.terminal || !stopMomentum())) { event.preventDefault(); return; }
    }
    const captured = event.currentTarget.hasPointerCapture(event.pointerId);
    const touch = event.pointerType === 'touch';
    const activation = keyboardTouch.current;
    if (touch && activation && (action === 'cancel' || action === 'down' ||
        Math.hypot(event.clientX - activation.x, event.clientY - activation.y) > 8)) keyboardTouch.current = undefined;
    if (touch && action === 'cancel') { cancelTouches(); return; }
    // Keep the previous sequence's recovery identity until Endpoint confirms
    // its terminal. A late rejection must not cancel a newer gesture instead.
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
    if (!surface || !editingIdentity || !frameReady || resize.blocksInput()) {
      if (touch) { keyboardTouch.current = undefined; cancelTouches(); }
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
        if (touch) {
          if (!touches.current.contactIds.length) keyboardTouch.current = {
            pointer: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now(),
          };
        } else {
          if (event.button === 0) activateKeyboard();
          if (!softInputFocused && editor.current?.inputMode === 'none') focusEditor(false);
        }
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
            const existing = touchOwner.current;
            const owner = existing ?? { surface: { ...surface }, identity: touchIdentity, start: next, packet: next, submissions: 0, cleanupAttempts: 0 };
            touchOwner.current = owner;
            const terminal = next.action === 'end' && touches.current.contactIds.length === 0;
            if (!send(next, next.action === 'end' ? { touchTerminal: terminal } : undefined)) {
              if (existing) cancelTouches();
              else {
                clearTouchOwner(owner, true);
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
              }
              release();
              return;
            }
            owner.packet = next;
            const plan = touches.current.takeMomentum();
            touches.current.accepted(next);
            if (terminal) {
              const tap = keyboardTouch.current;
              keyboardTouch.current = undefined;
              if (tap?.pointer === event.pointerId && now - tap.at < 500) activateKeyboard();
              owner.terminal = 'queued';
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
    if (!editing.current.matches(editorOwner) || action === 'up' && !heldKeys.current.has(event.code)) return;
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
    if (!surface || !frameReady || resize.blocksInput()) return;
    const position = point(event);
    if (!position) return;
    // React's delegated wheel listener is passive. Prevent browser scrolling
    // with a native listener, and establish the same input lease as a click.
    event.preventDefault();
    transport.ensureInputFocus(surface);
    const delta = wheelDeltaToDip(surface, event.deltaX, event.deltaY, event.deltaMode);
    send({ type: 'wheel', ...position, dx: -delta.x, dy: -delta.y, modifiers: modifiers(event) });
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
    if (document.activeElement !== editor.current) return;
    if (event.isComposing || editing.current.composing) return;
    const data = phase === 'input' && event.data === null && ['insertText', 'insertFromPaste', 'insertFromDictation'].includes(event.inputType)
      ? editor.current?.value.replace(EDITOR_SENTINEL, '') || null : event.data;
    const operation = editing.current.edit(remoteOwner, event.inputType, data, performance.now(), phase);
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
    return () => { node.removeEventListener('beforeinput', before); node.removeEventListener('input', input); clearTimeout(cancelTimer.current); clearTimeout(deferredEditingTimer.current); deferredEditing.current.clear(); };
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
        inputMode="none"
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        onFocus={() => { if (surface && editorOwner && frameReady && !resize.blocksInput()) { editing.current.focus(editorOwner); if (!editing.current.composing) resetEditor(); transport.ensureInputFocus(surface); } }}
        onBlur={() => {
          if (suppressBlur.current) return;
          if (editor.current?.inputMode !== 'none') keyboardSession.current.dismiss();
          setSoftInputFocused(false);
          finishLocalEditing();
          if (editor.current) editor.current.inputMode = 'none';
        }}
        onKeyDown={(event) => key(event, "down")}
        onKeyUp={(event) => key(event, "up")}
        onCompositionStart={() => { if (document.activeElement === editor.current) editing.current.start(remoteOwner); }}
        onCompositionUpdate={(event) => { const value = editing.current.update(remoteOwner, event.data); if (value) sendEdit(value); }}
        onCompositionEnd={(event) => {
          const value = editing.current.end(remoteOwner, event.data, performance.now());
          if (value) sendEdit(value);
          if (!editing.current.composing) resetEditor();
        }}
      />
      {keyboardEnabled && (observedOwner || keyboardShown) && (
        <Button
          size="small"
          className="remote-open-keyboard"
          startIcon={keyboardShown ? <KeyboardHideOutlined /> : <KeyboardOutlined />}
          disabled={!keyboardShown && !keyboardReady}
          onPointerDown={event => event.preventDefault()}
          onClick={() => {
            if (keyboardShown) { hideKeyboard(); return; }
            if (!surface || !keyboardReady || resize.blocksInput()) return;
            keyboardSession.current.activate(true);
            focusEditor(true, true);
            transport.ensureInputFocus(surface);
          }}
        >
          {keyboardShown ? '隐藏键盘' : '显示键盘'}
        </Button>
      )}
      {editingError && <div role="status" style={{ position: 'absolute', bottom: 8, left: 8, right: 8, background: '#222', color: '#fff', padding: 8, zIndex: 3 }} onClick={() => setEditingError(undefined)}>{editingError}</div>}
      {touchNotice && <div role="status" style={{ position: 'absolute', top: 8, left: 8, background: '#222', color: '#fff', padding: 8, zIndex: 3 }}>
        {touchNotice === 'cleanup' ? '触控结束暂未送达。' : touchNotice === 'confirming' ? '正在确认触控…' : '触控结束尚未确认。'}
        {touchNotice === 'cleanup' && <Button size="small" onPointerDown={event => event.preventDefault()} onClick={() => cancelTouches()}>重试结束</Button>}
        {touchNotice === 'unconfirmed' && touchOwner.current?.packet.gestureMode === 'client-v1' && <Button size="small" onPointerDown={event => event.preventDefault()} onClick={() => {
          const owner = touchOwner.current;
          if (owner && transport.retryTouchTerminal(owner.identity, owner.packet.sequenceId)) setTouchNotice('confirming');
        }}>重试确认</Button>}
        {touchNotice === 'unconfirmed' && touchOwner.current?.packet.gestureMode === 'client-v1' && <Button size="small" onPointerDown={event => event.preventDefault()} onClick={() => {
          const owner = touchOwner.current;
          if (owner) { owner.terminal = 'cleanup'; cancelTouches(); }
        }}>重试结束</Button>}
      </div>}
      {transport.presentationError ? (
        <div className="page-overlay" role="alert">
          {transport.presentationError}
          {transport.canRetryPresentation && <Button sx={{ pointerEvents: 'auto' }} onClick={() => transport.retryPresentation()}>重试视频</Button>}
        </div>
      ) : (transport.diagnostics.connection === '连接失败' || transport.diagnostics.connection !== '已连接' && !resize.frozen) && (
        <div className="page-overlay" role="status">
          {transport.diagnostics.connection === "连接失败"
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
