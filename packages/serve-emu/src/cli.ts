#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { pickDevice } from "./adb.ts";
import { listAvds, listRunningAvds, listWebcams, startEmulator } from "./emulator.ts";
import { startServer } from "./server.ts";

const argv = Bun.argv.slice(2);
const { values } = parseArgs({
  args: argv,
  options: {
    port: { type: "string", short: "p", default: "3300" },
    serial: { type: "string", short: "s" },
    "max-fps": { type: "string", default: "60" },
    "bit-rate": { type: "string", default: "8000000" },
    "max-size": { type: "string", default: "1920" },
    avd: { type: "string" },
    "camera-back": { type: "string" },
    "camera-front": { type: "string" },
    "avd-list": { type: "boolean" },
    "running-avds": { type: "boolean" },
    "webcam-list": { type: "boolean" },
    "restart-avd": { type: "boolean" },
    emulator: { type: "string" },
    "emulator-port": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

function hasOption(name: string): boolean {
  const long = `--${name}`;
  return argv.some((arg) => arg === long || arg.startsWith(`${long}=`));
}

function numberOption(name: string, fallback: number): number {
  const value = values[name as keyof typeof values];
  if (typeof value !== "string") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number.`);
  return n;
}

if (values.help) {
  console.log(`serve-emu — host an Android device over scrcpy + WebSocket

Usage:
  serve-emu [-p <port>] [-s <serial>] [--max-fps N] [--bit-rate N] [--max-size N]
  serve-emu --avd <name> (--camera-back <webcam-id> | --camera-front <webcam-id>) [--restart-avd]
  serve-emu --avd-list
  serve-emu --running-avds
  serve-emu --webcam-list

Options:
  -p, --port <port>      Port to listen on (default: 3300)
  -s, --serial <serial>  adb device serial (defaults to the only booted device)
      --max-fps <n>      Cap source frame rate (default: 60, or 30 with host camera)
      --bit-rate <bps>   H.264 bit rate (default: 8000000, or 4000000 with host camera)
      --max-size <px>    Cap longest screen edge in pixels; 0 = native, but many
                         emulators reject native resolutions above ~2560 so this
                         defaults to 1920, or 1280 with host camera.
      --avd <name>       Launch this Android Virtual Device before streaming
      --camera-back <id> Map one host computer camera to the emulator back camera
      --camera-front <id>
                         Map one host computer camera to the emulator front camera
      --restart-avd      Stop a running matching AVD before launching it
      --avd-list         Print available Android Virtual Device names
      --running-avds     Print currently running emulator AVDs
      --webcam-list      Print host camera ids reported by Android Emulator
      --emulator <path>  Android Emulator binary (default: PATH or Android SDK)
      --emulator-port <n>
                         Emulator console port for --avd (even 5554-5682)
  -h, --help             Show this help
`);
  process.exit(0);
}

async function main() {
  if (values["avd-list"]) {
    console.log(listAvds(values.emulator).join("\n"));
    return;
  }

  if (values["running-avds"]) {
    const running = listRunningAvds();
    console.log(running.length ? running.map((avd) => `${avd.serial}\t${avd.avd}\t${avd.state}`).join("\n") : "");
    return;
  }

  if (values["webcam-list"]) {
    console.log(listWebcams(values.emulator));
    return;
  }

  if (
    (values["camera-back"] ||
      values["camera-front"] ||
      values["emulator-port"] ||
      values["restart-avd"]) &&
    !values.avd
  ) {
    throw new Error("--camera-back, --camera-front, --emulator-port, and --restart-avd require --avd.");
  }

  if (values.avd && values.serial) {
    throw new Error("Use either --avd to launch an emulator or --serial to attach to an existing device, not both.");
  }

  if (values["camera-back"] && values["camera-front"]) {
    throw new Error("Use either --camera-back or --camera-front, not both. Map one host camera to one emulator camera facing.");
  }

  let emulatorLaunch: Awaited<ReturnType<typeof startEmulator>> | null = null;
  const serial = values.avd
    ? (emulatorLaunch = await startEmulator({
        avd: values.avd,
        emulatorPath: values.emulator,
        port: values["emulator-port"] ? Number(values["emulator-port"]) : undefined,
        cameraBack: values["camera-back"],
        cameraFront: values["camera-front"],
        restartAvd: values["restart-avd"],
      })).serial
    : pickDevice(values.serial);
  const port = Number(values.port);
  const usesHostCamera = Boolean(values["camera-back"] || values["camera-front"]);
  const maxFps = usesHostCamera && !hasOption("max-fps") ? 30 : numberOption("max-fps", 60);
  const bitRate = usesHostCamera && !hasOption("bit-rate") ? 4_000_000 : numberOption("bit-rate", 8_000_000);
  const maxSize = usesHostCamera && !hasOption("max-size") ? 1280 : numberOption("max-size", 1920);

  const { server, stop: stopServer } = await startServer({
    serial,
    port,
    maxFps,
    bitRate,
    maxSize,
  }).catch((err) => {
    emulatorLaunch?.stop();
    throw err;
  });

  const stop = () => {
    stopServer();
    emulatorLaunch?.stop();
  };
  process.once("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    stop();
    process.exit(0);
  });

  console.log(`serve-emu → http://localhost:${server.port}  (device: ${serial})`);
}

await main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
