import { parseRational } from '../../shared/editor.ts';
import type { Stream } from './probe.ts';
import type { CopyVideoTrack } from './copy-plan.ts';
import { runProcess } from './runner.ts';
import { assertSource, type SourceFile } from './source.ts';

export type CopyStream = Omit<Stream, 'side_data_list'> & {
  profile?: string; codec_tag_string?: string; is_avc?: string; nal_length_size?: string | number;
  extradata_hash?: string; sample_rate?: string; channels?: number; channel_layout?: string; color_range?: string;
  disposition?: { attached_pic?: number };
  side_data_list?: { rotation?: number; displaymatrix?: string }[];
};
export type CopyProbe = { streams: CopyStream[]; format: { format_name?: string } };
export type CopyAudioTrack = { index: number; timeBase: string; sampleRate: number; channels: number };
export type CopySupport =
  | { supported: false; reasons: string[]; warnings: string[] }
  | { supported: true; video: CopyVideoTrack; audio: CopyAudioTrack | null; videoSignature: string; audioSignature: string | null; warnings: string[] };

const validHash = (value: string | undefined) => /^SHA256:[a-fA-F0-9]{64}$/.test(value ?? '');
export function copyVideoSignature(stream: CopyStream): string {
  // Rate averages may legitimately change when selecting a VFR subset. Packet timing is verified separately.
  return JSON.stringify([stream.codec_name, stream.codec_tag_string, stream.profile, stream.pix_fmt, stream.width, stream.height,
    stream.sample_aspect_ratio ?? 'N/A', stream.color_range ?? 'unknown', stream.color_space ?? 'unknown',
    stream.color_transfer ?? 'unknown', stream.color_primaries ?? 'unknown', stream.extradata_hash?.toLowerCase(),
    (stream.side_data_list ?? []).filter(value => value.rotation !== undefined || value.displaymatrix !== undefined)
      .map(value => [value.rotation ?? null, value.displaymatrix ?? null])]);
}
export function copyAudioSignature(stream: CopyStream): string {
  return JSON.stringify([stream.codec_name, stream.codec_tag_string, stream.profile, stream.sample_rate, stream.channels,
    stream.channel_layout, stream.extradata_hash?.toLowerCase()]);
}
export function assessCopySupport(probe: CopyProbe, keepAudio: boolean): CopySupport {
  const reasons: string[] = []; const warnings: string[] = [];
  const formats = (probe.format.format_name ?? '').split(',');
  if (!formats.includes('mov') && !formats.includes('mp4')) reasons.push('当前原画边界检查仅支持 MP4/MOV；其他封装仍可使用精确模式。');
  const videos = probe.streams.filter(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audios = probe.streams.filter(stream => stream.codec_type === 'audio');
  if (videos.length !== 1) reasons.push('原画模式需要唯一的主视频轨，不能静默选择或丢弃多个视频轨。');
  if (keepAudio && audios.length > 1) reasons.push('多音轨尚未纳入原画校验范围；不能静默丢弃或重编码其他音轨。');
  const video = videos[0]; const audio = keepAudio ? audios[0] : undefined;
  if (!video) return { supported: false, reasons, warnings };
  if (video.codec_name !== 'h264' || video.pix_fmt !== 'yuv420p' || video.codec_tag_string !== 'avc1'
    || !['Constrained Baseline', 'Baseline', 'Main', 'High', 'Constrained High'].includes(video.profile ?? ''))
    reasons.push('原画模式当前校验范围为 H.264 avc1 8-bit yuv420p（Baseline/Main/High）；不会自动转码。');
  if (video.is_avc !== 'true' || ![1, 2, 4].includes(Number(video.nal_length_size)) || !validHash(video.extradata_hash))
    reasons.push('无法确认 AVC 配置及 NAL 边界，不能安全声明原画直出。');
  if (['smpte2084', 'arib-std-b67'].includes(video.color_transfer ?? '')
    || (video.color_primaries ?? '').startsWith('bt2020') || (video.color_space ?? '').startsWith('bt2020'))
    reasons.push('HDR/BT.2020 广色域不在当前 SDR 原画配置内；需切换精确模式并明确同意相应色彩转换。');
  if (!video.color_transfer || video.color_transfer === 'unknown')
    warnings.push('源视频缺少传递函数标记。原画保留原样，不能保证未标记的 HDR 正确显示。');
  if (!Number.isSafeInteger(video.index) || video.index < 0 || !parseRational(video.time_base)
    || !Number.isSafeInteger(video.start_pts) || !Number.isSafeInteger(video.duration_ts) || video.duration_ts! <= 0
    || !Number.isSafeInteger(video.width) || video.width! < 2 || !Number.isSafeInteger(video.height) || video.height! < 2)
    reasons.push('视频时间基准、时长或几何信息不完整，不能可靠计算原画边界。');
  if (audio && (audio.codec_name !== 'aac' || audio.codec_tag_string !== 'mp4a' || audio.profile !== 'LC'
    || ![1, 2].includes(audio.channels ?? 0) || ![32000, 44100, 48000].includes(Number(audio.sample_rate)) || !validHash(audio.extradata_hash)))
    reasons.push('所保留音轨不在当前 AAC-LC 单声道/立体声（32/44.1/48 kHz）原画校验范围内，不会静默转码或降混。');
  if (audio) {
    const base = parseRational(audio.time_base); const rate = Number(audio.sample_rate);
    if (!Number.isSafeInteger(audio.index) || audio.index < 0 || !base || !Number.isSafeInteger(rate) || rate <= 0
      || BigInt(base.numerator) * BigInt(rate) !== BigInt(base.denominator)
      || !Number.isSafeInteger(audio.start_pts) || !Number.isSafeInteger(audio.duration_ts) || audio.duration_ts! <= 0)
      reasons.push('音轨的采样时间基准或可播放范围不完整，不能可靠验证原画边界。');
  }
  if (reasons.length) return { supported: false, reasons, warnings };
  if (!keepAudio && audios.length) warnings.push('已明确选择不保留音轨；原画承诺仅针对保留的视频码流。');
  if (probe.streams.some(stream => stream.codec_type !== 'video' && stream.codec_type !== 'audio')
    || probe.streams.some(stream => stream.disposition?.attached_pic))
    warnings.push('只输出主视频及选定的音轨，不复制字幕、附件或内嵌静态封面。JPEG 封面另行处理。');
  return { supported: true, warnings,
    video: { index: video.index, timeBase: video.time_base!, startPts: String(video.start_pts),
      endPts: String(BigInt(video.start_pts!) + BigInt(video.duration_ts!)), nalLengthBytes: Number(video.nal_length_size) },
    audio: audio ? { index: audio.index, timeBase: audio.time_base!, sampleRate: Number(audio.sample_rate), channels: audio.channels! } : null,
    videoSignature: copyVideoSignature(video), audioSignature: audio ? copyAudioSignature(audio) : null };
}

export async function probeCopySource(source: SourceFile, executable: string, signal?: AbortSignal): Promise<CopyProbe> {
  await assertSource(source);
  const { stdout } = await runProcess(executable, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_data_hash', 'sha256',
    '-show_entries', 'stream=index,codec_type,codec_name,codec_tag_string,profile,width,height,pix_fmt,is_avc,nal_length_size,extradata_hash,sample_rate,channels,channel_layout,color_range,color_space,color_transfer,color_primaries,time_base,start_pts,start_time,duration_ts,sample_aspect_ratio:stream_disposition=attached_pic:stream_side_data=rotation,displaymatrix:format=format_name',
    '-of', 'json', '-i', source.path], { signal });
  await assertSource(source);
  return JSON.parse(stdout) as CopyProbe;
}
