import { createHash } from 'node:crypto';

export function verifyPinnedNotice(notice, bytes) {
  if (!notice || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.txt$/.test(notice.file) ||
      !/^[a-f0-9]{64}$/.test(notice.sha256) || !/^[a-f0-9]{40}$/.test(notice.gitBlob)) throw new Error('Invalid notice pin');
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const blob=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if(sha256!==notice.sha256 || blob!==notice.gitBlob) throw new Error('Vendored notice differs from pinned upstream bytes');
}

// Resolve a canonical upstream archive independently of the registry mirror in the lockfile.
// Its bytes MUST still match the locked integrity; a differing mirror copy is not accepted.
export function sharpWindowsSource(pkg, pinnedVersion) {
  if (!pkg || !/^\d+\.\d+\.\d+$/.test(pinnedVersion) || pkg.version !== pinnedVersion || !/^sha512-[A-Za-z0-9+/=]+$/.test(pkg.integrity)) throw new Error('Sharp source/npm pin mismatch');
  return { url: `https://registry.npmjs.org/@img/sharp-win32-x64/-/sharp-win32-x64-${pinnedVersion}.tgz`, integrity: pkg.integrity };
}
