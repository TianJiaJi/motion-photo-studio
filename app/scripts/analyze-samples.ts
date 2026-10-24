import { readdir, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validateMotion } from '../src/main/motion/validate.ts';
import { extractRange, sha256 } from '../src/main/motion/io.ts';
import { checkTimestamp, decodeVideo, probeMedia } from '../src/main/media/probe.ts';
import { toolVersions } from '../src/main/media/runner.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: {
  input: { type: 'string', default: join(root, '样本/小米手机实况') },
  output: { type: 'string', default: join(root, 'artifacts/m0/sample-analysis.json') },
} });
const directory = resolve(values.input!);
const output = resolve(values.output!);
await mkdir(resolve(output, '..'), { recursive: true });
const temp = await mkdtemp(join(resolve(output, '..'), '.analysis-'));
const files = (await readdir(directory)).filter(name => /\.jpe?g$/i.test(name)).sort();
if (!files.length) throw new Error('No JPG samples found');
const results: object[] = [];
let failures = 0;
try {
  for (const name of files) {
    const path = join(directory, name);
    const beforeHash = await sha256(path);
    try {
      const structure = await validateMotion(path);
      const extracted = join(temp, `${results.length}.mp4`);
      await extractRange(path, extracted, structure.videoStart, structure.videoEnd);
      const media = await probeMedia(extracted);
      checkTimestamp(structure.metadata.timestampUs, media);
      await decodeVideo(extracted);
      const afterHash = await sha256(path);
      if (beforeHash !== afterHash) throw new Error('Source hash changed');
      results.push({ name, ok: true, sha256: beforeHash, sourceUnchanged: true, structure, media, fullVideoDecode: 'passed' });
      console.log(`PASS ${name}: ${structure.width}x${structure.height}, ${media.format.duration}s, gap=${structure.unexplainedGap}`);
    } catch (error) {
      failures++;
      results.push({ name, ok: false, sha256: beforeHash, error: String(error) });
      console.error(`FAIL ${name}: ${error}`);
    }
  }
  await writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), tools: await toolVersions(),
    scope: 'Read-only native sample inspection, not generated-file phone compatibility', count: files.length, failures, results }, null, 2) + '\n', { flag: 'wx' });
  console.log(`Report: ${output}`);
} finally { await rm(temp, { recursive: true, force: true }); }
if (failures) process.exitCode = 1;
