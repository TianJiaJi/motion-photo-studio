import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// Call with a canonical source path or a path built from a canonical output parent.
// realpath on roots also closes junction aliases; equality/prefix checks must respect path boundaries.
export async function isManagedPath(path: string, roots: readonly string[]): Promise<boolean> {
  for (const root of roots) {
    let canonical: string;
    try { canonical = await realpath(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; canonical = resolve(root); }
    const rel = relative(canonical, path);
    if (rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) return true;
  }
  return false;
}
export function isPublicationWorkspace(path: string): boolean {
  return path.split(/[\\/]/).some(part => /^\.motion-photo-job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part));
}
