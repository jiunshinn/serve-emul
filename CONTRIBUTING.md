# Contributing to serve-emul

Thanks for taking the time to improve `serve-emul`. This project sits between
Android devices, scrcpy, Bun, WebSockets, and a browser UI, so small protocol or
latency changes can have large user-visible effects. Please keep changes focused
and include enough verification detail for reviewers to reproduce your results.

## Development Setup

Requirements:

- Bun 1.1+
- Node.js 18+
- Android platform-tools with `adb` on `PATH`
- A booted Android emulator or attached Android device
- Chrome, Edge, or Safari 16.4+ for WebCodecs support

Install dependencies:

```sh
bun install
```

Fetch the vendored scrcpy server and build the browser UI:

```sh
bun run --filter serve-emul setup
```

Run the local server:

```sh
bun run packages/serve-emul/src/cli.ts
```

Then open `http://localhost:3300`.

Useful alternatives:

```sh
bun run dev
bun run --filter serve-emul dev:ui
bun run --filter serve-emul start
```

## Project Layout

- `packages/serve-emul/src/cli.ts` - CLI entry point
- `packages/serve-emul/src/server.ts` - HTTP, WebSocket, and API server
- `packages/serve-emul/src/scrcpy.ts` - scrcpy server lifecycle and video stream handling
- `packages/serve-emul/src/input.ts` - scrcpy control socket message encoding
- `packages/serve-emul/src/emulator.ts` - Android Emulator discovery and launch helpers
- `packages/serve-emul/src/ui/` - React browser UI
- `packages/serve-emul/scripts/fetch-scrcpy.ts` - pinned scrcpy server downloader

Prefer kebab-case for TypeScript and JavaScript filenames.

## Validation

Before opening a pull request, run the checks that match your change:

```sh
bun run --filter serve-emul typecheck
bun run --filter serve-emul typecheck:ui
bun run --filter serve-emul build
```

For runtime changes, also test against a real device or emulator:

```sh
adb devices
bun run packages/serve-emul/src/cli.ts
```

Verify the relevant user flow in the browser, such as:

- live video starts and recovers after refresh
- taps, swipes, text input, and hardware buttons work
- multiple browser tabs can share one stream
- `/api/screenshot`, `/api/tap`, `/api/text`, and other changed APIs behave as expected
- app management, logcat, location, route playback, or session replay still work if touched

If there is no automated test for your change, mention the manual verification
you performed in the pull request.

## scrcpy and ADB Notes

Streaming uses the vendored scrcpy server at `vendor/scrcpy-server-v<VERSION>`.
The pinned version is controlled by `packages/serve-emul/scripts/fetch-scrcpy.ts`.

The scrcpy wire protocol can drift between major versions. If you bump the
scrcpy server version, re-validate `packages/serve-emul/src/scrcpy.ts` against the
new server and document what changed.

Current protocol shape:

- open two sockets through `adb forward tcp:<port> localabstract:scrcpy_<scid>`
- both sockets start with a 1-byte dummy prefix
- the video socket sends a 64-byte device name and 12-byte codec metadata
- each frame is `[8-byte PTS big-endian, 4-byte size big-endian, Annex-B NALUs]`
- the high bit of PTS marks codec configuration frames
- the control socket consumes binary messages encoded in `src/input.ts`

Do not shell out to `adb shell input` for device interaction. Write to scrcpy's
control socket instead; the latency difference is large enough to affect agent
workflows.

If more than one device is connected, require or pass `-s <serial>`. The default
target should be the only booted device.

## Pull Request Guidelines

Please keep pull requests small and focused. A good PR includes:

- a short description of the user-visible behavior change
- screenshots, recordings, or API examples when UI or runtime behavior changes
- the commands you ran for validation
- any device/emulator model and Android version used for manual testing
- notes about protocol, latency, or compatibility risks

Avoid unrelated formatting, generated file churn, and broad refactors unless they
are needed for the change.

## Commit Guidelines

Use atomic commits. Commit only files you changed, and list each file path
explicitly in the commit command.

For tracked files:

```sh
git commit -m "<scoped message>" -- path/to/file1 path/to/file2
```

For brand-new files, clear staged state first, then stage only the files you
created:

```sh
git restore --staged :/
git add "path/to/file1" "path/to/file2"
git commit -m "<scoped message>" -- path/to/file1 path/to/file2
```

## Release Guidelines

`serve-emul` uses the package version in `packages/serve-emul/package.json` as the
source of truth. Release tags should be named `v<version>`, for example
`v0.1.0`.

Choose the version bump with semver:

- `patch` for fixes and small internal improvements
- `minor` for backwards-compatible user-facing features or APIs
- `major` for breaking CLI, HTTP API, WebSocket protocol, package, or runtime behavior

Prepare a release:

```sh
bun run release -- patch
```

You can also pass `minor`, `major`, or an exact version such as `0.1.0`.

Before publishing, review `packages/serve-emul/CHANGELOG.md`, then run:

```sh
bun run check
```

That runs the package tests, server typecheck, UI typecheck, and production UI
build.

Commit only the version and changelog files, then tag and publish:

```sh
git commit -m "Release v<version>" -- packages/serve-emul/package.json packages/serve-emul/CHANGELOG.md
git tag v<version>
npm publish packages/serve-emul
git push origin HEAD --tags
```

## Reporting Issues

When reporting a bug, include:

- `serve-emul` version or commit SHA
- Bun and Node.js versions
- host OS
- device or emulator type and Android version
- `adb devices` output with serials redacted if needed
- exact command used to start `serve-emul`
- browser and version
- logs, screenshots, or a short recording if available

For streaming problems, note whether the issue affects first load, refresh,
multiple tabs, keyframe recovery, input latency, or all video output.
