import { randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, open, unlink, rmdir, realpath, opendir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { AppFailure } from '../errors.ts';

const OWNER = 'motion-photo-studio.publication.v1';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RECORD = new RegExp(`^(${UUID})\\.json$`);
const MUX_TEMP = new RegExp(`^\\.container\\.part\\.${UUID}\\.tmp$`);
export type PublicationWorkspace = { id: string; directory: string; stage: string };
type RecordData = { owner: string; id: string; directory: string };
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
async function writeOwnedJson(path: string, value: unknown): Promise<void> {
  const file = await open(path, 'wx'); // Failure to reserve never authorizes deleting an existing file.
  let failure: unknown;
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } catch (error) { failure = error; }
  try { await file.close(); } catch (error) { failure ??= error; }
  if (failure) {
    try { await unlink(path); }
    catch { throw new AppFailure('TEMP_CLEANUP', '恢复记录写入失败，且部分记录无法清理，请检查应用数据目录。', { cause: failure }); }
    throw failure;
  }
}

// Durable intent records live in app-private data. Only the newly created target-side job directory
// is cleaned; neither a final output path nor any user input ever appears in the cleanup manifest.
export class Publications {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  private record(id: string) { return join(this.root, `${id}.json`); }
  async initialize(): Promise<string[]> {
    await mkdir(this.root, { recursive: true });
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('Publication journal cannot be a link');
    let blocked = 0;
    for await (const entry of await opendir(this.root)) {
      const match = RECORD.exec(entry.name); if (!match) continue;
      try { await this.cleanup(match[1]!); } catch { blocked++; }
    }
    return blocked ? [`有 ${blocked} 个导出临时工作区无法清理，可能是目标盘不可访问或文件被占用；未删除成品或源文件，下次启动将重试。`] : [];
  }
  async begin(parent: string): Promise<PublicationWorkspace> {
    const canonical = await realpath(parent); const id = randomUUID();
    const directory = join(canonical, `.motion-photo-job-${id}`);
    const record: RecordData = { owner: OWNER, id, directory };
    await writeOwnedJson(this.record(id), record);
    let created = false;
    try {
      await mkdir(directory); created = true;
      await writeOwnedJson(join(directory, '.owner.json'), { owner: OWNER, id });
      return { id, directory, stage: join(directory, 'container.part') };
    } catch (error) {
      // A failed mkdir never authorizes deleting a pre-existing directory at the same name.
      try { if (created) await this.cleanup(id); else await unlink(this.record(id)); }
      catch { throw new AppFailure('TEMP_CLEANUP', '导出工作区建立失败且清理未完成；恢复记录已保留，请检查磁盘或文件占用。', { cause: error }); }
      throw error;
    }
  }
  async cleanup(id: string): Promise<void> {
    if (!new RegExp(`^${UUID}$`).test(id)) throw new Error('Invalid publication id');
    const recordPath = this.record(id); const stat = await lstat(recordPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error('Unsafe publication record');
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as RecordData;
    if (record.owner !== OWNER || record.id !== id || typeof record.directory !== 'string' || !isAbsolute(record.directory)
      || record.directory !== resolve(record.directory) || basename(record.directory) !== `.motion-photo-job-${id}`) throw new Error('Invalid publication ownership');
    const parent = dirname(record.directory);
    if (await realpath(parent) !== parent) throw new Error('Publication parent changed');
    let directory;
    try { directory = await lstat(record.directory); }
    catch (error) { if (missing(error)) { await unlink(recordPath); return; } throw error; }
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Publication workspace was replaced');
    const names: string[] = [];
    for await (const entry of await opendir(record.directory)) {
      if (names.length >= 3 || !entry.isFile() || entry.isSymbolicLink()
        || entry.name !== '.owner.json' && entry.name !== 'container.part' && !MUX_TEMP.test(entry.name)) throw new Error('Unknown publication workspace content');
      names.push(entry.name);
    }
    if (names.length === 0) { // Crash between successful mkdir and writing the owner marker: no files are deleted.
      await rmdir(record.directory); await unlink(recordPath); return;
    }
    if (!names.includes('.owner.json')) throw new Error('Missing publication owner marker');
    const marker = join(record.directory, '.owner.json'); const markerStat = await lstat(marker);
    if (markerStat.size > 1024 || markerStat.isSymbolicLink()) throw new Error('Unsafe publication owner marker');
    const owner = JSON.parse(await readFile(marker, 'utf8')) as { owner?: string; id?: string };
    if (owner.owner !== OWNER || owner.id !== id) throw new Error('Publication owner mismatch');
    for (const name of names) if (name !== '.owner.json') await unlink(join(record.directory, name));
    await unlink(marker); await rmdir(record.directory); await unlink(recordPath);
  }
}
