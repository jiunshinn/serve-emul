import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ServerWebSocket } from "bun";
import { startScrcpy, readFrame, type ScrcpySession } from "./scrcpy.ts";
import { dispatch, parseGesture, resetVideoPacket, type Screen } from "./input.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, "..", "dist", "ui");

export type ServerOpts = {
  serial: string;
  port: number;
  maxFps?: number;
  bitRate?: number;
  maxSize?: number;
};

type SessionStatus = "streaming" | "stopped" | "error";

type WsData = { id: number; handle?: Client };

type Client = {
  id: number;
  ws: ServerWebSocket<WsData>;
  sentFrames: number;
  droppedFrames: number;
  backpressureEvents: number;
  awaitingKeyFrame: boolean;
};

const MAX_WS_MESSAGE_BYTES = 16 * 1024;
const DROP_FRAME_BUFFERED_BYTES = 512 * 1024;
const CLOSE_CLIENT_BUFFERED_BYTES = 16 * 1024 * 1024;
const VIDEO_RESET_COOLDOWN_MS = 250;

export async function startServer(opts: ServerOpts) {
  const session = await startScrcpy({
    serial: opts.serial,
    maxFps: opts.maxFps,
    bitRate: opts.bitRate,
    maxSize: opts.maxSize,
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

  const health = () => ({
    ok: status === "streaming",
    status,
    serial: opts.serial,
    device: session.meta.deviceName,
    codec: session.meta.codecId,
    size: { width: session.meta.width, height: session.meta.height },
    clients: clients.size,
    frames: frameCount,
    configPackets: configPacketCount,
    droppedFrames: totalDroppedFrames,
    backpressureEvents: totalBackpressureEvents,
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
    session.close();
    closeClients(nextStatus === "error" ? 1011 : 1000, reason);
  };

  const sendJson = (ws: ServerWebSocket<WsData>, value: unknown) => {
    try {
      ws.send(JSON.stringify(value));
    } catch {}
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

  let lastVideoResetAt = 0;
  const requestVideoReset = () => {
    const now = Date.now();
    if (now - lastVideoResetAt < VIDEO_RESET_COOLDOWN_MS) return;
    lastVideoResetAt = now;
    session.controlSocket.write(resetVideoPacket());
  };

  const dropUntilKeyFrame = (client: Client) => {
    client.droppedFrames++;
    totalDroppedFrames++;
    client.awaitingKeyFrame = true;
    requestVideoReset();
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
        const f = await readFrame(session.videoReader);
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
        const out = f.isKey && cachedConfig ? Buffer.concat([cachedConfig, f.data]) : f.data;
        for (const c of clients) sendFrame(c, out, f.isKey);
      }
    } catch (err) {
      if (!stopRequested) markTerminal("error", String(err));
    }
  })();

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
        const ok = srv.upgrade(req, { data: { id: nextId++ } });
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
          sentFrames: 0,
          droppedFrames: 0,
          backpressureEvents: 0,
          awaitingKeyFrame: true,
        };
        clients.add(handle);
        ws.data.handle = handle;
        // Force scrcpy to emit a fresh keyframe so this client can start
        // decoding immediately (default GOP is 10s). cachedConfig will be
        // bundled into that keyframe automatically.
        if (status === "streaming") requestVideoReset();
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
            requestVideoReset();
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
    server.stop(true);
    session.close();
  };

  return { server, session, stop };
}

export type StartedServer = Awaited<ReturnType<typeof startServer>>;
export type { ScrcpySession };
