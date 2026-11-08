# Third-party sources and replacement

The matching GitHub Release provides `MotionPhotoStudio-<version>-third-party-sources.tar.gz` alongside the portable ZIP and SHA256SUMS.txt. This is a source archive, not a runtime download requirement. Keep the source attachment available for as long as its corresponding binary is offered.

## FFmpeg executables

The release builds FFmpeg, x264, x265, zimg and zlib from the exact commits in SOURCE-PINS.json. The source bundle contains each source snapshot, license texts within those snapshots, this repository's build-engine.sh and prepare-sources.mjs, the actual FFmpeg configure log and build-tool versions. No developer-machine FFmpeg snapshot or floating latest binary is republished. FFmpeg is configured as GPLv3-or-later, without nonfree components. See COPYING.GPLv3 in its source and the ffmpeg-* notices in the portable application's resources/licenses directory.

To rebuild, use an Ubuntu 24.04 x64 environment with MinGW-w64, GCC/G++, make, nasm, CMake, autoconf, automake, libtool, pkg-config and Node 24. Source commits and executable integrity are pinned; this is not a claim that differing compilers produce byte-identical executables. Reconstruct the repo folders named by SOURCE-PINS.json and run build-engine.sh; the workflow and source-collection script record the complete commands. The Git snapshots identify the source versions used by configure/version scripts.

You may replace FFmpeg with your compatible rebuilt executables. Update resources/engine-manifest.json's executable sizes/SHA256 and exact `-version` build string together; this is an integrity check, not a signature preventing replacement. Preserve the required CLI/codec/filter interfaces. The application communicates with these separate executables through processes, not by linking libav libraries into its application code.

## Sharp / Windows libvips

The source bundle includes the matching sharp, sharp-libvips, build-win64-mxe and MXE repositories, all patches/recipes, the checked source archives for every component listed by the pinned Windows npm package, and librsvg's locked Rust source dependencies. IMAGE-SOURCE-PROVENANCE.json records the versions, npm integrity and the exact upstream libvips SDK and DLL SHA256 match. SHARP-LIBVIPS-THIRD-PARTY-NOTICES.md contains upstream third-party notices.

The upstream build-win64-mxe build.sh documents rebuilding the x86_64 web/static variant. Supply image-dependencies archives to MXE's pkg directory; use the provided librsvg-cargo-config.toml, adjusting its vendor directory path to the extracted librsvg-rust-vendor folder, for offline Rust dependency resolution. The upstream build recipes, not just project homepages, are included. System toolchains are obtained separately. Refer to sharp's pinned source and build scripts to rebuild its C++ wrapper and Node binding.

LGPL-covered libraries remain replaceable DLLs under resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/. Keep the expected ABI/file names; rebuild the wrapper/binding from the provided sharp sources if needed. No application licensing notice restricts modification, replacement or reverse engineering needed to debug modifications to LGPL components. Third-party licenses and rights remain separate from the application's own copyright.

## Other components

Electron's LICENSE and LICENSES.chromium.html accompany its runtime. Rust dependency/toolchain notices accompany the native helper under resources/licenses/native-preview. JavaScript dependencies retain their bundled package licenses. This collection records technical provenance and source availability; it is not a legal certification, codec patent license, clean-machine certification or phone-compatibility guarantee.
