import type { MediaInfo } from '../../shared/media.ts';
import { validateExportSettings } from '../../shared/editor.ts';
import { processingGeometry, type ProcessingEdits } from '../../shared/processing.ts';
import { AppFailure } from '../errors.ts';
import type { Stream } from './probe.ts';

// Preserve reference-display appearance, not scene-linear exposure. The pinned zscale engine
// uses an ideal-black gamma-2.4 display interpretation for Rec.709; native multi-gray tests
// check it against coded luma and an independent sRGB equation. Device appearance is a separate gate.
export const SDR_RENDERING_INTENT = 'display-referred-ideal-black-gamma-2.4' as const;
const PRIMARIES = new Set(['bt709', 'bt470m', 'bt470bg', 'smpte170m', 'smpte240m', 'bt2020', 'smpte431', 'smpte432', 'jedec-p22', 'ebu3213']);
const TRANSFERS = new Set(['bt709', 'bt470m', 'bt470bg', 'smpte170m', 'smpte240m', 'linear', 'bt2020-10', 'bt2020-12', 'smpte2084', 'arib-std-b67', 'iec61966-2-1']);
const MATRICES = new Set(['gbr', 'bt709', 'fcc', 'bt470bg', 'smpte170m', 'smpte240m', 'bt2020nc', 'bt2020c', 'ycgco']);
function color(value: string | undefined, fallback: string, supported: Set<string>, warnings: string[], name: string): string {
  if (!value || value === 'unknown' || value === 'unspecified') { warnings.push(`源${name}未标记，按 ${fallback} 处理，需人工核对色彩。`); return fallback; }
  const normalized = value === 'gamma22' ? 'bt470m' : value === 'gamma28' ? 'bt470bg' : value;
  if (!supported.has(normalized)) throw new Error(`尚未验证的${name}：${value}；不会仅修改色彩标签。`);
  return normalized;
}
export function sdrColorProcessing(info: MediaInfo, stream: Stream, hdrConsent: boolean) {
  const warnings: string[] = []; const pixel = stream.pix_fmt ?? '';
  if (/^(yuva|gbrap|rgba|bgra|argb|abgr|ya\d|pal8)/.test(pixel)) throw new Error('透明视频的合成策略尚未验证，不能静默丢弃透明度。');
  const rgb = /^(gbr|rgb|bgr|0rgb|0bgr)/.test(pixel);
  const hdr = stream.color_transfer === 'smpte2084' || stream.color_transfer === 'arib-std-b67';
  if (hdr && !hdrConsent) throw new AppFailure('HDR_CONFIRM_REQUIRED', '导出 HDR 输入前须明确同意转换为 SDR。');
  if (stream.color_primaries === 'bt2020' && (!stream.color_transfer || ['unknown', 'unspecified'].includes(stream.color_transfer)))
    throw new Error('BT.2020 输入缺少传递函数，不能假定为普通 SDR。');
  const hd = info.encodedWidth >= 1280 || info.encodedHeight > 576;
  const primaries = color(stream.color_primaries, hdr ? 'bt2020' : rgb || hd ? 'bt709' : 'smpte170m', PRIMARIES, warnings, '色域');
  const transfer = color(stream.color_transfer, rgb ? 'iec61966-2-1' : 'bt709', TRANSFERS, warnings, '传递函数');
  const matrix = color(stream.color_space, rgb ? 'gbr' : hdr ? 'bt2020nc' : hd ? 'bt709' : 'smpte170m', MATRICES, warnings, '矩阵');
  let range = stream.color_range;
  if (!range || range === 'unknown') { range = rgb || pixel.startsWith('yuvj') ? 'pc' : 'tv'; warnings.push(`源色彩范围未标记，按 ${range} 处理。`); }
  if (!['pc', 'tv'].includes(range)) throw new Error('Unsupported source color range');
  const input = `pin=${primaries}:tin=${transfer}:min=${matrix}:rin=${range}`;
  const filters = hdr
    ? [`zscale=${input}:t=linear:npl=100:agamma=0`, 'format=gbrpf32le', 'zscale=p=bt709:agamma=0', 'tonemap=tonemap=hable:desat=0',
      'zscale=p=bt709:t=bt709:m=bt709:r=tv:dither=none:agamma=0']
    : [`zscale=${input}:p=bt709:t=bt709:m=bt709:r=tv:dither=none:agamma=0`];
  filters.push('format=yuv444p16le');
  if (hdr) warnings.push('已按明确同意进行 HDR→SDR 色调映射；不保留 HDR/动态 HDR 附加元数据，视觉效果仍需核对。');
  return { filters, warnings };
}
export function videoProcessing(info: MediaInfo, stream: Stream, edits: ProcessingEdits, hdrConsent: boolean) {
  const settings = validateExportSettings(edits.settings);
  const geometry = processingGeometry({ mode: 'encode', ...edits }, info);
  const color = sdrColorProcessing(info, stream, hdrConsent);
  const warnings = [...geometry.warnings, ...color.warnings];
  // Retain precision through display/SAR normalization and spatial processing; quantize only afterwards.
  const filters = [...color.filters, `scale=${info.displayWidth}:${info.displayHeight}:flags=lanczos`, 'setsar=1',
    `crop=${geometry.crop!.width}:${geometry.crop!.height}:${geometry.crop!.x}:${geometry.crop!.y}`,
    `scale=${geometry.width}:${geometry.height}:flags=lanczos`, 'setsar=1', 'zscale=c=left:dither=none', 'format=yuv420p',
    'sidedata=mode=delete', 'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709'];
  if (settings.crf === 0) warnings.push('CRF 0 仍是重编码，使用 High 4:4:4 Predictive 配置；手机兼容性未验证，不等同于原画直出。');
  return { filters, geometry, warnings, settings };
}
