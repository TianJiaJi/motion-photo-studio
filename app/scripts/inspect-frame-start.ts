// Bounded four-second fixture diagnostic. No user samples or production packet/frame tables are changed.
import { tempFiles } from '../tests/helpers.ts';
import { ffmpeg, ffprobe, runProcess } from '../src/main/media/runner.ts';
import { openSource } from '../src/main/media/source.ts';
import { probeMedia } from '../src/main/media/probe.ts';
import { mediaInfo } from '../src/main/media/info.ts';
import { planEncodeRange, type FrameScanTrace } from '../src/main/media/encode-plan.ts';
const temp = await tempFiles();
let failures = 0;
const runs = Number(process.argv[2] ?? 40);
if (!Number.isSafeInteger(runs) || runs < 4 || runs > 1000 || runs % 4 !== 0) throw new Error('Diagnostic runs must be a multiple of 4 up to 1000');
try {
  const input = temp.file('sixty.mp4');
  await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=60:duration=4',
    '-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=4', '-vf', 'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
    '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input]);
  const source = await openSource(input); const probe = await probeMedia(input); const info = mediaInfo(probe);
  const step = BigInt(info.timeBase.denominator) / (60n * BigInt(info.timeBase.numerator));
  console.log(JSON.stringify({ media: info, planner: 'ffmpeg-wrapped-avframe-clock' }));
  for (let batch = 0; batch < runs / 4; batch++) {
    const traces: FrameScanTrace[][] = Array.from({ length: 4 }, () => []);
    const results = await Promise.all(Array.from({ length: 4 }, (_, lane) => planEncodeRange(source, probe,
      lane % 2 === 0 ? { startUs: 0, endUs: 1000000 } : { startUs: 2010000, endUs: 3010000 },
      { executable: ffmpeg(), onScan: trace => traces[lane]!.push(trace) }).then(plan => {
        const expectedStart = step * BigInt(lane % 2 === 0 ? 0 : 121); const expectedEnd = step * BigInt(lane % 2 === 0 ? 60 : 181);
        if (plan.startPts !== String(expectedStart) || plan.endPts !== String(expectedEnd)) throw new Error(`Wrong frame clock: ${JSON.stringify(plan)}`);
        return { run: batch * 4 + lane, startPts: plan.startPts, endPts: plan.endPts };
      }).catch(error => { failures++; return { run: batch * 4 + lane, error: String(error), trace: traces[lane] }; })));
    console.log(JSON.stringify(results));
  }
  let emptyCaptures = 0;
  for (let run = 0; run < 20; run++) {
    const result = await runProcess(ffprobe(), ['-v', 'error', '-select_streams', '0', '-read_intervals', '0.000000%+#4',
      '-show_frames', '-show_entries', 'frame=pts', '-of', 'compact=p=1:nk=0', input]);
    if (!result.stdout.includes('frame|')) { emptyCaptures++; console.log(JSON.stringify({ emptyCapture: run, result })); }
  }
  console.log(JSON.stringify({ capturedRuns: 20, emptyCaptures }));
  if (failures) {
    for (const seek of [true, false]) {
      const scan = await runProcess(ffprobe(), ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', '0',
        ...(seek ? ['-read_intervals', '0.000000%'] : []), '-show_frames', '-show_entries',
        'frame=stream_index,pts,best_effort_timestamp,duration:frame_side_data=:frame_tags=', '-of', 'compact=p=1:nk=0', '-i', input]);
      console.log(JSON.stringify({ seek, stdout: scan.stdout.slice(0, 800), lines: scan.stdout.split('\n').length, stderr: scan.stderr }));
    }
  }
  console.log(JSON.stringify({ runs, failures })); if (failures) process.exitCode = 1;
} finally { await temp.cleanup(); }
