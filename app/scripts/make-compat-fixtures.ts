import { constants } from 'node:fs';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { PROFILES } from '../src/main/motion/profiles.ts';
import { muxMotion } from '../src/main/motion/mux.ts';
import { validateMotion } from '../src/main/motion/validate.ts';
import { extractRange, sha256 } from '../src/main/motion/io.ts';
import { checkTimestamp, decodeVideo, probeMedia } from '../src/main/media/probe.ts';
import { ffmpeg, runProcess, toolVersions } from '../src/main/media/runner.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: {
  output: { type: 'string', default: join(root, 'artifacts/m0') },
  native: { type: 'string', default: join(root, '样本/小米手机实况/MVIMG_20261004_144929.jpg') },
} });
const runId = new Date().toISOString().replace(/[-:.TZ]/g, '') + '-' + randomUUID().slice(0, 6);
const runDir = join(resolve(values.output!), `compat-${runId}`);
const phone = join(runDir, 'phone-kit');
const work = join(runDir, 'work');
await mkdir(phone, { recursive: true });
await mkdir(work);
const ff = (args: string[]) => runProcess(ffmpeg(), ['-hide_banner', '-v', 'error', '-nostdin', '-n', ...args]);
const manifest: {
  runId: string; status: string; phoneStatus: string; tools: Awaited<ReturnType<typeof toolVersions>>;
  files: object[]; controls: object[]; error?: string;
} = { runId, status: 'generating', phoneStatus: 'NOT_TESTED', tools: await toolVersions(), files: [], controls: [] };
const rows: string[] = ['case,profile,file,dynamic_badge,hold_play,cover_correct,orientation_correct,audio_correct,reopen_ok,notes'];

async function makeSet(id: string, video: string, cover: string, timestampUs: number, coverKind: string) {
  const media = await probeMedia(video);
  checkTimestamp(timestampUs, media);
  await decodeVideo(video);
  await ff(['-xerror', '-i', cover, '-frames:v', '1', '-f', 'null', '-']);
  const videoHash = await sha256(video);
  const folder = join(phone, id);
  await mkdir(folder);
  for (const profile of PROFILES) {
    const filename = `MVIMG_${runId}_${id}_${profile.id}.jpg`;
    const output = join(folder, filename);
    const structure = await muxMotion({ cover, video, output, profileId: profile.id, timestampUs });
    const embeddedHash = await sha256(output, structure.videoStart, structure.videoEnd);
    if (embeddedHash !== videoHash) throw new Error('Mux changed embedded video bytes');
    // Independent bounded extraction + decode of every authored file, not just the source MP4.
    const extracted = join(work, `${id}-${profile.id}-verify.mp4`);
    await extractRange(output, extracted, structure.videoStart, structure.videoEnd);
    await decodeVideo(extracted);
    await ff(['-xerror', '-i', output, '-frames:v', '1', '-f', 'null', '-']);
    manifest.files.push({ case: id, profile: profile.id, file: `phone-kit/${id}/${filename}`,
      sha256: await sha256(output), videoSha256: videoHash, coverKind, timestampUs,
      structure, media, fullDecode: 'passed', embeddedVideoUnchanged: true, phoneResult: null });
    rows.push(`${id},${profile.id},${filename},,,,,,,`);
    console.log(`PASS ${id}/${profile.id}`);
  }
}

try {
  const native = resolve(values.native!);
  const nativeHash = await sha256(native);
  const nativeInfo = await validateMotion(native);
  const nativeControl = join(phone, `MVIMG_${runId}_NATIVE_CONTROL.jpg`);
  await copyFile(native, nativeControl, constants.COPYFILE_EXCL);
  if (await sha256(nativeControl) !== nativeHash) throw new Error('Native control copy hash mismatch');
  manifest.controls.push({ file: `phone-kit/${nativeControl.split(/[\\/]/).at(-1)}`, sha256: nativeHash,
    description: 'Unmodified native camera file; must play after the same transfer method' });
  const nativeVideo = join(work, 'native-video.mp4');
  await extractRange(native, nativeVideo, nativeInfo.videoStart, nativeInfo.videoEnd);
  const nativeCover = join(work, 'native-frame0.jpg');
  await ff(['-i', nativeVideo, '-map', '0:v:0', '-frames:v', '1', '-q:v', '2', '-update', '1', nativeCover]);
  await makeSet('00_native_video_frame0', nativeVideo, nativeCover, 0, 'first frame of native embedded video, clean new JPEG');
  let index = 1;
  for (const orientation of ['portrait', 'landscape'] as const) {
    const width = orientation === 'portrait' ? 720 : 960;
    const height = orientation === 'portrait' ? 960 : 720;
    for (const audio of [true, false]) {
      const sourceId = `${orientation}_${audio ? 'audio' : 'silent'}`;
      const video = join(work, `${sourceId}.mp4`);
      await ff(['-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=30:duration=3`,
        ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3'] : []),
        '-map', '0:v:0', ...(audio ? ['-map', '1:a:0'] : []), '-t', '3',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-preset', 'veryfast',
        '-g', '30', '-bf', '2', ...(audio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
        '-movflags', '+faststart', video]);
      for (const coverKind of ['frame', 'custom'] as const) {
        const id = `${String(index++).padStart(2, '0')}_${sourceId}_${coverKind}`;
        const cover = join(work, `${id}.jpg`);
        const timestampUs = coverKind === 'custom' ? -1 : audio ? 1000000 : 0;
        if (coverKind === 'frame') {
          await ff(['-ss', String(timestampUs / 1e6), '-i', video, '-map', '0:v:0',
            '-frames:v', '1', '-q:v', '2', '-update', '1', cover]);
        } else {
          const png = join(work, `${id}-upload.png`);
          await ff(['-f', 'lavfi', '-i', `color=c=navy:s=${width}x${height}:d=1`,
            '-vf', 'drawbox=x=iw/4:y=ih/4:w=iw/2:h=ih/2:color=yellow:t=fill',
            '-frames:v', '1', '-update', '1', png]);
          await ff(['-i', png, '-frames:v', '1', '-q:v', '2', '-update', '1', cover]);
        }
        await makeSet(id, video, cover, timestampUs, coverKind === 'custom' ? 'unrelated PNG converted to JPEG, timestamp unspecified' : 'video frame');
      }
    }
  }
  if (await sha256(native) !== nativeHash) throw new Error('Native source changed');
  manifest.status = 'LOCAL_CHECKS_PASSED_AWAITING_PHONE';
  await writeFile(join(runDir, 'phone-results.csv'), '\ufeff' + rows.join('\r\n') + '\r\n');
  await writeFile(join(runDir, 'README.md'), `# 小米格式对照包 ${runId}\n\n本地验证通过，不等于小米相册识别通过。\n\n## 第一轮（先测试 5 张）\n\n1. 原样传输 phone-kit 根目录的 NATIVE_CONTROL.jpg 和 00_native_video_frame0 目录中的 A/B/C/D 四张到手机 DCIM 下的新目录。不要通过聊天软件发送图片。\n2. 原生对照必须能长按播放，否则先检查传输或媒体索引。\n3. 四张封面与 MP4 完全相同，仅元数据不同：A 新版；B 新旧双写；C 新版 + 小米私有标志；D 双写 + 小米私有标志。\n4. 记录动态标志、长按完整播放、声音、方向、封面、退出相册重开是否正常。\n\n## 第二轮（覆盖验证）\n\n测试 01–08 目录，覆盖横/竖、带声/无声、抽帧/自定义封面。自定义封面是蓝底黄方块，与视频无对应帧，使用 -1 时间戳；播放时切到测试动画是预期行为。\n\n在 phone-results.csv 填写 pass/fail 和备注，并提供 Redmi K70E 系统完整版本、相册版本、传输方式。manifest.json 含哈希、探测结果和每张文件的编码参数。\n\nwork 目录仅供电脑复核，不需要传到手机。不要公开分享原生对照或 00 组，其中包含你提供的私人素材。\n`);
  console.log(`\nPhone test kit: ${runDir}`);
} catch (error) {
  manifest.status = 'FAILED_LOCAL_CHECKS';
  manifest.error = String(error);
  throw error;
} finally {
  await writeFile(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
