import { randomUUID } from 'node:crypto';
import { mkdir, lstat, readdir, readFile, writeFile, rm, unlink } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { AppFailure } from '../errors.ts';

// Call only for a file this operation successfully reserved/created, never for an arbitrary input.
export async function unlinkCreatedFile(path: string): Promise<void> {
  try { await unlink(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AppFailure('TEMP_CLEANUP', '临时文件被占用，无法完成清理。');
  }
}

const OWNER = 'android-motion-photo.jobs.v1';
const JOB_NAME = /^job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class TempFiles {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  async initialize(): Promise<string[]> {
    await mkdir(this.root, { recursive: true });
    if ((await lstat(this.root)).isSymbolicLink()) throw new AppFailure('TEMP_CLEANUP', '任务目录不能是符号链接。');
    const warnings: string[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !JOB_NAME.test(entry.name)) continue;
      try { await this.remove(join(this.root, entry.name)); }
      catch { warnings.push('有旧任务目录未清理（缺少所有权标记或被占用），未触碰其内容。'); }
    }
    return warnings;
  }
  async create(): Promise<string> {
    const directory = join(this.root, `job-${randomUUID()}`);
    await mkdir(directory);
    await writeFile(join(directory, '.owner.json'), JSON.stringify({ owner: OWNER }), { flag: 'wx' });
    return directory;
  }
  async remove(directory: string): Promise<void> {
    const rel = relative(this.root, resolve(directory));
    if (isAbsolute(rel) || !JOB_NAME.test(rel) || rel.includes('/') || rel.includes('\\')) throw new Error('Not an owned job path');
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe job directory');
    const marker = join(directory, '.owner.json');
    const markerStat = await lstat(marker);
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 1024) throw new Error('Invalid job owner marker');
    if ((JSON.parse(await readFile(marker, 'utf8')) as { owner?: string }).owner !== OWNER) throw new Error('Not our job');
    await rm(directory, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
  }
}
