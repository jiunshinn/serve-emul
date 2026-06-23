# Changelog

All notable changes to `serve-emul` are documented here.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html):

- `patch` for fixes and small internal improvements
- `minor` for backwards-compatible user-facing features or APIs
- `major` for breaking CLI, HTTP API, WebSocket protocol, package, or runtime behavior

## 0.0.4 - 2026-06-21

### Added

- Release helper for patch, minor, major, and exact-version bumps.
- Release validation script that runs tests, server typecheck, UI typecheck, and the production UI build.

### Changed

- Bump the package version from 0.0.3 to 0.0.4.
- Document the release process and align README status text with the package version.

## 0.0.3 - 2026-06-21

### Added

- Device orientation, night mode, font scale, and multi-device routing controls.
- Logcat streaming, accessibility inspection, app management, route playback, and session replay workflows.
- H.264 WebSocket streaming with WebCodecs browser decoding and REST/WebSocket input controls.
