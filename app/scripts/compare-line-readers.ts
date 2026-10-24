// Diagnostic baseline ONLY: the old async-iterator reader is not a production fallback.
// Both readers inspect the same fixed four-second file in bounded batches, stopping at one second.
import { spawn } from 'node:child_process';
import { tempFiles } from '../tests/helpers.ts';
import { ffmpeg, ffprobe, runProcess } from '../src/main/media/runner.ts';
import { streamProcessLines } from '../src/main/media/lines.ts';
async function legacy(args: string[], onLine: (line: string) => boolean) {
  const child = spawn(ffprobe(), args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let code: number | null = null; let ended = false; let stopped = false; let stderr = ''; let carry = ''; let bytes = 0;
  const closed = new Promise<void>(resolve => child.once('close', value => { code = value; ended = true; resolve(); }));
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-65536); }); child.stdout.setEncoding('utf8');
  try {
    outer: for await (const chunk of child.stdout) {
      carry += chunk as string; bytes += Buffer.byteLength(chunk as string);
      if (carry.length > 65536) throw new Error('Fixed fixture output exceeded bound');
      for (;;) {
        const newline = carry.indexOf('\n'); if (newline < 0) break;
        const line = carry.slice(0, newline).replace(/\r$/, ''); carry = carry.slice(newline + 1);
        if (await onLine(line)) { stopped = true; if (!ended) child.kill(); break outer; }
      }
    }
    if (!stopped && carry) stopped = Boolean(await onLine(carry.replace(/\r$/, '')));
  } finally { await closed; }
  if (!stopped && code !== 0) throw new Error(`Baseline ffprobe error ${code}: ${stderr}`);
  return { stopped, stdoutBytes: bytes };
}
const temp = await tempFiles();
try {
  const input = temp.file('sixty.mp4');
  await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=60:duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input]);
  const args = ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', '0', '-read_intervals', '0.000000%',
    '-show_frames', '-show_entries', 'frame=stream_index,pts,best_effort_timestamp,duration:frame_side_data=:frame_tags=', '-of', 'compact=p=1:nk=0', '-i', input];
  const misses = { legacy: 0, pipeline: 0 };
  for (let batch = 0; batch < 50; batch++) {
    const results = await Promise.all(Array.from({ length: 4 }, async (_, lane) => {
      const reader = lane % 2 === 0 ? 'legacy' : 'pipeline'; let frames = 0;
      const consume = (line: string) => { if (line.startsWith('frame|')) frames++; const pts = /(?:^|\|)pts=(-?\d+)/.exec(line); return Boolean(pts && BigInt(pts[1]!) >= 15360n); };
      const result = reader === 'legacy' ? await legacy(args, consume) : await streamProcessLines(ffprobe(), args, consume, { timeoutMs: 30000 });
      if (!result.stopped || frames === 0) { misses[reader]++; return { batch, lane, reader, frames, ...result }; }
      return null;
    }));
    for (const result of results) if (result) console.log(JSON.stringify(result));
  }
  console.log(JSON.stringify({ runsPerReader: 100, misses })); if (misses.pipeline) process.exitCode = 1;
} finally { await temp.cleanup(); }
