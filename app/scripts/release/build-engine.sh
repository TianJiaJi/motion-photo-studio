#!/usr/bin/env bash
set -euo pipefail
root="$(realpath "${1:-../artifacts/release-engine}")"
prefix="$root/prefix"
repos="$root/repos"
mkdir -p "$prefix/lib/pkgconfig" "$prefix/include" "$root/bundle/bin"
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
export PKG_CONFIG_PATH="$PKG_CONFIG_LIBDIR"
export SOURCE_DATE_EPOCH="$(git -C "$repos/ffmpeg" show -s --format=%ct HEAD)"
jobs="${BUILD_JOBS:-2}"
cross=x86_64-w64-mingw32

# Verify all required toolchain notices exist before expensive compilation; no late downloads.
mkdir -p "$root/bundle/licenses/toolchain"
for notice in /usr/share/doc/gcc*/copyright /usr/share/doc/g++*/copyright /usr/share/doc/mingw*/copyright; do
  if [ -f "$notice" ]; then
    parent="${notice%/copyright}"; cp -L "$notice" "$root/bundle/licenses/toolchain/${parent##*/}-copyright.txt"
  fi
done
cp /usr/share/common-licenses/GPL-3 /usr/share/common-licenses/LGPL-3 /usr/share/common-licenses/LGPL-2.1 "$root/bundle/licenses/toolchain/"
if [ ! -s "$root/bundle/licenses/toolchain/GCC-RUNTIME-LIBRARY-EXCEPTION-3.1.txt" ]; then
  echo "Missing preverified GCC runtime exception notice" >&2; exit 1
fi

(cd "$repos/zlib"; make -f win32/Makefile.gcc -j"$jobs" PREFIX="$cross-" libz.a)
cp "$repos/zlib/libz.a" "$prefix/lib/"
cp "$repos/zlib/zlib.h" "$repos/zlib/zconf.h" "$prefix/include/"
printf 'prefix=%s\nlibdir=${prefix}/lib\nincludedir=${prefix}/include\nName: zlib\nDescription: pinned zlib\nVersion: 1.3.2\nLibs: -L${libdir} -lz\nCflags: -I${includedir}\n' "$prefix" > "$prefix/lib/pkgconfig/zlib.pc"
(cd "$repos/x264"; ./configure --host="$cross" --cross-prefix="$cross-" --prefix="$prefix" --enable-static --disable-cli --disable-opencl; make -j"$jobs"; make install)
(cd "$repos/zimg"; ./autogen.sh; ./configure --host="$cross" --prefix="$prefix" --enable-static --disable-shared; make -j"$jobs"; make install)

# Both 8-bit and 10-bit HEVC are needed by the real media regression fixtures.
cmake_args=(-G 'Unix Makefiles' -DCMAKE_SYSTEM_NAME=Windows -DCMAKE_SYSTEM_PROCESSOR=x86_64 -DSTATIC_LINK_CRT=ON -DCMAKE_C_FLAGS=-static-libgcc "-DCMAKE_CXX_FLAGS=-static-libgcc -static-libstdc++" -DCMAKE_C_COMPILER="$cross-gcc" -DCMAKE_CXX_COMPILER="$cross-g++" -DCMAKE_RC_COMPILER="$cross-windres" -DCMAKE_INSTALL_PREFIX="$prefix" -DCMAKE_BUILD_TYPE=Release -DENABLE_SHARED=OFF -DENABLE_CLI=OFF -DENABLE_ASSEMBLY=ON -DCMAKE_POLICY_VERSION_MINIMUM=3.5)
cmake -S "$repos/x265/source" -B "$root/x265-10" "${cmake_args[@]}" -DHIGH_BIT_DEPTH=ON -DEXPORT_C_API=OFF
cmake --build "$root/x265-10" --parallel "$jobs"
mkdir -p "$root/x265-8"
cp "$root/x265-10/libx265.a" "$root/x265-8/libx265_main10.a"
cmake -S "$repos/x265/source" -B "$root/x265-8" "${cmake_args[@]}" -DHIGH_BIT_DEPTH=OFF -DEXTRA_LIB=x265_main10.a -DEXTRA_LINK_FLAGS=-L. -DLINKED_10BIT=ON
cmake --build "$root/x265-8" --parallel "$jobs"
cmake --install "$root/x265-8"
# Merge the two static archives as in x265's upstream multilib recipe.
(cd "$root/x265-8"
  mv libx265.a libx265_main.a
  printf 'CREATE libx265.a\nADDLIB libx265_main.a\nADDLIB libx265_main10.a\nSAVE\nEND\n' | "$cross-ar" -M
  cp libx265.a "$prefix/lib/"
)
"$cross-nm" --defined-only -C "$prefix/lib/libx265.a" > "$root/x265-symbols.txt"
grep -Fq 'x265::setupAssemblyPrimitives' "$root/x265-symbols.txt"
grep -Fq 'x265_10bit::setupAssemblyPrimitives' "$root/x265-symbols.txt"

(cd "$repos/ffmpeg"
  ./configure --prefix="$prefix" --target-os=mingw32 --arch=x86_64 --cross-prefix="$cross-" \
    --enable-gpl --enable-version3 --enable-libx264 --enable-libx265 --enable-libzimg --enable-zlib \
    --disable-autodetect --disable-network --disable-debug --disable-doc --disable-ffplay \
    --enable-static --disable-shared --pkg-config=pkg-config --pkg-config-flags=--static \
    --extra-cflags="-I$prefix/include" --extra-ldflags="-L$prefix/lib -static" --extra-libs='-lstdc++ -lpthread'
  make -j"$jobs" ffmpeg.exe ffprobe.exe
)
cp "$repos/ffmpeg/ffmpeg.exe" "$repos/ffmpeg/ffprobe.exe" "$root/bundle/bin/"
# Do not accidentally ship an executable depending on omitted third-party DLLs.
for exe in "$root/bundle/bin/"*.exe; do
  "$cross-objdump" -p "$exe" > "$exe.imports.txt"
  if grep -Ei 'DLL Name:.*(libgcc|libstdc|libwinpthread|x264|x265|zimg|zlib)' "$exe.imports.txt"; then
    echo 'Unexpected non-system DLL dependency' >&2; exit 1
  fi
done
# config.log starts with an environment dump: never ship that as source material.
cp "$repos/ffmpeg/ffbuild/config.mak" "$root/sources/ffmpeg-config.mak"
cp "$repos/ffmpeg/config.h" "$root/sources/ffmpeg-config.h"
printf '%s\n' "$("$cross-gcc" --version | head -1)" "$(cmake --version | head -1)" "$(nasm -v)" > "$root/sources/BUILD-TOOLS.txt"
cp "$root/sources/SOURCE-PINS.json" "$root/bundle/licenses/ENGINE-SOURCE-PINS.json"
cp -R "$root/bundle/licenses/toolchain" "$root/sources/toolchain-notices"
# Sources are separate release attachments, not runtime dependencies or fake tiny link files.
version="$(node -p "require('./package.json').version")"
source_name="MotionPhotoStudio-${version}-third-party-sources.tar.gz"
tar -czf "$root/$source_name" -C "$root/sources" .
(cd "$root"; sha256sum "$source_name") > "$root/source-checksum.txt"
cp "$root/source-checksum.txt" "$root/bundle/licenses/THIRD-PARTY-SOURCE-SHA256.txt"
