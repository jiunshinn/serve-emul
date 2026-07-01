import { useRef } from "react";
import type { PointerEvent, RefObject } from "react";
import type { Sender } from "../lib/use-stream";
import type { AccessibilityNode } from "./accessibility-panel";

type Props = {
  canvasRef: RefObject<HTMLCanvasElement>;
  send: Sender;
  accessibilityNodes?: AccessibilityNode[];
  accessibilityEnabled?: boolean;
  highlightedAccessibilityId?: string | null;
  onAccessibilityHover?: (id: string | null) => void;
  deviceSize?: { width: number; height: number } | null;
  keyboardProxyRef?: RefObject<HTMLInputElement>;
  keyboardActive?: boolean;
};

type Point = { x: number; y: number };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function DeviceStream({
  canvasRef,
  send,
  accessibilityNodes = [],
  accessibilityEnabled = false,
  highlightedAccessibilityId = null,
  onAccessibilityHover,
  deviceSize = null,
  keyboardProxyRef,
  keyboardActive = true,
}: Props) {
  const activeRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const pendingMoveRef = useRef<Point | null>(null);
  const moveRafRef = useRef(0);
  const accessibilitySize = accessibilityNodes.length
    ? accessibilityNodes.reduce(
        (size, node) => ({
          width: Math.max(size.width, node.bounds.right),
          height: Math.max(size.height, node.bounds.bottom),
        }),
        {
          width: deviceSize?.width ?? 1,
          height: deviceSize?.height ?? 1,
        },
      )
    : deviceSize;

  const pointFromClient = (clientX: number, clientY: number): Point | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return {
      x: clamp01((clientX - r.left) / r.width),
      y: clamp01((clientY - r.top) / r.height),
    };
  };

  const norm = (e: PointerEvent<HTMLCanvasElement>): Point | null =>
    pointFromClient(e.clientX, e.clientY);

  const accessibilityNodeAt = (p: Point): AccessibilityNode | null => {
    if (!accessibilityEnabled || !accessibilitySize) return null;
    const x = p.x * accessibilitySize.width;
    const y = p.y * accessibilitySize.height;
    const matches = accessibilityNodes
      .filter(
        (node) =>
          x >= node.bounds.left &&
          x <= node.bounds.right &&
          y >= node.bounds.top &&
          y <= node.bounds.bottom,
      )
      .sort((a, b) => {
        const areaA = (a.bounds.right - a.bounds.left) * (a.bounds.bottom - a.bounds.top);
        const areaB = (b.bounds.right - b.bounds.left) * (b.bounds.bottom - b.bounds.top);
        return areaA - areaB;
      });
    return matches[0] ?? null;
  };

  const updateAccessibilityHover = (p: Point | null) => {
    if (!onAccessibilityHover) return;
    onAccessibilityHover(p ? accessibilityNodeAt(p)?.id ?? null : null);
  };

  const sendTouch = (action: "down" | "move" | "up", p: Point, pointerId: number) => {
    send({ type: "touch", action, x: p.x, y: p.y, pointerId }, false);
  };

  const flushMove = () => {
    moveRafRef.current = 0;
    const active = activeRef.current;
    const next = pendingMoveRef.current;
    if (!active || !next) return;
    pendingMoveRef.current = null;
    active.x = next.x;
    active.y = next.y;
    sendTouch("move", next, active.id);
  };

  const queueMove = (p: Point) => {
    pendingMoveRef.current = p;
    if (!moveRafRef.current) {
      moveRafRef.current = requestAnimationFrame(flushMove);
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (activeRef.current) return;
    e.preventDefault();
    keyboardProxyRef?.current?.focus({ preventScroll: true });
    updateAccessibilityHover(null);
    canvasRef.current?.setPointerCapture(e.pointerId);
    const p = norm(e);
    if (!p) return;
    activeRef.current = { id: e.pointerId, ...p };
    pendingMoveRef.current = null;
    sendTouch("down", p, e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const active = activeRef.current;
    const native = e.nativeEvent;
    const coalesced =
      typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : null;
    if (!active || e.pointerId !== active.id) {
      const hoverEvent = coalesced && coalesced.length > 0 ? coalesced[coalesced.length - 1] : e;
      updateAccessibilityHover(pointFromClient(hoverEvent.clientX, hoverEvent.clientY));
      return;
    }
    e.preventDefault();
    if (coalesced && coalesced.length > 0) {
      const last = coalesced[coalesced.length - 1];
      const p = pointFromClient(last.clientX, last.clientY);
      if (p) queueMove(p);
    } else {
      const p = norm(e);
      if (p) queueMove(p);
    }
  };

  const stopPointer = (e: PointerEvent<HTMLCanvasElement>) => {
    const active = activeRef.current;
    if (!active || e.pointerId !== active.id) return;
    e.preventDefault();
    if (moveRafRef.current) {
      cancelAnimationFrame(moveRafRef.current);
      flushMove();
    }
    const up = norm(e);
    if (up) sendTouch("up", up, active.id);
    try {
      canvasRef.current?.releasePointerCapture(active.id);
    } catch {}
    activeRef.current = null;
    pendingMoveRef.current = null;
  };

  return (
    <div className="stream-surface">
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={() => updateAccessibilityHover(null)}
        onPointerUp={stopPointer}
        onPointerCancel={stopPointer}
        onContextMenu={(e) => e.preventDefault()}
      />
      {!keyboardActive && (
        <button
          type="button"
          className="keyboard-hint"
          onClick={() => keyboardProxyRef?.current?.focus({ preventScroll: true })}
        >
          Click to resume keyboard input
        </button>
      )}
      {accessibilityEnabled && accessibilitySize && (
        <div className="ax-overlay" aria-hidden="true">
          {accessibilityNodes.map((node) => {
            const left = (node.bounds.left / accessibilitySize.width) * 100;
            const top = (node.bounds.top / accessibilitySize.height) * 100;
            const width = ((node.bounds.right - node.bounds.left) / accessibilitySize.width) * 100;
            const height = ((node.bounds.bottom - node.bounds.top) / accessibilitySize.height) * 100;
            const active = node.id === highlightedAccessibilityId;
            return (
              <div
                key={node.id}
                className={active ? "ax-box active" : "ax-box"}
                style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
