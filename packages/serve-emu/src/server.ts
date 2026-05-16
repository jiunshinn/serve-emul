import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ServerWebSocket } from "bun";
import { startScrcpy, type ScrcpySession } from "./scrcpy.ts";
import { dispatch, parseGesture, resetVideoPacket, type Screen } from "./input.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, "..", "dist", "ui");

export type ServerOpts = {
  serial: string;
  port: number;
  maxFps?: number;
  bitRate?: number;
  maxSize?: number;
  keyFrameInterval?: number;
};

type SessionStatus = "streaming" | "stopped" | "error";

type WsData = { id: number; frameMeta: boolean; handle?: Client };

type Client = {
  id: number;
  ws: ServerWebSocket<WsData>;
  frameMeta: boolean;
  sentFrames: number;
  droppedFrames: number;
  backpressureEvents: number;
  awaitingKeyFrame: boolean;
};

const MAX_WS_MESSAGE_BYTES = 16 * 1024;
const DROP_FRAME_BUFFERED_BYTES = 512 * 1024;
const CLOSE_CLIENT_BUFFERED_BYTES = 16 * 1024 * 1024;
const FRAME_META_MAGIC = 0x53454d55; // "SEMU"
const FRAME_META_VERSION = 1;
const FRAME_META_HEADER_BYTES = 16;
const FRAME_FLAG_KEY = 1 << 0;
const VIDEO_RESET_COOLDOWN_MS = 1500;
const STALE_VIDEO_RESET_MS = 2500;

export async function startServer(opts: ServerOpts) {
  const session: ScrcpySession = await startScrcpy({
    serial: opts.serial,
    maxFps: opts.maxFps,
    bitRate: opts.bitRate,
    maxSize: opts.maxSize,
    keyFrameInterval: opts.keyFrameInterval,
  });
  console.log(
    `scrcpy ready: ${session.meta.deviceName} • ${session.meta.codecId} • ${session.meta.width}×${session.meta.height}`,
  );

  const clients = new Set<Client>();
  const screen: Screen = { width: session.meta.width, height: session.meta.height };
  const startedAt = new Date().toISOString();
  let status: SessionStatus = "streaming";
  let lastError: string | null = null;
  let stoppedAt: string | null = null;
  let stopRequested = false;
  let frameCount = 0;
  let configPacketCount = 0;
  let lastFrameAt: string | null = null;
  let totalDroppedFrames = 0;
  let totalBackpressureEvents = 0;
  let sourceFps = 0;
  let lastFpsFrameCount = 0;
  let videoResetRequests = 0;
  let lastVideoResetAt: string | null = null;
  let lastVideoResetReason: string | null = null;
  let lastVideoResetMs = 0;
  let watchdog: ReturnType<typeof setInterval> | null = null;

  const health = () => ({
    ok: status === "streaming",
    status,
    serial: opts.serial,
    device: session.meta.deviceName,
    codec: session.meta.codecId,
    size: { width: session.meta.width, height: session.meta.height },
    clients: clients.size,
    frames: frameCount,
    sourceFps,
    configPackets: configPacketCount,
    droppedFrames: totalDroppedFrames,
    backpressureEvents: totalBackpressureEvents,
    videoResetRequests,
    lastVideoResetAt,
    lastVideoResetReason,
    clientsDetail: Array.from(clients, (client) => ({
      id: client.id,
      frameMeta: client.frameMeta,
      sentFrames: client.sentFrames,
      droppedFrames: client.droppedFrames,
      backpressureEvents: client.backpressureEvents,
      bufferedBytes: client.ws.getBufferedAmount(),
      awaitingKeyFrame: client.awaitingKeyFrame,
    })),
    startedAt,
    stoppedAt,
    lastFrameAt,
    lastError,
  });

  const closeClients = (code: number, reason: string) => {
    for (const c of clients) {
      try {
        c.ws.close(code, reason);
      } catch {}
    }
    clients.clear();
  };

  const markTerminal = (nextStatus: Exclude<SessionStatus, "streaming">, reason: string) => {
    if (status !== "streaming") return;
    status = nextStatus;
    lastError = reason;
    stoppedAt = new Date().toISOString();
    if (watchdog) clearInterval(watchdog);
    session.close();
    closeClients(nextStatus === "error" ? 1011 : 1000, reason);
  };

  const sendJson = (ws: ServerWebSocket<WsData>, value: unknown) => {
    try {
      ws.send(JSON.stringify(value));
    } catch {}
  };

  const withFrameMeta = (
    data: Buffer,
    frame: { pts: bigint; isKey: boolean },
  ): Buffer => {
    const out = Buffer.allocUnsafe(FRAME_META_HEADER_BYTES + data.length);
    out.writeUInt32BE(FRAME_META_MAGIC, 0);
    out.writeUInt8(FRAME_META_VERSION, 4);
    out.writeUInt8(frame.isKey ? FRAME_FLAG_KEY : 0, 5);
    out.writeUInt16BE(0, 6);
    out.writeBigUInt64BE(frame.pts, 8);
    data.copy(out, FRAME_META_HEADER_BYTES);
    return out;
  };

  const makeKeyframeAU = (frameData: Buffer): Buffer => {
    if (!cachedConfig) return frameData;
    const out = Buffer.allocUnsafe(cachedConfig.length + frameData.length);
    cachedConfig.copy(out, 0);
    frameData.copy(out, cachedConfig.length);
    return out;
  };

  const wantsAck = (value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return true;
    return (value as Record<string, unknown>).ack !== false;
  };

  const isResetVideoRequest = (value: unknown) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "reset-video";

  const requestVideoReset = (reason: string) => {
    const now = Date.now();
    if (now - lastVideoResetMs < VIDEO_RESET_COOLDOWN_MS) return;
    lastVideoResetMs = now;
    videoResetRequests++;
    lastVideoResetAt = new Date(now).toISOString();
    lastVideoResetReason = reason;
    try {
      session.controlSocket.write(resetVideoPacket());
    } catch {}
  };

  const dropUntilKeyFrame = (client: Client) => {
    client.droppedFrames++;
    totalDroppedFrames++;
    client.awaitingKeyFrame = true;
    requestVideoReset("client backpressure");
  };

  const sendFrame = (client: Client, data: Buffer, isKeyFrame: boolean) => {
    if (client.awaitingKeyFrame) {
      if (!isKeyFrame) {
        client.droppedFrames++;
        totalDroppedFrames++;
        return;
      }
      client.awaitingKeyFrame = false;
    }

    const buffered = client.ws.getBufferedAmount();
    if (buffered > CLOSE_CLIENT_BUFFERED_BYTES) {
      clients.delete(client);
      try {
        client.ws.close(1013, "client too slow");
      } catch {}
      return;
    }
    if (buffered > DROP_FRAME_BUFFERED_BYTES) {
      dropUntilKeyFrame(client);
      return;
    }
    const sent = client.ws.send(data);
    if (sent === -1) {
      client.backpressureEvents++;
      totalBackpressureEvents++;
      dropUntilKeyFrame(client);
      return;
    }
    if (sent === 0) {
      clients.delete(client);
      return;
    }
    client.sentFrames++;
  };
  // Cache the SPS+PPS bytes that scrcpy emits as a standalone "config" packet
  // and inline them in front of every keyframe so each WS message is a
  // self-contained Access Unit the browser can hand straight to WebCodecs.
  let cachedConfig: Buffer | null = null;

  (async () => {
    try {
      while (!stopRequested) {
        const f = await session.readFrame();
        if (!f) {
          if (!stopRequested) markTerminal("error", "scrcpy video stream ended");
          break;
        }
        if (f.isConfig) {
          cachedConfig = f.data;
          configPacketCount++;
          continue;
        }
        frameCount++;
        lastFrameAt = new Date().toISOString();
        const rawOut = f.isKey && cachedConfig ? makeKeyframeAU(f.data) : f.data;
        let framedOut: Buffer | null = null;
        for (const c of clients) {
          if (c.awaitingKeyFrame && !f.isKey) {
            c.droppedFrames++;
            totalDroppedFrames++;
            continue;
          }
          const out = c.frameMeta
            ? (framedOut ??= withFrameMeta(rawOut, f))
            : rawOut;
          sendFrame(c, out, f.isKey);
        }
      }
    } catch (err) {
      if (!stopRequested) markTerminal("error", String(err));
    }
  })();

  watchdog = setInterval(() => {
    sourceFps = frameCount - lastFpsFrameCount;
    lastFpsFrameCount = frameCount;
    if (status !== "streaming" || clients.size === 0) return;
    const lastFrameMs = lastFrameAt ? Date.parse(lastFrameAt) : Date.parse(startedAt);
    if (Date.now() - lastFrameMs > STALE_VIDEO_RESET_MS) {
      requestVideoReset("source stream stalled");
    }
  }, 1000);

  session.proc.once("exit", (code, signal) => {
    if (!stopRequested && status === "streaming") {
      markTerminal("error", `scrcpy exited with code ${code ?? "null"} signal ${signal ?? "null"}`);
    }
  });
  session.controlSocket.once("error", (err) => {
    if (!stopRequested && status === "streaming") {
      markTerminal("error", `scrcpy control socket error: ${err.message}`);
    }
  });

  let nextId = 1;
  const server = Bun.serve<WsData>({
    port: opts.port,
    async fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/api") {
        return Response.json({
          serial: opts.serial,
          device: session.meta.deviceName,
          codec: session.meta.codecId,
          size: { width: session.meta.width, height: session.meta.height },
          status,
          clients: clients.size,
        });
      }

      if (url.pathname === "/health") {
        return Response.json(health(), { status: status === "streaming" ? 200 : 503 });
      }

      if (url.pathname === "/ws") {
        if (status !== "streaming") {
          return new Response(JSON.stringify(health()), {
            status: 503,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          });
        }
        const frameMeta = url.searchParams.get("frame-meta") === "1";
        const ok = srv.upgrade(req, { data: { id: nextId++, frameMeta } });
        if (ok) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      }

      const reqPath = url.pathname === "/" ? "/index.html" : url.pathname;
      if (reqPath.includes("..")) return new Response("not found", { status: 404 });
      const file = Bun.file(join(UI_DIR, reqPath));
      if (await file.exists()) return new Response(file);
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        const handle: Client = {
          id: ws.data.id,
          ws,
          frameMeta: ws.data.frameMeta,
          sentFrames: 0,
          droppedFrames: 0,
          backpressureEvents: 0,
          awaitingKeyFrame: true,
        };
        clients.add(handle);
        ws.data.handle = handle;
        requestVideoReset("client opened");
      },
      message(ws, raw) {
        if (typeof raw !== "string") return;
        if (raw.length > MAX_WS_MESSAGE_BYTES) {
          ws.close(1009, "message too large");
          return;
        }
        try {
          if (status !== "streaming") throw new Error(`session is ${status}`);
          const payload = JSON.parse(raw);
          const acknowledge = wantsAck(payload);
          if (isResetVideoRequest(payload)) {
            requestVideoReset("client requested keyframe");
            if (acknowledge) sendJson(ws, { ok: true });
            return;
          }
          const msg = parseGesture(payload);
          void dispatch(session.controlSocket, msg, screen)
            .then(() => {
              if (acknowledge) sendJson(ws, { ok: true });
            })
            .catch((err) => sendJson(ws, { ok: false, error: String(err) }));
        } catch (err) {
          sendJson(ws, { ok: false, error: String(err) });
        }
      },
      close(ws) {
        if (ws.data.handle) clients.delete(ws.data.handle);
      },
    },
  });

  const stop = () => {
    if (stopRequested) return;
    stopRequested = true;
    if (status === "streaming") {
      status = "stopped";
      stoppedAt = new Date().toISOString();
    }
    closeClients(1001, "server stopping");
    if (watchdog) clearInterval(watchdog);
    server.stop(true);
    session.close();
  };

  return { server, session, stop };
}

export type StartedServer = Awaited<ReturnType<typeof startServer>>;
export type { ScrcpySession };
