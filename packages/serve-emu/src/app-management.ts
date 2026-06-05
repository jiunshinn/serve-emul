import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type AppActionResult = {
  ok: true;
  output: string;
};

const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const PERMISSION_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const ACTIVITY_RE = /^([A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+|\.?[A-Za-z][A-Za-z0-9_.$]*)(\/[A-Za-z0-9_.$]+)?$/;

function output(stdout: string, stderr: string): string {
  return `${stdout}${stderr}`.trim();
}

function adb(serial: string, args: string[], timeout = 30_000): AppActionResult {
  const result = spawnSync("adb", ["-s", serial, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout,
  });
  const text = output(result.stdout, result.stderr);
  if (result.status !== 0) {
    throw new Error(text || `adb ${args.join(" ")} failed`);
  }
  return { ok: true, output: text };
}

function validate(value: unknown, name: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value.trim())) {
    throw new Error(`${name} is invalid`);
  }
  return value.trim();
}

export function packageName(value: unknown): string {
  return validate(value, "packageName", PACKAGE_RE);
}

export function activityName(value: unknown): string {
  return validate(value, "activity", ACTIVITY_RE);
}

export function permissionName(value: unknown): string {
  return validate(value, "permission", PERMISSION_RE);
}

export async function installApk(serial: string, file: File): Promise<AppActionResult> {
  if (!file.name.toLowerCase().endsWith(".apk")) throw new Error("APK file must end with .apk");
  const dir = mkdtempSync(join(tmpdir(), "serve-emu-apk-"));
  const path = join(dir, "upload.apk");
  try {
    writeFileSync(path, new Uint8Array(await file.arrayBuffer()));
    return adb(serial, ["install", "-r", path], 120_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function launchApp(serial: string, packageNameValue: string, activity?: string): AppActionResult {
  const pkg = packageName(packageNameValue);
  if (activity) {
    const act = activityName(activity);
    const component = act.includes("/") ? act : `${pkg}/${act}`;
    return adb(serial, ["shell", "am", "start", "-n", component]);
  }
  return adb(serial, [
    "shell",
    "monkey",
    "-p",
    pkg,
    "-c",
    "android.intent.category.LAUNCHER",
    "1",
  ]);
}

export function clearAppData(serial: string, packageNameValue: string): AppActionResult {
  return adb(serial, ["shell", "pm", "clear", packageName(packageNameValue)]);
}

export function forceStopApp(serial: string, packageNameValue: string): AppActionResult {
  return adb(serial, ["shell", "am", "force-stop", packageName(packageNameValue)]);
}

export function grantPermission(
  serial: string,
  packageNameValue: string,
  permissionValue: string,
): AppActionResult {
  return adb(serial, [
    "shell",
    "pm",
    "grant",
    packageName(packageNameValue),
    permissionName(permissionValue),
  ]);
}
