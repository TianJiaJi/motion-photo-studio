import type { MediaInfo } from '../../shared/media.ts';
import { parseRational, secondsToUs, ptsToUs } from '../../shared/editor.ts';
import type { MediaProbe } from './probe.ts';

export function mediaInfo(probe: MediaProbe): MediaInfo {
  const video = probe.streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  if (!video || !video.width || !video.height || video.width < 1 || video.height < 1 || !Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height)) throw new Error('没有可用的视频画面');
  const timeBase = parseRational(video.time_base);
  if (!timeBase) throw new Error('无法读取视频时间基准');
  const durationText = video.duration && video.duration !== 'N/A' ? video.duration : probe.format.duration;
  let durationUs: number;
  if (video.duration_ts !== undefined && Number.isSafeInteger(video.duration_ts) && video.duration_ts > 0) {
    durationUs = ptsToUs(String(video.duration_ts), '0', timeBase);
  } else if (durationText) durationUs = secondsToUs(durationText);
  else throw new Error('无法读取视频时长');
  if (durationUs <= 0) throw new Error('视频时长必须大于零');
  const rawRotation = video.side_data_list?.find(item => item.rotation !== undefined)?.rotation ?? 0;
  if (!Number.isFinite(rawRotation) || Math.abs(rawRotation / 90 - Math.round(rawRotation / 90)) > 0.0001) throw new Error('暂不支持非直角旋转矩阵的视频');
  const rotation = ((Math.round(rawRotation / 90) * 90 % 360 + 360) % 360) as MediaInfo['rotation'];
  const sar = parseRational(video.sample_aspect_ratio?.replace(':', '/')) ?? { numerator: 1, denominator: 1 };
  const squareWidth = Math.max(1, Math.round(video.width * sar.numerator / sar.denominator));
  const swap = rotation === 90 || rotation === 270;
  const hdr = video.color_transfer === 'smpte2084' || video.color_transfer === 'arib-std-b67';
  const container = probe.format.format_name ?? '';
  const squarePixels = sar.numerator === sar.denominator;
  const startPts = video.start_pts !== undefined && Number.isSafeInteger(video.start_pts)
    ? String(video.start_pts) : String(Math.round(secondsToUs(video.start_time ?? '0') / 1000000 * timeBase.denominator / timeBase.numerator));
  return {
    videoIndex: video.index, encodedWidth: video.width, encodedHeight: video.height,
    displayWidth: swap ? video.height : squareWidth, displayHeight: swap ? squareWidth : video.height,
    rotation, durationUs, startPts, startUs: ptsToUs(startPts, '0', timeBase), timeBase,
    frameRate: parseRational(video.avg_frame_rate), sampleAspectRatio: sar,
    audioTracks: probe.streams.filter(stream => stream.codec_type === 'audio').map(stream => ({ index: stream.index,
      codec: stream.codec_name, channels: Number.isSafeInteger(stream.channels) && stream.channels! > 0 ? stream.channels! : null })),
    codec: video.codec_name, hasAudio: probe.streams.some(stream => stream.codec_type === 'audio'), hdr,
    originalPreviewMime: !hdr && squarePixels && startPts === '0' && video.pix_fmt === 'yuv420p'
      ? video.codec_name === 'h264' && /\b(mov|mp4)\b/.test(container) ? 'video/mp4'
        : ['vp8', 'vp9'].includes(video.codec_name) && /\bwebm\b/.test(container) ? 'video/webm' : null
      : null,
  };
}
