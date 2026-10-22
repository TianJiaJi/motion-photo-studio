import { isAbsolute } from 'node:path';
import { open } from 'node:fs/promises';
import { parseJpegCoverRequest, type JpegCoverReport } from './image-contract.ts';

// Parent-death handling is installed before loading the native image library. The IPC channel is
// unreferenced so it cannot hold up normal completion, but a lost parent terminates native work.
if (!process.connected) throw new Error('Image worker requires its parent IPC channel');
process.on('disconnect', () => process.exit(1)); process.channel?.unref();
// One fresh native-image process per cover: bounded cache/concurrency and OS-level cancellation.
// Do not replace with toBuffer() of the source image or transfer raw pixels through renderer IPC.
try {
  const { default: sharp } = await import('sharp');
  if (!process.connected) process.exit(1);
  sharp.cache({ memory: 32, files: 0, items: 16 }); sharp.concurrency(1);
  process.send?.({ type: 'ready' });
  let request = '';
  for await (const chunk of process.stdin) {
    request += chunk.toString('utf8'); if (request.length > 128 * 1024) throw new Error('Image request exceeded bound');
  }
  const options = parseJpegCoverRequest(JSON.parse(request));
  if (!isAbsolute(options.input) || !isAbsolute(options.output)) throw new Error('Image worker requires application-resolved paths');
  const input = await open(options.input, 'r'); const header = Buffer.alloc(8);
  try { await input.read(header, 0, 8, 0); } finally { await input.close(); }
  if (!header.equals(Buffer.from([137,80,78,71,13,10,26,10]))
    && !(header[0] === 255 && header[1] === 216 && header[2] === 255)) throw new Error('封面必须是实际的 JPG/PNG 图片。');
  const nativeWarnings: string[] = [];
  const image = sharp(options.input, { limitInputPixels: false, sequentialRead: true, failOn: 'warning', animated: false });
  image.on('warning', value => { if (nativeWarnings.length < 8) nativeWarnings.push(String(value).slice(0, 512)); });
  const metadata = await image.metadata();
  if (!['jpeg', 'png'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1) throw new Error('封面只接受静态 JPG/PNG，不会默默选取动画首帧。');
  if (!metadata.width || !metadata.height) throw new Error('Missing cover dimensions');
  if (metadata.gainMap) throw new Error('带 HDR 增益图的封面尚未验证，请先转换为 SDR JPG/PNG。');
  if (metadata.space === 'cmyk' && !metadata.icc) throw new Error('CMYK 封面缺少 ICC 配置，无法可靠转换为 sRGB。');
  const swapped = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
  const inputWidth = swapped ? metadata.height : metadata.width; const inputHeight = swapped ? metadata.width : metadata.height;
  const warnings: string[] = [];
  if (!metadata.icc) warnings.push('封面没有嵌入 ICC，按 sRGB 图像处理；请核对原始色彩。');
  const ratio = options.fit === 'cover' ? Math.max(options.width / inputWidth, options.height / inputHeight)
    : Math.min(options.width / inputWidth, options.height / inputHeight);
  if (ratio > 1) warnings.push('封面为匹配输出画面进行了放大，不增加原始细节。');
  // Metadata is dropped by default. ICC transform is real, not just a new profile label;
  // autoOrient handles EXIF mirror orientations as well as rotations before fitting.
  await image.autoOrient().resize(options.width, options.height, { fit: options.fit, position: 'centre',
    background: options.background, kernel: 'lanczos3' }).flatten({ background: options.background })
    .withIccProfile('srgb', { attach: true })
    .jpeg({ quality: 94, chromaSubsampling: '4:2:0', progressive: false, optimiseCoding: true }).toFile(options.output);
  if (nativeWarnings.length) throw new Error(`Image decoder/ICC warnings: ${nativeWarnings.join('; ')}`);
  const output = sharp(options.output, { limitInputPixels: false, sequentialRead: true, failOn: 'warning' });
  const result = await output.metadata();
  if (result.format !== 'jpeg' || result.width !== options.width || result.height !== options.height
    || result.space !== 'srgb' || result.hasAlpha || !result.icc || result.exif || result.xmp || result.orientation && result.orientation !== 1)
    throw new Error('JPEG cover color, geometry or metadata verification failed');
  // Force full decode, not only a header check; libvips consumes tiles, not a JS raw pixel buffer.
  await output.stats();
  const report: JpegCoverReport = { width: result.width, height: result.height, inputWidth, inputHeight,
    colorSpace: 'srgb', iccConverted: Boolean(metadata.icc), alphaFlattened: Boolean(metadata.hasAlpha), upscaled: ratio > 1, warnings,
    engine: { sharp: sharp.versions.sharp!, vips: sharp.versions.vips!, lcms: sharp.versions.lcms! } };
  process.stdout.write(JSON.stringify(report));
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)).slice(0, 4096)); process.exitCode = 1;
}
