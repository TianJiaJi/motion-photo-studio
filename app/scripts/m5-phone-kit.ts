// Generate only synthetic material for manual target-device acceptance. Nothing is uploaded automatically.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, statfs, stat, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { verifyEngines } from '../src/main/media/engine.ts';
import { runProcess } from '../src/main/media/runner.ts';
import { probeMedia } from '../src/main/media/probe.ts';
import { openSource } from '../src/main/media/source.ts';
import { analyzeExport, renderExportDraft, type DraftCover } from '../src/main/media/export-pipeline.ts';
import { Publications } from '../src/main/jobs/publications.ts';
import { publishMotionPhoto } from '../src/main/motion/publish.ts';
import { validateMotion } from '../src/main/motion/validate.ts';
import { extractRange, sha256 } from '../src/main/motion/io.ts';
import type { ExportOptions } from '../src/shared/export.ts';

if (process.argv.length !== 2) throw new Error('This fixed synthetic phone kit takes no source or output paths');
const parent = resolve('../artifacts/m5'); await mkdir(parent, { recursive: true });
for (const path of [parent, tmpdir()]) { const space = await statfs(path, { bigint: true }); if (space.bavail * space.bsize < 2n * 1024n ** 3n) throw new Error('Phone-kit test needs 2 GiB safety headroom'); }
const tag = new Date().toISOString().replace(/[-:.TZ]/g, '') + '-' + randomUUID().slice(0, 8);
const root = join(parent, `phone-${tag}`); const kit = join(root, 'phone-kit'); await mkdir(kit, { recursive: true });
const work = await mkdtemp(join(tmpdir(), 'motion-m5-phone-')); const entries: Record<string, unknown>[] = [];
console.log(`Phone-kit root: ${root}`); console.log(`Synthetic working directory: ${work}`);
try {
  const engines = await verifyEngines(resolve('resources')); const signal = new AbortController().signal;
  const sourcePath = join(work, 'clock-and-beeps.mp4'); const portraitPath = join(work, 'portrait-silent.mp4'); const customPath = join(work, 'static-cover.png');
  const font = join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts', 'consola.ttf'); await stat(font);
  const escapedFont = font.replaceAll('\\', '/').replaceAll(':', '\\:');
  const filter = `setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709,drawtext=fontfile='${escapedFont}':text='%{pts\\:hms}':x=(w-text_w)/2:y=(h-text_h)/2:fontsize=32:fontcolor=white:box=1:boxcolor=black@0.8`;
  await runProcess(engines.ffmpeg, ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=600',
    '-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,1),0.15),0.22*sin(2*PI*660*t),0)':s=48000:d=600", '-map', '0:v:0', '-map', '1:a:0',
    '-vf', filter, '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-pix_fmt', 'yuv420p', '-bf', '0',
    '-x264-params', 'keyint=30:min-keyint=30:scenecut=0:open-gop=0', '-crf', '20', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', sourcePath]);
  await runProcess(engines.ffmpeg, ['-v', 'error', '-nostdin', '-n', '-display_rotation:v:0', '90', '-i', sourcePath, '-t', '3', '-map', '0:v:0', '-an', '-c:v', 'copy', portraitPath]);
  await sharp({ create: { width: 400, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: { create: { width: 320, height: 160, channels: 4, background: '#0040ff' } }, left: 40, top: 40 },
      { input: { create: { width: 320, height: 160, channels: 4, background: '#00c060' } }, left: 40, top: 200 },
      { input: { create: { width: 40, height: 320, channels: 4, background: '#ffff00' } }, left: 40, top: 40 }]).png().toFile(customPath);
  const source = await openSource(sourcePath); const portrait = await openSource(portraitPath); const custom = await openSource(customPath);
  const originalHashes = await Promise.all([sourcePath, portraitPath, customPath].map(path => sha256(path)));
  const stream = (await probeMedia(sourcePath, { executable: engines.ffprobe, signal })).streams.find(row => row.codec_type === 'video')!;
  const [num, den] = stream.time_base!.split('/').map(BigInt); const target = 1200000n * den!;
  assert.equal(target % (1000000n * num!), 0n); const capturedPts = String(target / (1000000n * num!));
  const journal = new Publications(join(work, 'journal')); await journal.initialize();
  const cases = [
    { name: '00-copy-3s-sound', seconds: 3, mode: 'copy', portrait: false, captured: false, custom: false },
    { name: '01-encode-15s-square-frame', seconds: 15, mode: 'encode', portrait: false, captured: true, custom: false },
    { name: '02-encode-3s-portrait-custom-silent', seconds: 3, mode: 'encode', portrait: true, captured: false, custom: true },
    { name: '03-copy-60s-sound', seconds: 60, mode: 'copy', portrait: false, captured: false, custom: false },
    { name: '04-encode-600s-sound', seconds: 600, mode: 'encode', portrait: false, captured: false, custom: false },
  ] as const;
  for (const item of cases) {
    const input = item.portrait ? portrait : source; const directory = join(work, item.name); await mkdir(directory);
    const options: ExportOptions = { clip: { startUs: 0, endUs: item.seconds * 1000000 },
      processing: item.mode === 'copy' ? { mode: 'copy' } : { mode: 'encode', crop: item.captured ? { x: .21875, y: 0, width: .5625, height: 1 } : { x: 0, y: 0, width: 1, height: 1 },
        settings: { fps: 30, resolution: 1080, crf: 23 } },
      audio: item.portrait ? { kind: 'omit' } : { kind: 'track', index: 1, downmixStereo: false }, hdrConsent: false };
    const analysis = await analyzeExport(input, options, engines, signal); assert.equal(analysis.public.supported, true, analysis.public.reasons.join('; '));
    const cover: DraftCover | undefined = item.custom ? { kind: 'custom', source: custom } : item.captured ? { kind: 'frame', pts: capturedPts } : undefined;
    const draft = await renderExportDraft({ source: input, analysis, cover, image: { fit: 'contain', background: '#202020' }, directory, engines, signal,
      onStage: stage => { console.log(`${item.name}: ${stage}`); } });
    const output = join(kit, `M5-${tag}-${item.name}.jpg`);
    const saved = await publishMotionPhoto({ cover: draft.cover, video: draft.video, sources: [input, ...(item.custom ? [custom] : [])], output,
      timestampUs: draft.report.coverTimestampUs, videoDurationUs: draft.report.durationUs, journal, signal });
    const inspected = await validateMotion(output, true); const extracted = join(directory, 'extracted.mp4');
    await extractRange(output, extracted, inspected.videoStart, inspected.videoEnd); assert.equal(await sha256(extracted), await sha256(draft.video.path));
    await runProcess(engines.ffmpeg, ['-v', 'error', '-nostdin', '-xerror', '-err_detect', 'explode', '-i', extracted, '-map', '0:v', '-map', '0:a?', '-f', 'null', '-']);
    await sharp(output).stats(); assert.equal(saved.timestampUs, item.custom ? -1 : item.captured ? 1200000 : 0);
    entries.push({ name: item.name, file: output, bytes: saved.size, sha256: await sha256(output), width: saved.width, height: saved.height,
      requestedDurationUs: item.seconds * 1000000, actualDurationUs: saved.durationUs, timestampUs: saved.timestampUs, mode: item.mode,
      expectedAudio: item.portrait ? 'silent' : '660 Hz short beep each second; compare with visible clock',
      expectedCover: item.custom ? 'blue upper/green lower/yellow left stripe, transparent border flattened #202020; centered square on portrait' : item.captured ? 'source 00:00:01.200, cropped square' : 'actual start frame 00:00:00.000',
      proof: draft.report.proof, warnings: draft.report.warnings, phoneStatus: 'NOT_TESTED' });
    await unlink(extracted); await unlink(draft.video.path); await unlink(draft.cover.path);
  }
  assert.deepEqual(await Promise.all([sourcePath, portraitPath, customPath].map(path => sha256(path))), originalHashes); assert.deepEqual(await readdir(journal.root), []);
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ schema: 1, status: 'local-decode-passed-phone-NOT_TESTED', profile: 'C-modern-xiaomi', engine: engines.build,
    syntheticOnly: true, work, entries, target: { model: 'Redmi K70E', os: '3.0.304.0.WNLCNXM.C11', android: '16', gallery: '4.3.1.18', instruction: 'Confirm current versions; record changed versions separately' } }, null, 2), { flag: 'wx', flush: true });
  const table = entries.map(row => `| ${row.name} |  |  |  |  |  |  |  |`).join('\n');
  await writeFile(join(root, 'phone-feedback.md'), `# M5 真机反馈（尚未测试）\n\n仅将 phone-kit 内 5 个 JPG 原文件 USB 复制到相册可见目录，不经聊天软件转码；唯一名称避免旧缓存。manifest 含电脑端 SHA-256。先核对当前机型/系统/相册版本，升级后不沿用旧结论。\n\n机型：\n系统：\nAndroid：\n相册：\n传输/校验方式：\n\n有声组每秒 660Hz 短声，与画面秒线对齐；02 是无声竖屏，独立封面不应被换成视频帧。01 封面为 1.2秒方形裁切。退出相册再开，重新检查。长片若截断/拒绝/过热/不流畅，记录实际行为，不推断兼容。\n\n| 文件 | 实况标志 | 长按完整播放/实际时长 | 封面 | 方向/裁切 | 声音/同步 | 重开仍有效 | 问题 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${table}\n\n空白不是通过。两小时与 >4GiB 压力输出不默认塞入手机包，若进一步测试请单独记录传输和实际相册限制。该表不能替代官方原文、干净安装或许可审查。\n`, { flag: 'wx' });
  console.log(`Locally verified phone kit ready, manual acceptance NOT_TESTED: ${root}`);
} catch (error) {
  await writeFile(join(root, 'failure.json'), JSON.stringify({ status: 'failed', work, entries, error: String(error), stack: error instanceof Error ? error.stack : undefined }, null, 2), { flag: 'wx' }); throw error;
}
