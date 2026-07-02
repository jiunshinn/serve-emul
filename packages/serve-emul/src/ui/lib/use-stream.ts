import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { StreamStats } from "./stream-worker";

export type DeviceSize = { width: number; height: number };

export type { StreamStats };

export type StreamState = {
  status: string;
  fps: number;
  deviceSize: DeviceSize | null;
  stats: StreamStats | null;
};

export type Sender = (msg: Record<string, unknown>, ack?: boolean) => void;

type ApiInfo = {
  size: DeviceSize;
  status?: "streaming" | "stopped" | "error";
  lastFrameAt?: string | null;
  lastError?: string | null;
};

type WorkerEvent =
  | { type: "status"; status: string }
  | { type: "session"; size: DeviceSize }
  | { type: "rendered" }
  | { type: "stats"; stats: StreamStats };

// A canvas can transfer control to an OffscreenCanvas only once, so the worker
// that received it must be reused if the effect re-runs for the same element.
const workerByCanvas = new WeakMap<HTMLCanvasElement, Worker>();

export function useStream(canvasRef: RefObject<HTMLCanvasElement>) {
  const [state, setState] = useState<StreamState>({
    status: "connecting…",
    fps: 0,
    deviceSize: null,
    stats: null,
  });
  const workerRef = useRef<Worker | null>(null);

  const send = useCallback<Sender>((msg, ack = true) => {
    workerRef.current?.postMessage({
      type: "send",
      text: JSON.stringify(ack ? msg : { ...msg, ack: false }),
    });
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (typeof Worker !== "function" || typeof canvas.transferControlToOffscreen !== "function") {
      setState((s) => ({ ...s, status: "OffscreenCanvas unsupported" }));
      return;
    }

    let cancelled = false;
    let hasRenderedFrame = false;
    let healthTimer: ReturnType<typeof setInterval> | null = null;

    const setStatus = (status: string) =>
      setState((prev) => (prev.status === status ? prev : { ...prev, status }));

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws?frame-meta=1`;

    let worker = workerByCanvas.get(canvas);
    if (!worker) {
      worker = new Worker(new URL("./stream-worker.ts", import.meta.url), { type: "module" });
      workerByCanvas.set(canvas, worker);
      const offscreen = canvas.transferControlToOffscreen();
      worker.postMessage({ type: "init", canvas: offscreen, url }, [offscreen]);
    } else {
      worker.postMessage({ type: "connect" });
    }
    workerRef.current = worker;

    const onMessage = (e: MessageEvent) => {
      if (cancelled) return;
      const msg = e.data as WorkerEvent;
      if (msg.type === "status") {
        setStatus(msg.status);
      } else if (msg.type === "session") {
        setState((s) => ({ ...s, deviceSize: msg.size }));
      } else if (msg.type === "rendered") {
        hasRenderedFrame = true;
      } else if (msg.type === "stats") {
        if (msg.stats.rendered) hasRenderedFrame = true;
        setState((s) => ({ ...s, fps: msg.stats.fps, stats: msg.stats }));
      }
    };
    worker.addEventListener("message", onMessage);

    const applyServerStatus = (d: ApiInfo) => {
      const lastFrameAgeMs = d.lastFrameAt ? Date.now() - Date.parse(d.lastFrameAt) : Infinity;
      setState((s) => ({
        ...s,
        deviceSize: d.size,
        status:
          d.status && d.status !== "streaming"
            ? d.lastError || d.status
            : !hasRenderedFrame && lastFrameAgeMs > 5000
              ? "waiting for video"
              : s.status === "stream stalled" ||
                  s.status === "metadata unavailable" ||
                  s.status === "waiting for video"
                ? "streaming"
              : s.status,
      }));
    };

    fetch("/health")
      .then((r) => r.json() as Promise<ApiInfo>)
      .then((d) => {
        if (!cancelled) applyServerStatus(d);
      })
      .catch(() => {
        if (!cancelled) setStatus("metadata unavailable");
      });

    healthTimer = setInterval(() => {
      fetch("/health")
        .then((r) => r.json() as Promise<ApiInfo>)
        .then((d) => {
          if (!cancelled) applyServerStatus(d);
        })
        .catch(() => {
          if (!cancelled) setStatus("metadata unavailable");
        });
    }, 1500);

    return () => {
      cancelled = true;
      if (healthTimer) clearInterval(healthTimer);
      worker.removeEventListener("message", onMessage);
      worker.postMessage({ type: "stop" });
      workerRef.current = null;
    };
  }, [canvasRef]);

  return { state, send };
}
