import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '../motion/io.ts';
import { runProcess } from './runner.ts';
import { AppFailure } from '../errors.ts';

export type EngineManifest = {
  schemaVersion: 1; platform: 'win32'; arch: 'x64'; build: string;
  binaries: { name: 'ffmpeg.exe' | 'ffprobe.exe'; sha256: string; size: number }[];
  provenance: string; releaseStatus: 'internal-development-only';
};
export type EnginePaths = { ffmpeg: string; ffprobe: string; build: string };
export function parseEngineManifest(raw: unknown): EngineManifest {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid engine manifest');
  const m = raw as Partial<EngineManifest>;
  if (m.schemaVersion !== 1 || m.platform !== 'win32' || m.arch !== 'x64'
    || typeof m.build !== 'string' || !m.build || m.build.length > 200
    || !Array.isArray(m.binaries) || m.binaries.length !== 2
    || new Set(m.binaries.map(b => b?.name)).size !== 2
    || m.binaries.some(b => !b || !['ffmpeg.exe', 'ffprobe.exe'].includes(b.name)
      || !/^[a-f0-9]{64}$/.test(b.sha256) || !Number.isSafeInteger(b.size) || b.size <= 0)
    || m.releaseStatus !== 'internal-development-only' || typeof m.provenance !== 'string') {
    throw new Error('Invalid engine manifest');
  }
  return m as EngineManifest;
}

export async function verifyEngines(resources: string): Promise<EnginePaths> {
  let manifest: EngineManifest;
  try {
    const path = join(resources, 'engine-manifest.json');
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Invalid manifest file');
    manifest = parseEngineManifest(JSON.parse(await readFile(path, 'utf8')));
  } catch { throw new AppFailure('ENGINE_MISSING', '缺少有效的离线媒体引擎清单，请重新安装完整安装包。'); }
  for (const binary of manifest.binaries) {
    const path = join(resources, 'bin', binary.name);
    let stat;
    try { stat = await lstat(path); }
    catch { throw new AppFailure('ENGINE_MISSING', `离线引擎缺少 ${binary.name}，不会回退到系统 PATH 或联网下载。`); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== binary.size || await sha256(path) !== binary.sha256) {
      throw new AppFailure('ENGINE_INTEGRITY', `${binary.name} 完整性校验失败，请重新安装。`);
    }
    try {
      const version = (await runProcess(path, ['-version'], { timeoutMs: 15000 })).stdout.split(/\r?\n/)[0];
      if (!version?.startsWith(`${binary.name.slice(0, -4)} version ${manifest.build} Copyright`)) throw new Error('Version mismatch');
    } catch { throw new AppFailure('ENGINE_VERSION', `${binary.name} 版本或启动校验失败。`); }
  }
  return { ffmpeg: join(resources, 'bin', 'ffmpeg.exe'), ffprobe: join(resources, 'bin', 'ffprobe.exe'), build: manifest.build };
}
