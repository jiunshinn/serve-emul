import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { buildCodecString, scanAU } from "./h264";

export type DeviceSize = { width: number; height: number };

export type StreamState = {
  status: string;
  fps: number;
  deviceSize: DeviceSize | null;
};

export type Sender = (msg: Record<string, unknown>, ack?: boolean) => void;

type ApiInfo = {
  size: DeviceSize;
  status?: "streaming" | "stopped" | "error";
};

const MAX_DECODE_QUEUE_SIZE = 2;
const KEYFRAME_REQUEST_COOLDOWN_MS = 500;

export function useStream(canvasRef: RefObject<HTMLCanvasElement>) {
  const [state, setState] = useState<StreamState>({
    status: "connecting…",
    fps: 0,
    deviceSize: null,
  });
  const wsRef = useRef<WebSocket | null>(null);

  const send = useCallback<Sender>((msg, ack = true) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(ack ? msg : { ...msg, ack: false }));
  }, []);

  useEffect(() => {
    const canDecode = "VideoDecoder" in globalThis && "EncodedVideoChunk" in globalThis;
    if (!canDecode) {
      setState((s) => ({ ...s, status: "WebCodecs unsupported" }));
      return;
    }

    let cancelled = false;
    let reconnectDelay = 500;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let decoder: VideoDecoder | null = null;
    let sawKeyframe = false;
    let frameIdx = 0;
    let fpsCount = 0;
    let fpsTimer = performance.now();
    let latestFrame: VideoFrame | null = null;
    let renderRaf = 0;
    let lastKeyframeRequestAt = 0;

    const setStatus = (s: string) =>
      setState((prev) => (prev.status === s ? prev : { ...prev, status: s }));

    const requestKeyframe = () => {
      const ws = wsRef.current;
      const now = performance.now();
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (now - lastKeyframeRequestAt < KEYFRAME_REQUEST_COOLDOWN_MS) return;
      lastKeyframeRequestAt = now;
      ws.send(JSON.stringify({ type: "reset-video", ack: false }));
    };

    const renderLatestFrame = (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
      renderRaf = 0;
      const frame = latestFrame;
      latestFrame = null;
      if (!frame) return;

      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      ctx.drawImage(frame, 0, 0);
      frame.close();

      fpsCount++;
      const now = performance.now();
      if (now - fpsTimer >= 1000) {
        const fps = Math.round((fpsCount * 1000) / (now - fpsTimer));
        fpsCount = 0;
        fpsTimer = now;
        setState((s) => (s.fps === fps ? s : { ...s, fps }));
      }
    };

    const ensureDecoder = (spsBytes: Uint8Array) => {
      if (decoder && decoder.state !== "closed") return;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d", { alpha: false, desynchronized: true });
      if (!canvas || !ctx) return;
      const codec = buildCodecString(spsBytes);
      const dec = new VideoDecoder({
        output: (frame) => {
          latestFrame?.close();
          latestFrame = frame;
          if (!renderRaf) {
            renderRaf = requestAnimationFrame(() => renderLatestFrame(canvas, ctx));
          }
        },
        error: (e) => {
          console.error("VideoDecoder error", e);
          setStatus("decoder error");
        },
      });
      dec.configure({ codec, optimizeForLatency: true });
      decoder = dec;
      console.log("VideoDecoder configured:", codec);
    };

    const feedFrame = (raw: ArrayBuffer | Uint8Array) => {
      const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      const { isKey, spsBytes } = scanAU(data);
      if (spsBytes) ensureDecoder(spsBytes);
      if (!decoder || decoder.state !== "configured") return;

      if (decoder.decodeQueueSize > MAX_DECODE_QUEUE_SIZE) {
        try {
          decoder.reset();
        } catch {}
        sawKeyframe = false;
        frameIdx = 0;
        requestKeyframe();
        if (!isKey) return;
      }

      if (!sawKeyframe) {
        if (!isKey) {
          requestKeyframe();
          return;
        }
        sawKeyframe = true;
      }
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: isKey ? "key" : "delta",
            timestamp: Math.round((frameIdx * 1_000_000) / 60),
            data,
          }),
        );
        frameIdx++;
      } catch (e) {
        console.error("decode failed", e);
      }
    };

    const connect = () => {
      if (cancelled) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/ws`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      ws.onopen = () => {
        reconnectDelay = 500;
        setStatus("streaming");
      };
      ws.onerror = () => setStatus("connection error");
      ws.onclose = () => {
        if (cancelled) return;
        const retryIn = reconnectDelay;
        setStatus(`disconnected — retrying in ${Math.round(retryIn / 1000)}s`);
        try {
          decoder?.close();
        } catch {}
        decoder = null;
        frameIdx = 0;
        sawKeyframe = false;
        reconnectDelay = Math.min(Math.round(reconnectDelay * 1.6), 5000);
        retryTimer = setTimeout(connect, retryIn);
      };
      ws.onmessage = (e) => {
        if (typeof e.data === "string") return;
        feedFrame(e.data);
      };
    };

    connect();

    fetch("/api")
      .then((r) => r.json() as Promise<ApiInfo>)
      .then((d) => {
        if (cancelled) return;
        setState((s) => ({
          ...s,
          deviceSize: d.size,
          status: d.status && d.status !== "streaming" ? d.status : s.status,
        }));
      })
      .catch(() => {
        if (!cancelled) setStatus("metadata unavailable");
      });

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      try {
        wsRef.current?.close();
      } catch {}
      if (renderRaf) cancelAnimationFrame(renderRaf);
      latestFrame?.close();
      try {
        decoder?.close();
      } catch {}
      wsRef.current = null;
      decoder = null;
    };
  }, [canvasRef]);

  return { state, send };
}
