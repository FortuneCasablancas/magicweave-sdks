# Changelog

## [0.1.0] — unreleased

Initial release.

- Ergonomics behaviours E1–E5 (connect once, session, crash-safe writes, offline queue, retry).
- Generated transport for all 88 client-API operations.
- `MagicweaveSettings` asset plus `Window → Magicweave → Setup` for environment switching (E8).
- `UnityWebRequest` transport — works on WebGL, no threads.
- File-backed storage under `persistentDataPath`, with atomic write-then-rename.
- Quick Start sample.

Not yet implemented: realtime (E6) and the typed catalog (E7).
