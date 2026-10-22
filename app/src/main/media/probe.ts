import { ffprobe, ffmpeg, runProcess } from './runner.ts';

export type Stream = {
  index: number; codec_type: string; codec_name: string; profile?: string; width?: number; height?: number;
  pix_fmt?: string; avg_frame_rate?: string; r_frame_rate?: string; duration?: string;
  color_space?: string; color_transfer?: string; color_primaries?: string; color_range?: string;
  sample_rate?: string; channels?: number; disposition?: { attached_pic?: number };
  time_base?: string; start_pts?: number; start_time?: string; duration_ts?: number; sample_aspect_ratio?: string;
  side_data_list?: { rotation?: number }[];
};
export type MediaProbe = { streams: Stream[]; format: { duration?: string; format_name?: string } };
export async function probeMedia(path: string, options: { executable?: string; signal?: AbortSignal } = {}): Promise<MediaProbe> {
  const { stdout } = await runProcess(options.executable ?? ffprobe(), ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries',
    'stream=index,codec_type,codec_name,profile,width,height,pix_fmt,avg_frame_rate,r_frame_rate,duration,color_space,color_transfer,color_primaries,color_range,sample_rate,channels,time_base,start_pts,start_time,duration_ts,sample_aspect_ratio:stream_disposition=attached_pic:stream_side_data=rotation:format=duration,format_name',
    '-of', 'json', '-i', path], { signal: options.signal });
  return JSON.parse(stdout) as MediaProbe;
}

export async function decodeVideo(path: string): Promise<void> {
  await runProcess(ffmpeg(), ['-hide_banner', '-v', 'error', '-xerror', '-nostdin', '-i', path,
    '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-']);
}

export function checkTimestamp(timestampUs: number, probe: MediaProbe): void {
  if (timestampUs === -1) return;
  const duration = Number(probe.streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic)?.duration ?? probe.format.duration);
  if (!Number.isFinite(duration) || duration <= 0 || timestampUs < 0 || timestampUs >= duration * 1e6) {
    throw new Error('Cover timestamp outside video presentation timeline');
  }
}
