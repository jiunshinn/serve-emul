import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { listAllDevices } from "./adb.ts";
import { execText, type ExecResult } from "./exec.ts";

export type EmulatorLaunch = {
  serial: string;
  proc: ChildProcess | null;
  ownsProcess: boolean;
  stop: () => void;
};

export type RunningAvd = {
  serial: string;
  avd: string;
  state: string;
};

export type StartEmulatorOpts = {
  avd: string;
  emulatorPath?: string;
  port?: number;
  restartAvd?: boolean;
  bootTimeoutMs?: number;
  /**
   * Emulator `-gpu` mode. Defaults to `host` because the AVD's own `auto`
   * frequently falls back to a software Vulkan compositor (llvmpipe/lavapipe),
   * which caps the guest at a janky ~20fps and makes the stream stutter no
   * matter how good the transport is. `host` uses the real GPU (Metal/Vulkan)
   * for smooth ~60fps rendering. Pass `swiftshader_indirect` for headless hosts
   * without a usable GPU.
   */
  gpu?: string;
};

function sdkEmulatorCandidates(): string[] {
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.HOME ? join(process.env.HOME, "Library", "Android", "sdk") : undefined,
  ].filter((v): v is string => Boolean(v));
  return [...new Set(roots)].flatMap((root) => [
    join(root, "emulator", "emulator"),
    join(root, "tools", "emulator"),
  ]);
}

export async function resolveEmulator(explicit?: string): Promise<string> {
  if (explicit) return explicit;

  const pathProbe = await execText("emulator", ["-version"]);
  if (pathProbe.status === 0 || pathProbe.error?.message.includes("EPIPE")) return "emulator";

  for (const candidate of sdkEmulatorCandidates()) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    "Could not find Android Emulator. Put `emulator` on PATH or set ANDROID_HOME / ANDROID_SDK_ROOT.",
  );
}

async function listAvdsWithEmulator(emulator: string): Promise<string[]> {
  const r = await execText(emulator, ["-list-avds"]);
  if (r.status !== 0) {
    throw new Error(`emulator -list-avds failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function listAvds(emulatorPath?: string): Promise<string[]> {
  return listAvdsWithEmulator(await resolveEmulator(emulatorPath));
}

function avdName(avd: string): string {
  return avd.startsWith("@") ? avd.slice(1) : avd;
}

function emulatorAvdArg(avd: string): string {
  return avd.startsWith("@") ? avd : `@${avd}`;
}

async function usedEmulatorPorts(): Promise<Set<number>> {
  const ports = new Set<number>();
  for (const device of await listAllDevices()) {
    const match = device.serial.match(/^emulator-(\d+)$/);
    if (match) ports.add(Number(match[1]));
  }
  return ports;
}

async function pickEmulatorPort(): Promise<number> {
  const used = await usedEmulatorPorts();
  for (let port = 5554; port <= 5682; port += 2) {
    if (!used.has(port)) return port;
  }
  throw new Error("No available emulator console ports in the 5554-5682 range.");
}

function validateEmulatorPort(port: number): void {
  if (!Number.isInteger(port) || port < 5554 || port > 5682 || port % 2 !== 0) {
    throw new Error("--emulator-port must be an even integer from 5554 through 5682.");
  }
}

function adb(serial: string, args: string[]): Promise<ExecResult<string>> {
  return execText("adb", ["-s", serial, ...args], { timeout: 5_000 });
}

function parseEmuAvdName(stdout: string): string | null {
  return (
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && line !== "OK" && !line.startsWith("KO:")) ?? null
  );
}

async function runningAvdName(serial: string): Promise<string | null> {
  const fromConsole = await adb(serial, ["emu", "avd", "name"]);
  if (fromConsole.status === 0) {
    const name = parseEmuAvdName(fromConsole.stdout);
    if (name) return name;
  }

  const fromProp = await adb(serial, ["shell", "getprop", "ro.boot.qemu.avd_name"]);
  if (fromProp.status === 0) {
    const name = fromProp.stdout.trim();
    if (name) return name;
  }

  return null;
}

export async function listRunningAvds(): Promise<RunningAvd[]> {
  const emulators = (await listAllDevices()).filter((device) => /^emulator-\d+$/.test(device.serial));
  const named = await Promise.all(
    emulators.map(async (device) => {
      const avd = await runningAvdName(device.serial);
      return avd ? { serial: device.serial, avd, state: device.state } : null;
    }),
  );
  return named.filter((entry): entry is RunningAvd => entry !== null);
}

async function findRunningAvd(name: string): Promise<RunningAvd | null> {
  return (await listRunningAvds()).find((running) => running.avd === name) ?? null;
}

export async function stopEmulator(serial: string): Promise<void> {
  const r = await adb(serial, ["emu", "kill"]);
  if (r.status !== 0) {
    throw new Error(`Failed to stop ${serial}: ${r.stderr || r.stdout}`);
  }
}

async function waitForEmulatorExit(serial: string, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await listAllDevices()).some((device) => device.serial === serial)) return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${serial} to stop.`);
}

async function waitForBoot(serial: string, proc: ChildProcess, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`emulator exited before boot completed (code ${proc.exitCode ?? "null"})`);
    }

    const state = await adb(serial, ["get-state"]);
    if (state.status === 0 && state.stdout.trim() === "device") {
      const boot = await adb(serial, ["shell", "getprop", "sys.boot_completed"]);
      if (boot.status === 0 && boot.stdout.trim() === "1") return;
    }

    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for ${serial} to boot.`);
}

export async function startEmulator(opts: StartEmulatorOpts): Promise<EmulatorLaunch> {
  const emulator = await resolveEmulator(opts.emulatorPath);
  const name = avdName(opts.avd);
  const avds = await listAvdsWithEmulator(emulator);
  if (!avds.includes(name)) {
    const available = avds.length ? avds.join(", ") : "(none)";
    throw new Error(`Unknown AVD "${name}". Available AVDs: ${available}`);
  }

  const running = await findRunningAvd(name);
  if (running) {
    if (!opts.restartAvd) {
      return { serial: running.serial, proc: null, ownsProcess: false, stop: () => {} };
    }
    await stopEmulator(running.serial);
    await waitForEmulatorExit(running.serial);
  }

  const port = opts.port ?? (await pickEmulatorPort());
  validateEmulatorPort(port);

  const args = [emulatorAvdArg(name), "-port", String(port)];
  if (opts.gpu) args.push("-gpu", opts.gpu);

  const proc = spawn(emulator, args, { stdio: ["ignore", "inherit", "inherit"] });
  const spawnError = new Promise<never>((_, reject) => {
    proc.once("error", reject);
  });
  const serial = `emulator-${port}`;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    adb(serial, ["emu", "kill"]).catch(() => {});
    try {
      proc.kill("SIGTERM");
    } catch {}
  };

  try {
    await Promise.race([waitForBoot(serial, proc, opts.bootTimeoutMs ?? 120_000), spawnError]);
    return { serial, proc, ownsProcess: true, stop };
  } catch (err) {
    stop();
    throw err;
  }
}
