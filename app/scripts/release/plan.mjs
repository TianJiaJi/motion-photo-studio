import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function releasePlan({ version, lockVersion, rootVersion, previousVersion, event, refType, refName, publish = false, notes }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Release version must be X.Y.Z');
  if (lockVersion !== version || rootVersion !== version) throw new Error('package-lock versions must match package.json');
  if (typeof notes !== 'string' || notes.trim().length < 100 || !notes.startsWith(`# Motion Photo Studio v${version}\n`)) throw new Error('Missing detailed version-specific release notes');
  const tag = `v${version}`;
  if (refType === 'tag' && refName !== tag) throw new Error('Tag/version mismatch');
  const changed = event === 'push' && refType === 'branch' && refName === 'main' && previousVersion !== null && previousVersion !== version;
  if (changed) {
    if (!/^\d+\.\d+\.\d+$/.test(previousVersion)) throw new Error('Invalid previous version');
    const before = previousVersion.split('.').map(BigInt), after = version.split('.').map(BigInt);
    const first = after.findIndex((part, index) => part !== before[index]);
    if (first < 0 || after[first] < before[first]) throw new Error('Release version must increase');
  }
  const release = changed || (event === 'push' && refType === 'tag') || (event === 'workflow_dispatch' && publish);
  return { version, tag, prepare: release || event === 'workflow_dispatch', release, notesPath: `docs/releases/${tag}.md` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const pkg = JSON.parse(readFileSync(resolve(root, 'app/package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(resolve(root, 'app/package-lock.json'), 'utf8'));
  let previousVersion = null;
  const before = process.env.BEFORE_SHA;
  if (process.env.GITHUB_EVENT_NAME === 'push' && process.env.GITHUB_REF_TYPE === 'branch' && before && /^[a-f0-9]{40}$/.test(before) && !/^0+$/.test(before)) {
    // Checkout fetch-depth: 0 makes an actual prior-version comparison possible, including multi-commit pushes.
    previousVersion = JSON.parse(execFileSync('git', ['show', `${before}:app/package.json`], { encoding: 'utf8', cwd: root })).version;
  }
  const result = releasePlan({ version: pkg.version, lockVersion: lock.version, rootVersion: lock.packages[''].version,
    previousVersion, event: process.env.GITHUB_EVENT_NAME, refType: process.env.GITHUB_REF_TYPE, refName: process.env.GITHUB_REF_NAME,
    publish: process.env.PUBLISH_RELEASE === 'true', notes: readFileSync(resolve(root, `docs/releases/v${pkg.version}.md`), 'utf8') });
  console.log(JSON.stringify(result, null, 2));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key,value]) => `${key}=${value}\n`).join(''));
}
