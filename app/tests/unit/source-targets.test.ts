import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sameFileTarget } from '../../src/main/media/source.ts';

function shortName(path: string): string {
  // COM FileSystemObject resolves 8.3 names even when callers pass the long spelling.
  const script = `$p=${JSON.stringify(path)}; $f=New-Object -ComObject Scripting.FileSystemObject; if(Test-Path -LiteralPath $p -PathType Container){$f.GetFolder($p).ShortPath}else{$f.GetFile($p).ShortPath}`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim();
}

test('source/output identity survives 8.3 short names and case, never matches a different file', () => {
  const root = mkdtempSync(join(tmpdir(), 'motion-targets-'));
  try {
    // This mirrors the cloud-runner failure: the source is opened through the short form
    // (RUNNER~1) while callers construct the long spelling, or vice versa.
    mkdirSync(join(root, 'Long Directory Name'));
    const longFile = join(root, 'Long Directory Name', 'input.mp4');
    writeFileSync(longFile, 'fixture');
    const other = join(root, 'Long Directory Name', 'other.mp4');
    writeFileSync(other, 'fixture');
    const missing = join(root, 'Long Directory Name', 'missing.mp4');
    assert.equal(sameFileTarget(longFile, longFile), true);
    assert.equal(sameFileTarget(longFile, missing), false);
    assert.equal(sameFileTarget(longFile, other), false);
    if (process.platform === 'win32') {
      assert.equal(sameFileTarget(longFile, longFile.toUpperCase()), true, 'Windows spelling case is not identity');
      const shortDir = shortName(join(root, 'Long Directory Name'));
      const shortFile = join(shortDir, 'input.mp4');
      if (shortDir.toLowerCase() !== join(root, 'Long Directory Name').toLowerCase()) {
        // 8.3 naming is available on this volume: the exact CI mismatch must still be one target.
        assert.equal(shortName(longFile).includes('~'), true);
        assert.equal(sameFileTarget(shortFile, longFile), true);
        assert.equal(sameFileTarget(shortName(longFile), longFile), true);
        assert.equal(sameFileTarget(shortFile, missing), false);
        assert.equal(sameFileTarget(shortFile, other), false);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('canonical comparison accepts not-yet-created outputs beside an existing target', () => {
  const root = mkdtempSync(join(tmpdir(), 'motion-targets-'));
  try {
    mkdirSync(join(root, 'deep', 'nested'), { recursive: true });
    const existing = join(root, 'deep', 'nested', 'input.mp4');
    writeFileSync(existing, 'fixture');
    // Output does not exist yet: canonicalize through its real parent directory.
    // Concatenate deliberately: path.join would normalize the redundant components away.
    const planned = `${join(root, 'deep', 'nested')}${sep}.${sep}input.mp4`;
    const doubled = `${join(root, 'deep', 'nested')}\\input.mp4`;
    assert.equal(sameFileTarget(planned, existing), true);
    assert.equal(sameFileTarget(doubled, existing), true);
    assert.equal(sameFileTarget(join(root, 'deep', 'nested', 'other.mp4'), existing), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
