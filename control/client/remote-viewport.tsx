import React, { useEffect, useRef, useState } from "react";
import { Button } from "@mui/material";
import { RemoteTransport } from "./transport";
import { keyIdentity, mouseButtonModifiers } from "./keys";
import { StatsOverlay } from "./stats-overlay";
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
  const editor = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const compositionCommit = useRef<string | null>(null);
  const mouseCapture = useRef<{
    pointerId: number;
    button: number;
    identity: string;
    x: number;
    y: number;
  } | null>(null);
  const heldKeys = useRef(new Map<string, Record<string, unknown>>());
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const surface = transport.layout?.views.find((view) => view.id === viewId);
  const layoutEpoch = transport.layout?.epoch,
    layoutGeneration = transport.layout?.generation;
  const [frameReady, setFrameReady] = useState(false);
  useEffect(() => {
    setFrameReady(false);
    if (!surface || !canvas.current || !layoutEpoch || !layoutGeneration)
      return;
    // The encoded bitmap survives CSS resizing. Transport validates this exact
    // renderer identity before either an atlas crop or the opt-in direct draw.
    return transport.registerPlane(
      { view: surface, layoutEpoch, layoutGeneration },
      canvas.current,
      setFrameReady,
    );
  }, [transport, surface, layoutEpoch, layoutGeneration]);
  const send = (event: Record<string, unknown>) => {
    if (surface && frameReady) transport.sendInput(surface, event);
  };
  const releaseInput = () => {
    for (const event of heldKeys.current.values())
      send({ ...event, action: "up", repeat: false });
    heldKeys.current.clear();
    const held = mouseCapture.current;
    if (held) {
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
    for (const [id, point] of touches.current) {
      send({
        type: "touch",
        action: "cancel",
        points: [{ id, ...point, pressure: 0 }],
      });
      if (canvas.current?.hasPointerCapture(id))
        canvas.current.releasePointerCapture(id);
    }
    touches.current.clear();
    if (composing.current) {
      send({ type: "ime_commit", text: editor.current?.value ?? "" });
      composing.current = false;
      if (editor.current) editor.current.value = "";
    }
    if (surface) transport.focus(surface, false);
  };
  const releaseRef = useRef(releaseInput);
  releaseRef.current = releaseInput;
  useEffect(() => {
    const blur = () => releaseRef.current();
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("blur", blur);
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
    const captured = event.currentTarget.hasPointerCapture(event.pointerId);
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
    if (!surface || !frameReady) {
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
        editor.current?.focus({ preventScroll: true });
        transport.focus(surface, true);
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
        if (action === "down" || action === "move")
          touches.current.set(event.pointerId, position);
        else touches.current.delete(event.pointerId);
        send({
          type: "touch",
          action: (
            {
              down: "start",
              up: "end",
              move: "move",
              cancel: "cancel",
            } as Record<string, string>
          )[action],
          points: [
            { id: event.pointerId, ...position, pressure: event.pressure },
          ],
        });
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
    if (composing.current || event.nativeEvent.isComposing) return;
    if (
      event.key === "Tab" ||
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
      text: "",
      unmodified_text: "",
    };
    if (action === "down") heldKeys.current.set(event.code, value);
    else heldKeys.current.delete(event.code);
    send(value);
  };
  return (
    <section className="remote-viewport" aria-label="远程页面">
      <canvas
        ref={canvas}
        aria-label={"远程页面画面"}
        className={frameReady ? "" : "no-frame"}
        onPointerDown={(event) => pointer(event, "down")}
        onPointerMove={(event) => pointer(event, "move")}
        onPointerUp={(event) => pointer(event, "up")}
        onPointerCancel={(event) => pointer(event, "cancel")}
        onPointerLeave={(event) => {
          if (event.pointerType !== "touch") pointer(event, "leave");
        }}
        onContextMenu={(event) => event.preventDefault()}
        onWheel={(event) => {
          if (surface && frameReady) {
            const position = point(event);
            if (!position) return;
            const unit =
              event.deltaMode === 1
                ? 16
                : event.deltaMode === 2
                  ? surface.height / surfacePixelScale(surface)
                  : 1;
            send({
              type: "wheel",
              ...position,
              dx: -event.deltaX * unit,
              dy: -event.deltaY * unit,
              modifiers: modifiers(event),
            });
          }
        }}
      />
      <textarea
        ref={editor}
        className="remote-input"
        aria-label="远程页面键盘输入"
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        onFocus={() => surface && frameReady && transport.focus(surface, true)}
        onBlur={releaseInput}
        onKeyDown={(event) => key(event, "down")}
        onKeyUp={(event) => key(event, "up")}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionUpdate={(event) =>
          send({
            type: "ime_set",
            text: event.data,
            selection_start: event.data.length,
            selection_end: event.data.length,
          })
        }
        onCompositionEnd={(event) => {
          if (!composing.current) return;
          composing.current = false;
          compositionCommit.current = event.data;
          setTimeout(() => {
            compositionCommit.current = null;
          }, 0);
          send({ type: "ime_commit", text: event.data });
          if (editor.current) editor.current.value = "";
        }}
        onInput={(event) => {
          if (!composing.current) {
            const native = event.nativeEvent as InputEvent;
            if (
              native.inputType !== "insertCompositionText" &&
              native.inputType !== "insertFromComposition" &&
              native.data &&
              native.data !== compositionCommit.current
            )
              send({ type: "ime_commit", text: native.data });
            event.currentTarget.value = "";
          }
        }}
      />
      {!frameReady && (
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
