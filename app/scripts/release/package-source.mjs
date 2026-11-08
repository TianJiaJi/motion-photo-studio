// Resolve a canonical upstream archive independently of the registry mirror in the lockfile.
// Its bytes MUST still match the locked integrity; a differing mirror copy is not accepted.
export function sharpWindowsSource(pkg, pinnedVersion) {
  if (!pkg || !/^\d+\.\d+\.\d+$/.test(pinnedVersion) || pkg.version !== pinnedVersion || !/^sha512-[A-Za-z0-9+/=]+$/.test(pkg.integrity)) throw new Error('Sharp source/npm pin mismatch');
  return { url: `https://registry.npmjs.org/@img/sharp-win32-x64/-/sharp-win32-x64-${pinnedVersion}.tgz`, integrity: pkg.integrity };
}
