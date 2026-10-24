// Fixed four-second diagnostic; complete text capture is never used for production media.
import { tempFiles } from '../tests/helpers.ts';
import { ffmpeg, ffprobe, runProcess } from '../src/main/media/runner.ts';
const temp = await tempFiles();
try {
  const input = temp.file('sixty.mp4');
  await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=60:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input]);
  const variants = [
    { name: 'auto-seek', threads: false, seek: true }, { name: 'one-seek', threads: true, seek: true },
    { name: 'auto-from-start', threads: false, seek: false }, { name: 'one-from-start', threads: true, seek: false },
  ];
  const misses = Object.fromEntries(variants.map(v => [v.name, 0]));
  for (let batch = 0; batch < 100; batch++) await Promise.all(variants.map(async variant => {
    const result = await runProcess(ffprobe(), ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', '0',
      ...(variant.threads ? ['-threads', '1'] : []), ...(variant.seek ? ['-read_intervals', '0.000000%'] : []),
      '-show_frames', '-show_entries', 'frame=stream_index,pts,best_effort_timestamp,duration:frame_side_data=:frame_tags=', '-of', 'compact=p=1:nk=0', '-i', input]);
    const frames = result.stdout.split('\n').filter(line => line.startsWith('frame|')).length;
    if (frames !== 240) { misses[variant.name]!++; console.log(JSON.stringify({ batch, variant: variant.name, frames, stdout: result.stdout.slice(0, 200), stderr: result.stderr })); }
  }));
  console.log(JSON.stringify({ runsPerVariant: 100, misses }));
} finally { await temp.cleanup(); }
