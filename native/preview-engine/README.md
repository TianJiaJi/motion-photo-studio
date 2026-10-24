# motion-preview (Windows x64)

Internal Rust preview helper, now connected to the Electron Canvas editor. This is **not final real-material/performance or packaged-application acceptance**. See the approved `plans/preview-scrubbing-cleanup.md` and evidence in `docs/native-preview-execution.md` at the repository root.

## Build and application resources

Development requires Rust **1.99.1**, target `x86_64-pc-windows-msvc`, rustfmt/Clippy, Visual Studio C++ tools and Windows SDK. Users of the packaged application do not install this toolchain.

Prepare the pinned Cargo.lock dependencies explicitly during development/CI (`cargo +1.99.1 fetch --locked` in this directory). Then, from `app/`:

```text
npm run build:preview-engine
npm run check:preview-engine
npm run build
npm run pack:win
```

The build script checks exact tool versions; runs fmt, strict Clippy, tests and release build with locked/offline dependencies; sets the explicit MSVC x64 target and static CRT; and copies the helper to `app/resources/bin/motion-preview.exe`. It generates `native-preview-manifest.json` and archives Cargo/Rust notices in `resources/licenses/native-preview/`. Application startup and new-session preparation use this resource location, not PATH or a prototype executable override. Build-script or checksum failure must not substitute an older executable.

`target/x86_64-pc-windows-msvc/release/` is build output, not the application runtime search path. Standalone prototype diagnostic scripts may still accept an explicit developer override; production does not.

## Runtime boundary

- One owned helper per editing session; MF read-only local byte stream / persistent Source Reader.
- D3D11 device manager requested where available. D3D initialization is **not verified hardware decoding**; CPU-converted output alone does not establish DXVA usage.
- Explicit NV12 → RGBA conversion (BT.601/709, limited/full), display aperture/alignment, bounded preview dimensions. Decoder reference pictures are traversed without copying every intermediate frame to JS.
- Bounded cache, latest-pending drag request coalescing, foreground priority, separate thumbnail reader and bounded prefetch.
- Separate selected-track MF audio reader on a COM thread, bounded float stereo buffering, WASAPI shared mode and device-clock position. Stop/reset/join is awaited.
- Framed inherited pipes; no TCP listener, shell execution or FFmpeg invocation inside the helper. EOF/shutdown releases resources; an outer watchdog bounds native API stalls.
- The trusted host owns source-frame indexing and verified source/native mapping, compatibility/audio preparation at import, Canvas ACK backpressure, playback scheduling, source identity checks and awaited cleanup. Renderer paths are not accepted.
- FFmpeg/ffprobe remain for import, export and explicit diagnostics/test oracles, not interactive editing. The final frame cover is reconstructed at export from the selected original-source PTS, not from the low-resolution preview JPEG.

## Wire format v1

uint32LE JSON byte length (1..16384), UTF-8 JSON, then response `bodyBytes` raw bytes. Requests have no binary body. Pixel payloads are bounded by 1280×1280×4; top-down RGBA8. Stdout is protocol only; stderr carries diagnostics.

Requests carry `{version:1,id,generation,command,...}`. Commands include:

- `hello`, `open`, `seek`, `read`, `locate`, `thumbnail`, `quality`, `prefetch`, `stats`;
- `resetScan`, `scanFrames`;
- `audioStreams`, `audioScanOpen`, `audioScan`, `audioScanClose`, `audioStart`, `audioStatus`, `audioStop`;
- `close`, `shutdown`.

See `src/protocol.rs` and `app/src/main/media/native-preview.ts` for exact fields/limits. MF timestamps/durations are signed-decimal 100ns strings, not direct original-source PTS. Host `frame-index.ts` validates interval mappings and uses integer source identity. `audioStart` and `audioStatus` return a flat status, not an `audio` wrapper.

## Remaining acceptance and distribution limits

Synthetic tests do not establish sustained real-material scrubbing, physical AV latency, hardware decode, clean offline installation or target-phone compatibility. Missing Media Foundation is a system-capability error; Windows N may need Media Feature Pack. Import transcoding must not conceal a missing system backend.

This is an internal build, not public redistribution approval. Cargo/Rust notice archiving does not resolve Microsoft static CRT redistribution terms or existing FFmpeg/Sharp obligations; see `THIRD_PARTY_NOTICES.md`.

Local API declarations consulted: Windows SDK 10.0.26100.0 `um/mfreadwrite.h` and windows 0.62.2 generated bindings. No FilmCraft source was copied into this module.
