import { spawn } from "node:child_process";

// All adb/emulator subprocess work must stay OFF the event loop. `Bun.serve`
// runs the video frame pump on the same single JS thread, so a synchronous
// `spawnSync` freezes streaming for the whole adb round-trip. Every feature
// query/mutation goes through these async helpers instead, and a small
// concurrency gate keeps a burst of requests from spawning dozens of adb
// processes at once (which would overload adbd and stall responses).

const MAX_CONCURRENT = 4;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

let active = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) {
    next();
    return;
  }
  active--;
}

export type ExecOpts = {
  timeout?: number;
  maxBuffer?: number;
};

export type ExecResult<T extends string | Buffer> = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: T;
  stderr: string;
  timedOut: boolean;
  error: Error | null;
};

function run<T extends string | Buffer>(
  cmd: string,
  args: string[],
  opts: ExecOpts,
  encoding: "utf8" | "buffer",
): Promise<ExecResult<T>> {
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  return new Promise<ExecResult<T>>((resolve) => {
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outLen = 0;
    let settled = false;
    let timedOut = false;

    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    const timer = opts.timeout
      ? setTimeout(() => {
          timedOut = true;
          try {
            child.kill("SIGKILL");
          } catch {}
        }, opts.timeout)
      : null;

    const finish = (status: number | null, signal: NodeJS.Signals | null, error: Error | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const stdoutBuf = Buffer.concat(outChunks);
      resolve({
        status,
        signal,
        stdout: (encoding === "buffer" ? stdoutBuf : stdoutBuf.toString("utf8")) as T,
        stderr: Buffer.concat(errChunks).toString("utf8"),
        timedOut,
        error,
      });
    };

    child.stdout.on("data", (d: Buffer) => {
      outLen += d.length;
      if (outLen > maxBuffer) {
        try {
          child.kill("SIGKILL");
        } catch {}
        finish(null, null, new Error("maxBuffer exceeded"));
        return;
      }
      outChunks.push(d);
    });
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));
    child.once("error", (err) => finish(null, null, err));
    child.once("close", (status, signal) => finish(status, signal, null));
  });
}

async function execGated<T extends string | Buffer>(
  cmd: string,
  args: string[],
  opts: ExecOpts,
  encoding: "utf8" | "buffer",
): Promise<ExecResult<T>> {
  await acquire();
  try {
    return await run<T>(cmd, args, opts, encoding);
  } finally {
    release();
  }
}

export function execText(cmd: string, args: string[], opts: ExecOpts = {}): Promise<ExecResult<string>> {
  return execGated<string>(cmd, args, opts, "utf8");
}

export function execBuffer(cmd: string, args: string[], opts: ExecOpts = {}): Promise<ExecResult<Buffer>> {
  return execGated<Buffer>(cmd, args, opts, "buffer");
}
