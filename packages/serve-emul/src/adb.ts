import { spawn, spawnSync } from "node:child_process";

const ADB_QUERY_TIMEOUT_MS = 2_000;
const ADB_MUTATION_TIMEOUT_MS = 5_000;
const ADB_SCREENSHOT_TIMEOUT_MS = 8_000;

export type Device = { serial: string; state: string };
export type OrientationMode = "auto" | "portrait" | "landscape";
export type NightMode = "auto" | "dark" | "light";
export type OrientationStatus = {
  mode: "free" | "lock" | "unknown";
  rotation: number | null;
  orientation: OrientationMode | "unknown";
  raw: string;
};
export type FontScaleStatus = {
  scale: number;
  raw: string;
};
export type NightModeStatus = {
  mode: NightMode | "unknown";
  raw: string;
};
export type NetworkRadioStatus = "enabled" | "disabled" | "unknown";
export type NetworkStatus = {
  enabled: boolean | null;
  wifi: NetworkRadioStatus;
  mobileData: NetworkRadioStatus;
  raw: {
    wifi: string;
    mobileData: string;
  };
};

export function listAllDevices(): Device[] {
  const r = spawnSync("adb", ["devices"], { encoding: "utf8", timeout: ADB_QUERY_TIMEOUT_MS });
  if (r.status !== 0) throw new Error(`adb devices failed: ${r.stderr}`);
  return r.stdout
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [serial, state] = l.split(/\s+/);
      return { serial, state };
    });
}

export function listDevices(): Device[] {
  return listAllDevices().filter((d) => d.state === "device");
}

export function pickDevice(explicit?: string): string {
  if (explicit) return explicit;
  const devices = listDevices();
  if (devices.length === 0) throw new Error("No booted Android device found. Start an emulator or attach a device.");
  if (devices.length > 1)
    throw new Error(
      `Multiple devices online (${devices.map((d) => d.serial).join(", ")}). Pass -s <serial>.`,
    );
  return devices[0].serial;
}

export function screencapPng(serial: string): Buffer {
  const r = spawnSync("adb", ["-s", serial, "exec-out", "screencap", "-p"], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    timeout: ADB_SCREENSHOT_TIMEOUT_MS,
  });
  if (r.status !== 0) throw new Error(`screencap failed: ${r.stderr.toString()}`);
  return r.stdout;
}

export function shell(serial: string, cmd: string[]): void {
  const r = spawnSync("adb", ["-s", serial, "shell", ...cmd], {
    encoding: "utf8",
    timeout: ADB_MUTATION_TIMEOUT_MS,
  });
  if (r.status !== 0) throw new Error(`adb shell ${cmd.join(" ")} failed: ${r.stderr}`);
}

export function shellSpawn(serial: string, cmd: string[]) {
  return spawn("adb", ["-s", serial, "shell", ...cmd]);
}

export function getDeviceSize(serial: string): { width: number; height: number } {
  const r = spawnSync("adb", ["-s", serial, "shell", "wm", "size"], {
    encoding: "utf8",
    timeout: ADB_QUERY_TIMEOUT_MS,
  });
  if (r.status !== 0) throw new Error(`wm size failed: ${r.stderr}`);
  const m = r.stdout.match(/(\d+)x(\d+)/);
  if (!m) throw new Error(`Could not parse wm size output: ${r.stdout}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

function orientationFromRotation(mode: "free" | "lock" | "unknown", rotation: number | null): OrientationStatus["orientation"] {
  if (mode === "free") return "auto";
  if (rotation === 0 || rotation === 2) return "portrait";
  if (rotation === 1 || rotation === 3) return "landscape";
  return "unknown";
}

export function getUserRotation(serial: string): OrientationStatus {
  const r = spawnSync("adb", ["-s", serial, "shell", "cmd", "window", "user-rotation"], {
    encoding: "utf8",
    timeout: ADB_QUERY_TIMEOUT_MS,
  });
  if (r.status !== 0) throw new Error(`cmd window user-rotation failed: ${r.stderr}`);
  const raw = r.stdout.trim();
  const match = raw.match(/^(free|lock)(?:\s+(\d+))?$/);
  if (!match) {
    return { mode: "unknown", rotation: null, orientation: "unknown", raw };
  }
  const mode = match[1] as "free" | "lock";
  const rotation = match[2] === undefined ? null : Number(match[2]);
  return { mode, rotation, orientation: orientationFromRotation(mode, rotation), raw };
}

export function setUserRotation(serial: string, orientation: OrientationMode): OrientationStatus {
  const args =
    orientation === "auto"
      ? ["cmd", "window", "user-rotation", "free"]
      : ["cmd", "window", "user-rotation", "lock", orientation === "portrait" ? "0" : "1"];
  const r = spawnSync("adb", ["-s", serial, "shell", ...args], {
    encoding: "utf8",
    timeout: ADB_MUTATION_TIMEOUT_MS,
  });
  if (r.status !== 0) throw new Error(`adb shell ${args.join(" ")} failed: ${r.stderr}`);
  return getUserRotation(serial);
}

export function getFontScale(serial: string): FontScaleStatus {
  const r = spawnSync("adb", ["-s", serial, "shell", "settings", "get", "system", "font_scale"], {
    encoding: "utf8",
    timeout: ADB_QUERY_TIMEOUT_MS,
  });
  if (r.status !== 0) throw new Error(`settings get system font_scale failed: ${r.stderr}`);
  const raw = r.stdout.trim();
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`Could not parse font_scale output: ${r.stdout}`);
  }
  return { scale, raw };
}

export function setFontScale(serial: string, scale: number): FontScaleStatus {
  if (!Number.isFinite(scale) || scale < 0.7 || scale > 2) {
    throw new Error("font scale must be between 0.7 and 2.0");
  }
  const normalized = scale.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  const args = ["settings", "put", "system", "font_scale", normalized];
  const r = spawnSync("adb", ["-s", serial, "shell", ...args], {
    encoding: "utf8",
    timeout: ADB_MUTATION_TIMEOUT_MS,
  });
  if (r.status !== 0) throw new Error(`adb shell ${args.join(" ")} failed: ${r.stderr}`);
  return getFontScale(serial);
}

function nightModeFromRaw(raw: string): NightMode | "unknown" {
  const match = raw.match(/Night mode:\s*(\S+)/i);
  const value = (match?.[1] ?? raw).trim().toLowerCase();
  if (value === "yes") return "dark";
  if (value === "no") return "light";
  if (value === "auto") return "auto";
  return "unknown";
}

export function getNightMode(serial: string): NightModeStatus {
  const r = spawnSync("adb", ["-s", serial, "shell", "cmd", "uimode", "night"], {
    encoding: "utf8",
    timeout: ADB_QUERY_TIMEOUT_MS,
  });
  if (r.status !== 0) throw new Error(`cmd uimode night failed: ${r.stderr}`);
  const raw = r.stdout.trim();
  return { mode: nightModeFromRaw(raw), raw };
}

export function setNightMode(serial: string, mode: NightMode): NightModeStatus {
  const value = mode === "dark" ? "yes" : mode === "light" ? "no" : "auto";
  const args = ["cmd", "uimode", "night", value];
  const r = spawnSync("adb", ["-s", serial, "shell", ...args], {
    encoding: "utf8",
    timeout: ADB_MUTATION_TIMEOUT_MS,
  });
  if (r.status !== 0) throw new Error(`adb shell ${args.join(" ")} failed: ${r.stderr}`);
  return getNightMode(serial);
}

function globalSetting(serial: string, name: string): string {
  const r = spawnSync("adb", ["-s", serial, "shell", "settings", "get", "global", name], {
    encoding: "utf8",
    timeout: ADB_QUERY_TIMEOUT_MS,
  });
  if (r.status !== 0) throw new Error(`settings get global ${name} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function radioStatusFromSetting(raw: string): NetworkRadioStatus {
  if (raw === "1") return "enabled";
  if (raw === "0") return "disabled";
  return "unknown";
}

export function getNetworkStatus(serial: string): NetworkStatus {
  const wifiRaw = globalSetting(serial, "wifi_on");
  const mobileDataRaw = globalSetting(serial, "mobile_data");
  const wifi = radioStatusFromSetting(wifiRaw);
  const mobileData = radioStatusFromSetting(mobileDataRaw);
  const radios = [wifi, mobileData];
  const knownRadios = radios.filter((radio) => radio !== "unknown");
  const enabled = knownRadios.length === 0 ? null : knownRadios.some((radio) => radio === "enabled");
  return {
    enabled,
    wifi,
    mobileData,
    raw: {
      wifi: wifiRaw,
      mobileData: mobileDataRaw,
    },
  };
}

export function setNetworkEnabled(serial: string, enabled: boolean): NetworkStatus {
  const action = enabled ? "enable" : "disable";
  for (const service of ["wifi", "data"]) {
    const args = ["svc", service, action];
    const r = spawnSync("adb", ["-s", serial, "shell", ...args], {
      encoding: "utf8",
      timeout: ADB_MUTATION_TIMEOUT_MS,
    });
    if (r.status !== 0) throw new Error(`adb shell ${args.join(" ")} failed: ${r.stderr}`);
  }
  return getNetworkStatus(serial);
}
