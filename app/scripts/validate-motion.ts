import { parseArgs } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateMotion } from '../src/main/motion/validate.ts';
import { extractRange, sha256 } from '../src/main/motion/io.ts';
import { checkTimestamp, decodeVideo, probeMedia } from '../src/main/media/probe.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { strict: { type: 'boolean', default: false } } });
if (positionals.length !== 1) throw new Error('Usage: npm run validate:motion -- [--strict] path/to/file.jpg');
const path = resolve(positionals[0]!);
const temp = await mkdtemp(join(tmpdir(), 'motion-validate-'));
try {
  const structure = await validateMotion(path, values.strict);
  const video = join(temp, 'video.mp4');
  await extractRange(path, video, structure.videoStart, structure.videoEnd);
  const media = await probeMedia(video);
  checkTimestamp(structure.metadata.timestampUs, media);
  await decodeVideo(video);
  console.log(JSON.stringify({ path, sha256: await sha256(path), structure, media,
    fullVideoDecode: 'passed', phoneCompatibility: 'not tested' }, null, 2));
} finally { await rm(temp, { recursive: true, force: true }); }
