# serve-emul

Host your Android emulator or attached Android device for agent workflows like Codex, Cursor, Claude Desktop, and browser-based QA. `serve-emul` streams the screen locally, over your LAN, or through your tunnel of choice, then accepts low-latency input and device-control commands over HTTP and WebSocket.

https://github.com/user-attachments/assets/7dd6d57c-4270-4b13-a733-992b7085d944

```sh
bunx serve-emul@latest
# or: npx serve-emul@latest
# -> Preview at http://localhost:3300
```

Use `@latest` for one-off runs so Bun/npm fetches the newest published version instead of reusing a cached or locally installed copy.

`serve-emul` starts the vendored scrcpy server on the device, opens an adb forward tunnel, forwards H.264 frames over WebSockets, and decodes them in the browser with WebCodecs. Input events are written directly to scrcpy's control socket instead of shelling out to `adb shell input`, keeping taps, swipes, text, and key events responsive enough for agents.

## Status

Current package version: see [`packages/serve-emul/package.json`](packages/serve-emul/package.json) and [`packages/serve-emul/CHANGELOG.md`](packages/serve-emul/CHANGELOG.md).

Working:

- Live H.264 video stream from device to WebCodecs canvas
- Tap, swipe, text, keyevent, Back, Home, Recents, and Power input
- Multi-client streaming, so multiple browser tabs can share one device
- SPS/PPS replay and metadata headers for clients joining mid-stream
- Device discovery, current-device switching, and AVD start/stop controls
- Screenshot, foreground app, accessibility tree, and logcat APIs for agent inspection
- Orientation, dark/light mode, font scale, and network on/off controls
- Emulator GPS location control and route playback from GPX, GeoJSON, KML, or waypoint JSON
- Session recording and replay for REST, WebSocket, and location events
- APK install, app launch, clear data, force stop, permission grant, and media/file import helpers

Planned:

- Multi-device routing
- Embeddable Connect-style middleware (`serve-emul/middleware`)
- Compiled single binary

## Requirements

- Bun 1.1+
- `adb` on PATH from Android platform-tools
- A booted device/emulator from `adb devices`, or an AVD name passed with `--avd`
- Chrome, Edge, or Safari 16.4+ for the bundled WebCodecs UI

Node.js 18+ can invoke the published package through `npx`, but local development and server runtime use Bun.

## Quick Start

One-off run from npm:

```sh
bunx serve-emul@latest
# or
npx serve-emul@latest
```

Local development from this repository:

```sh
bun install
bun run --filter serve-emul setup
bun run packages/serve-emul/src/cli.ts
# -> http://localhost:3300
```

`setup` downloads the pinned `scrcpy-server-v4.0` into `packages/serve-emul/vendor/` and builds the browser UI. The CLI also runs the scrcpy setup lazily on first start, so you can skip the setup step for a quick local run.

## CLI

```text
serve-emul [-p <port>] [-s <serial>] [--max-fps N] [--bit-rate N] [--max-size N] [--key-frame-interval sec]
serve-emul --avd <name> [--restart-avd]
serve-emul --avd-list
serve-emul --running-avds
```

| flag | default | meaning |
| --- | --- | --- |
| `-p, --port` | `3300` | HTTP port for the preview server |
| `-s, --serial` | auto | adb device serial; required when multiple devices are online |
| `--max-fps` | `60` | Cap source frame rate |
| `--bit-rate` | `8000000` | H.264 bit rate in bps |
| `--max-size` | `1920` | Downscale the longest edge to N pixels; `0` keeps native size |
| `--key-frame-interval` | `1` | Ask the encoder for regular keyframes; `0` disables this codec option |
| `--avd` | none | Launch this Android Virtual Device before streaming |
| `--restart-avd` | false | Stop a running matching AVD before launching it |
| `--avd-list` | false | List available Android Virtual Device names |
| `--running-avds` | false | List currently running emulator serials and AVD names |
| `--emulator` | auto | Android Emulator binary path; defaults to PATH or Android SDK env vars |
| `--emulator-port` | auto | Emulator console port for `--avd`; must be an even port from 5554 through 5682 |

By default, `serve-emul` attaches to the only online device. If more than one device is online, pass `-s <serial>` or select another running device later through the HTTP API/UI.

## Browser UI

Open `http://localhost:3300` after starting the CLI. The UI streams the device into a canvas and exposes controls for:

- Pointer input, text entry, hardware buttons, and screenshots
- Device selection plus AVD start/stop
- Orientation, night mode, font scale, network, GPS location, and route playback
- Logcat filtering, pause/copy controls, app management, file import, and session replay

## HTTP API

All examples assume the default port:

```sh
BASE=http://localhost:3300
```

### Health And Discovery

```sh
curl "$BASE/health"
curl "$BASE/api"
curl "$BASE/api/devices"
curl "$BASE/api/device-grid"
curl -X POST "$BASE/api/devices/select" \
  -H 'Content-Type: application/json' \
  -d '{"serial":"emulator-5554"}'
```

AVD lifecycle helpers:

```sh
curl -X POST "$BASE/api/avds/start" \
  -H 'Content-Type: application/json' \
  -d '{"avd":"Pixel_8","select":true}'

curl -X POST "$BASE/api/avds/stop" \
  -H 'Content-Type: application/json' \
  -d '{"serial":"emulator-5554"}'
```

### Input

Coordinates are normalized from `0` to `1` and converted to screen pixels by the server.

```sh
curl -X POST "$BASE/api/tap" \
  -H 'Content-Type: application/json' \
  -d '{"x":0.5,"y":0.5}'

curl -X POST "$BASE/api/swipe" \
  -H 'Content-Type: application/json' \
  -d '{"x1":0.5,"y1":0.8,"x2":0.5,"y2":0.2,"durationMs":350}'

curl -X POST "$BASE/api/text" \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello"}'

curl -X POST "$BASE/api/key" \
  -H 'Content-Type: application/json' \
  -d '{"key":"back"}'
```

### Inspection

```sh
curl "$BASE/api/screenshot" --output screen.png
curl "$BASE/api/screenshot?format=base64"
curl "$BASE/api/foreground"
curl "$BASE/api/accessibility"
curl -N "$BASE/api/logcat?package=com.example.app&search=error"
```

### Device Settings

```sh
curl "$BASE/api/orientation"
curl -X POST "$BASE/api/orientation" \
  -H 'Content-Type: application/json' \
  -d '{"orientation":"landscape"}'

curl "$BASE/api/night-mode"
curl -X POST "$BASE/api/night-mode" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"dark"}'

curl "$BASE/api/font-scale"
curl -X POST "$BASE/api/font-scale" \
  -H 'Content-Type: application/json' \
  -d '{"scale":1.2}'

curl "$BASE/api/network"
curl -X POST "$BASE/api/network" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}'
```

### Location And Routes

Location control uses the Android Emulator `geo fix` command and is currently emulator-only.

```sh
curl "$BASE/api/location"
curl -X POST "$BASE/api/location" \
  -H 'Content-Type: application/json' \
  -d '{"latitude":37.5665,"longitude":126.978}'
```

Start route playback from waypoints:

```sh
curl -X POST "$BASE/api/route" \
  -H 'Content-Type: application/json' \
  -d '{"speedKph":30,"multiplier":1,"loop":false,"waypoints":[{"latitude":37.5665,"longitude":126.978},{"latitude":37.5651,"longitude":126.98955}]}'
```

Read, pause, resume, or stop playback:

```sh
curl "$BASE/api/route"
curl -X POST "$BASE/api/route/control" \
  -H 'Content-Type: application/json' \
  -d '{"action":"pause"}'
curl -X DELETE "$BASE/api/route"
```

### Sessions

REST and WebSocket input events are recorded by default. Add `"record":false` to supported input payloads when an event should not be saved.

```sh
curl "$BASE/api/session"
curl -X POST "$BASE/api/session/replay" \
  -H 'Content-Type: application/json' \
  -d '{"multiplier":2}'
curl -X POST "$BASE/api/session/replay/stop"
curl -X DELETE "$BASE/api/session"
```

### Apps And Files

```sh
curl -X POST "$BASE/api/apps/install" \
  -F apk=@/path/to/app.apk

curl -X POST "$BASE/api/apps/launch" \
  -H 'Content-Type: application/json' \
  -d '{"packageName":"com.example.app","activity":".MainActivity"}'

curl -X POST "$BASE/api/apps/clear" \
  -H 'Content-Type: application/json' \
  -d '{"packageName":"com.example.app"}'

curl -X POST "$BASE/api/apps/force-stop" \
  -H 'Content-Type: application/json' \
  -d '{"packageName":"com.example.app"}'

curl -X POST "$BASE/api/apps/grant" \
  -H 'Content-Type: application/json' \
  -d '{"packageName":"com.example.app","permission":"android.permission.POST_NOTIFICATIONS"}'

curl -X POST "$BASE/api/files/import" \
  -F file=@/path/to/image.png
```

## WebSocket API

Connect to `/ws` for the raw Annex-B H.264 stream. Send JSON control messages over the same socket:

```json
{"type":"tap","x":0.5,"y":0.5}
{"type":"swipe","x1":0.5,"y1":0.8,"x2":0.5,"y2":0.2,"durationMs":350}
{"type":"text","text":"hello"}
{"type":"key","keycode":66}
{"type":"back"}
{"type":"reset-video"}
```

Use `/ws?frame-meta=1` to receive a 16-byte `SEMU` frame metadata header before each H.264 access unit. The bundled UI uses this mode to avoid per-frame NAL scans and to track PTS/keyframe state.

## How It Works

```text
+------------------+ adb forward  +-------------+  H.264 / WS   +---------+
| scrcpy-server.jar| <----------> | serve-emul  | ------------> | Browser |
| on device        | TCP tunnel   |   (Bun)     |  WebCodecs    | <canvas>|
|  - video socket  |              |             | <------------ |         |
|  - control socket|              |             |  input JSON   |         |
+------------------+              +-------------+               +---------+
```

1. The CLI pushes `scrcpy-server-v4.0` to `/data/local/tmp/scrcpy-server.jar`.
2. It opens `adb forward tcp:<localPort> localabstract:scrcpy_<scid>`.
3. It spawns `app_process` with the scrcpy server class on the device, then connects video and control sockets through the tunnel.
4. The Bun server reads scrcpy's framed H.264 stream and forwards each access unit as a binary WebSocket message. Raw `/ws` clients receive Annex-B payloads unchanged; the built-in browser UI opts into the 16-byte frame metadata header.
5. The browser configures a `VideoDecoder` from SPS/PPS data and draws decoded frames to a `<canvas>`. Pointer events are normalized to unit coordinates and encoded as scrcpy control socket packets.

## Development

```sh
bun install
bun run --filter serve-emul setup
bun run --filter serve-emul dev
bun run --filter serve-emul typecheck
bun run --filter serve-emul typecheck:ui
bun run --filter serve-emul build
```

For runtime or protocol changes, test with a booted emulator or device:

```sh
adb devices
bun run packages/serve-emul/src/cli.ts
```

Useful manual checks include first video frame, browser refresh recovery, multiple tabs, tap/swipe/text/key input, screenshots, logcat SSE, app management, location, route playback, and session replay.

## Package Rename

The npm package name is `serve-emul`. npm package names cannot be renamed in place, so releases under this name should be published as a new package:

```sh
npm publish --workspace packages/serve-emul
npm deprecate serve-emu "Package renamed to serve-emul. Use: npm install serve-emul"
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development setup, validation steps, scrcpy protocol notes, and pull request guidelines.

## License

Apache-2.0. Bundles the upstream [scrcpy](https://github.com/Genymobile/scrcpy) server binary (Apache-2.0) at runtime.
