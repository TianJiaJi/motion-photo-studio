// Linux-only source collection. Does not use the unreviewed developer FFmpeg snapshot.
import { readFile, writeFile, mkdir, cp, readdir, lstat } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(process.argv[2] || '../artifacts/release-engine');
const repos = join(root, 'repos'), sources = join(root, 'sources'), licenses = join(root, 'bundle/licenses');
const lock = JSON.parse(await readFile('release/sources.json', 'utf8'));
const run = (file, args, cwd) => execFileSync(file, args, { cwd, stdio: 'inherit' });
const capture = (file, args, cwd) => execFileSync(file, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
await Promise.all([repos, sources, licenses].map(path => mkdir(path, { recursive: true })));
for (const item of [...lock.engine, ...lock.imageSources]) {
  if (!/^[\w-]+\/[\w.-]+$/.test(item.repo) || !/^[a-f0-9]{40}$/.test(item.commit) || !/^[\w-]+$/.test(item.name)) throw new Error('Invalid source pin');
  const dir = join(repos, item.name);
  await mkdir(dir); run('git', ['init', '--quiet'], dir);
  run('git', ['-c', 'credential.helper=', 'fetch', '--depth=1', `https://github.com/${item.repo}.git`, item.commit], dir);
  run('git', ['checkout', '--detach', '--quiet', 'FETCH_HEAD'], dir);
  if (capture('git', ['rev-parse', 'HEAD'], dir).trim() !== item.commit) throw new Error('Source commit mismatch');
  run('git', ['archive', '--format=tar.gz', `--output=${join(sources, `${item.name}-${item.commit}.tar.gz`)}`, 'HEAD'], dir);
}
await cp('release/sources.json', join(sources, 'SOURCE-PINS.json'));
await cp('scripts/release/build-engine.sh', join(sources, 'build-engine.sh'));
await cp('scripts/release/prepare-sources.mjs', join(sources, 'prepare-sources.mjs'));
await cp('release/SOURCE-README.md', join(sources, 'README.md'));
for (const item of lock.engine) {
  for (const file of await readdir(join(repos, item.name))) {
    if (/^(COPYING|LICENSE|LICENCE)/i.test(file) && (await lstat(join(repos, item.name, file))).isFile())
      await cp(join(repos, item.name, file), join(licenses, `${item.name}-${file}`));
  }
}
await cp(join(repos, 'sharp-libvips/THIRD-PARTY-NOTICES.md'), join(licenses, 'SHARP-LIBVIPS-THIRD-PARTY-NOTICES.md'));
await cp(join(repos, 'sharp/LICENSE'), join(licenses, 'SHARP-LICENSE'));

// Match precisely the Windows npm package selected by package-lock, never a floating latest.
const npmLock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const pkg = npmLock.packages['node_modules/@img/sharp-win32-x64'];
const sharpPin = lock.imageSources.find(item => item.name === 'sharp');
if (pkg.version !== sharpPin.version || !/^sha512-[A-Za-z0-9+/=]+$/.test(pkg.integrity) || !pkg.resolved.startsWith('https://registry.npmjs.org/')) throw new Error('Sharp source/npm pin mismatch');
const sharpTar = join(root, 'sharp-win32.tgz');
run('curl', ['--fail', '--location', '--retry', '3', '--output', sharpTar, pkg.resolved]);
const npmHash = createHash('sha512').update(await readFile(sharpTar)).digest('base64');
if (`sha512-${npmHash}` !== pkg.integrity) throw new Error('Sharp npm integrity mismatch');
const sharpPackage = join(root, 'sharp-package'); await mkdir(sharpPackage);
run('tar', ['xzf', sharpTar, '--strip-components=1', '-C', sharpPackage]);
const versions = JSON.parse(await readFile(join(sharpPackage, 'versions.json'), 'utf8'));
await cp(join(sharpPackage, 'versions.json'), join(licenses, 'SHARP-WIN32-VERSIONS.json'));
await cp(join(sharpPackage, 'README.md'), join(licenses, 'SHARP-WIN32-README.md'));

// The pinned upstream MXE recipes include exact archive checksums and all build patches.
// Download only the actual runtime components, not a second copy of the host toolchain.
const names = { aom:'aom', archive:'libarchive', cairo:'cairo', cgif:'cgif', exif:'libexif', expat:'expat', ffi:'libffi', fontconfig:'fontconfig', freetype:'freetype', fribidi:'fribidi', glib:'glib', harfbuzz:'harfbuzz', heif:'libheif', highway:'highway', imagequant:'libimagequant', lcms:'lcms', mozjpeg:'mozjpeg', pango:'pango', pixman:'pixman', png:'libpng', 'proxy-libintl':'proxy-libintl', rsvg:'librsvg', tiff:'tiff', uhdr:'uhdr', vips:'vips-web', webp:'libwebp', xml2:'libxml2', 'zlib-ng':'zlib-ng' };
if (Object.keys(versions).some(name => !names[name])) throw new Error('Unreviewed Windows image dependency');
const mxe = join(repos, 'mxe'), vips = join(repos, 'vips-build/build');
const plugins = ['plugins/llvm-mingw', vips, ...['mozjpeg','zlib-ng','web-deps','proxy-libintl'].map(name => join(vips, 'plugins', name))].join(' ');
const vars = [`MXE_PLUGIN_DIRS=${plugins}`, 'MXE_TARGETS=x86_64-w64-mingw32.static', 'MXE_USE_CCACHE='];
const metadata = join(root, 'source-metadata.mk');
await writeFile(metadata, `.PHONY: release-source-metadata\nrelease-source-metadata:\n` + Object.entries(names).map(([key, name]) => `\t@printf '%s\\t%s\\t%s\\n' '${key}' '$(${name}_VERSION)' '$(${name}_FILE)'\n`).join(''));
const lines = capture('make', ['--no-print-directory', '-s', '-f', 'Makefile', '-f', metadata, 'release-source-metadata', ...vars], mxe).trim().split('\n');
const archives = [];
for (const line of lines) {
  const [key, version, file] = line.trim().split('\t');
  if (!names[key]) continue; // MXE informational output is not metadata.
  if (version !== versions[key] || !file || basename(file) !== file) throw new Error(`Source version mismatch: ${key}: ${version} != ${versions[key]}`);
  archives.push({ key, file });
}
if (archives.length !== Object.keys(versions).length) throw new Error('Incomplete image source metadata');
run('make', ['-j2', ...Object.values(names).map(name => `download-only-${name}`), ...vars], mxe);
const imageSources = join(sources, 'image-dependencies'); await mkdir(imageSources);
for (const { file } of archives) await cp(join(mxe, 'pkg', file), join(imageSources, file));
// librsvg's Rust dependencies are part of the delivered library, not just build tools.
const rsvg = join(root, 'rsvg-source'); await mkdir(rsvg);
run('tar', ['xf', join(imageSources, archives.find(row => row.key === 'rsvg').file), '--strip-components=1', '-C', rsvg]);
const vendor = join(sources, 'librsvg-rust-vendor');
const cargoConfig = capture('cargo', ['vendor', '--locked', '--manifest-path', join(rsvg, 'Cargo.toml'), vendor], rsvg);
await writeFile(join(sources, 'librsvg-cargo-config.toml'), cargoConfig);

// Check libvips DLL provenance against the precise upstream SDK used by sharp's win.sh.
const sdkZip = join(root, 'vips-sdk.zip');
run('curl', ['--fail', '--location', '--retry', '3', '--output', sdkZip, lock.vipsBinary.url]);
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
if (await digest(sdkZip) !== lock.vipsBinary.sha256) throw new Error('Upstream libvips SDK hash mismatch');
const sdk = join(root, 'vips-sdk'); await mkdir(sdk); run('unzip', ['-q', sdkZip, '-d', sdk]);
const sdkRoot = (await readdir(sdk)).find(name => name.startsWith('vips-dev-'));
if (!sdkRoot || await digest(join(sdk, sdkRoot, 'bin/libvips-42.dll')) !== await digest(join(sharpPackage, 'lib/libvips-42.dll'))) throw new Error('npm libvips DLL does not match source SDK provenance');
await writeFile(join(licenses, 'IMAGE-SOURCE-PROVENANCE.json'), JSON.stringify({ pins: lock.imageSources, versions, vipsBinary: lock.vipsBinary, vipsDllSha256: await digest(join(sharpPackage, 'lib/libvips-42.dll')), sharpNpmIntegrity: pkg.integrity }, null, 2));
await cp('release/SOURCE-README.md', join(licenses, 'SOURCE-README.md'));
console.log(`Source collection complete: ${root}`);
