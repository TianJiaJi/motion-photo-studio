import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Reply } from '../../shared/contracts.ts';
import type { VideoAsset, Thumbnail, CoverAsset } from '../../shared/media.ts';
import type { PreviewReady, PreviewStamp, PreviewBoundary } from '../../shared/native-preview.ts';
import { PreviewController } from './preview-controller.ts';
import { PreviewSurface, type PreviewSurfaceHandle } from './PreviewSurface.tsx';
import { cropToPixels, formatTime, parseTime, validateClip } from '../../shared/editor.ts';
import type { CropRect, ClipSelection, ExportSettings } from '../../shared/editor.ts';
import { CropStage } from './CropStage.tsx';
import { Timeline, type TimelineInteraction } from './Timeline.tsx';
import { createProcessingState, effectiveProcessing, previewCrop, setProcessingMode, updateProcessingEdits, SOURCE_MATCH_EDITS } from '../../shared/processing.ts';
import type { ExportInspection, ExportDraft, ExportOptions, SavedMotion } from '../../shared/export.ts';
import { initialAudioTrack, audioSelection } from '../../shared/export.ts';
import './editor.css';

function unwrap<T>(result: Reply<T>): T {
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.value;
}
function TimeField({ label, value, disabled, change, error }: { label: string; value: number; disabled?: boolean; change(value: number): void; error(message: string): void }) {
  const [text, setText] = useState(formatTime(value));
  const focused = useRef(false); const dirty = useRef(false);
  // Playback/late paint acknowledgments may update value while the user is typing.
  // Do not overwrite that draft, or commit an old display value merely on focus/blur.
  useLayoutEffect(() => { if (!focused.current) setText(formatTime(value)); }, [value]);
  return <label className="field">{label}<input aria-label={label} value={text} disabled={disabled} spellCheck={false}
    onFocus={() => { focused.current = true; dirty.current = false; }}
    onInput={e => { dirty.current = true; setText(e.currentTarget.value); }}
    onChange={e => { dirty.current = true; setText(e.target.value); }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
    onBlur={e => {
      focused.current = false;
      try {
        const next = dirty.current ? parseTime(e.currentTarget.value) : value;
        // An explicit same-value seek must fence a different pending native target too.
        if (dirty.current) change(next);
        setText(formatTime(next));
      } catch (e) { error((e as Error).message); setText(formatTime(value)); }
      finally { dirty.current = false; }
    }} /></label>;
}
const fullCrop: CropRect = { x: 0, y: 0, width: 1, height: 1 };
export function Editor({ ready, preparing, diagnosticsBusy, savingReady }: { ready: boolean; preparing: boolean; diagnosticsBusy: boolean; savingReady: boolean }) {
  const [asset, setAsset] = useState<VideoAsset | null>(null);
  const assetRef = useRef<VideoAsset | null>(null);
  const [nativeReady, setNativeReady] = useState<PreviewReady | null>(null);
  const [nativePreparing, setNativePreparing] = useState(false);
  const [nativeProgress, setNativeProgress] = useState('准备原生预览…');
  const [prepareAttempt, setPrepareAttempt] = useState(0);
  const [controller, setController] = useState<PreviewController | null>(null);
  const controllerRef = useRef<PreviewController | null>(null);
  const surface = useRef<PreviewSurfaceHandle>(null);
  const [frame, setFrame] = useState<PreviewStamp | null>(null);
  const targetKind = useRef<'start' | 'end' | 'playhead' | 'step' | 'play'>('playhead');
  const [cover, setCover] = useState<CoverAsset | null>(null);
  const [thumbs, setThumbs] = useState<Thumbnail[]>([]);
  const [thumbBusy, setThumbBusy] = useState(false);
  const [position, setPosition] = useState(0);
  const [clip, setClip] = useState<ClipSelection>({ startUs: 0, endUs: 1 });
  const [processing, setProcessing] = useState(() => createProcessingState());
  const copyMode = processing.mode === 'copy';
  const settings = copyMode ? SOURCE_MATCH_EDITS.settings : processing.saved.settings;
  const setCrop = (crop: CropRect) => setProcessing(previous => updateProcessingEdits(previous, { crop }));
  const setSettings = (settings: ExportSettings) => setProcessing(previous => updateProcessingEdits(previous, { settings }));
  const [locked, setLocked] = useState(true);
  const [audio, setAudio] = useState(true);
  const [audioIndex, setAudioIndex] = useState<number | null>(null); const [downmix, setDownmix] = useState(false);
  const [inspection, setInspection] = useState<ExportInspection | null>(null); const [draft, setDraft] = useState<ExportDraft | null>(null);
  const [background, setBackground] = useState('#000000'); const draftDialog = useRef<HTMLDialogElement>(null);
  const [outputOpen, setOutputOpen] = useState(false);
  const renderingId = useRef(''); const savingId = useRef(''); const activeOperation = useRef(0);
  const [saved, setSaved] = useState<SavedMotion | null>(null);
  const [coverFit, setCoverFit] = useState<'cover' | 'contain'>('cover');
  const [hdrConsent, setHdrConsent] = useState(false);
  const [zoom, setZoom] = useState(0); const [viewStart, setViewStart] = useState(0);
  const [opening, setOpening] = useState(false); const [busy, setBusy] = useState('');
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [playing, setPlaying] = useState(false);
  const sequence = useRef(0); const target = useRef(0); const displayed = useRef(0);
  const playIntent = useRef(false);
  const duration = asset?.info.durationUs ?? 1;
  const minSpan = Math.min(duration, 500000);
  const maxZoom = Math.max(0, Math.ceil(Math.log2(duration / minSpan)));
  const span = Math.max(minSpan, Math.round(duration / 2 ** zoom));
  const start = Math.min(viewStart, Math.max(0, duration - span));
  const end = Math.min(duration, start + span);
  const blocked = opening || Boolean(busy) || diagnosticsBusy || nativePreparing;
  const previewAvailable = Boolean(nativeReady && nativeReady.assetId === asset?.id);
  const compatible = !asset?.info.hdr || hdrConsent;
  const chosenAudio = audioSelection(audio, audioIndex, asset?.info.audioTracks ?? [], downmix);
  const exportOptions: ExportOptions | null = chosenAudio ? { clip, processing: copyMode ? { mode: 'source' } : effectiveProcessing(processing), audio: chosenAudio, hdrConsent } : null;
  const exportKey = JSON.stringify({ asset: asset?.id, clip, processing: effectiveProcessing(processing), audio, audioIndex, downmix, hdrConsent });
  useEffect(() => { setInspection(null); setDraft(null); setOutputOpen(false); }, [exportKey]);
  useEffect(() => { setDraft(null); setOutputOpen(false); }, [cover?.id, coverFit, background]);
  useEffect(() => { setSaved(null); }, [draft?.id]);
  useEffect(() => {
    const dialog = draftDialog.current;
    if (outputOpen && asset) { if (dialog && !dialog.open) dialog.showModal(); }
    else dialog?.close();
  }, [outputOpen, asset?.id]);
  useEffect(() => {
    if (!window.motion) return;
    return window.motion.media.onExportProgress(progress => {
    if (!activeOperation.current || progress.assetId !== assetRef.current?.id || progress.analysisId !== renderingId.current) return;
    if (progress.saveId ? progress.saveId !== savingId.current : Boolean(savingId.current)) return;
    const stages: Record<string, string> = { plan: '确认剪点', audio: '处理音轨', video: '编码画面', copy: '复制原始码流',
      'verify-packets': '校验视频与音频包', 'verify-source-audio': '对照源音轨', decode: '完整解码检查', verify: '校验输出', cover: '生成封面', image: '处理封面色彩', mux: '写入实况照片', 'read-back': '回读检查格式', 'verify-jpeg': '核对照片字节',
      'verify-video-bytes': '核对视频字节', publish: '安全发布文件' };
    const detail = progress.writtenBytes !== undefined && progress.totalBytes !== undefined
      ? ` · ${(progress.writtenBytes / 1048576).toFixed(1)} / ${(progress.totalBytes / 1048576).toFixed(1)} MiB`
      : progress.timeUs === undefined ? '…' : ` · ${formatTime(Math.max(0, progress.timeUs))}`;
    setBusy(`${stages[progress.stage] ?? '处理输出'}${detail}`);
    });
  }, []);
  function report(e: unknown) {
    const failure = e as { code?: string; message?: string };
    if (failure.code === 'CANCELLED') return;
    if (failure.code === 'FRAME_BOUNDARY') setNotice(failure.message ?? '已到画面边界。');
    else setError(failure.message ?? '本地操作失败，请重试。');
  }
  function pause(syncPosition = true): number {
    const at = frame ? displayed.current : target.current;
    if (syncPosition && playIntent.current) { target.current = at; setPosition(at); }
    playIntent.current = false; setPlaying(false);
    if (previewAvailable) controllerRef.current?.pause();
    return at;
  }
  async function primary<T>(label: string, operation: () => Promise<T>, accept: (value: T) => void) {
    const request = ++sequence.current; activeOperation.current = request; setBusy(label); setError(''); setNotice('');
    try { const result = await operation(); if (request === sequence.current) accept(result); }
    catch (e) { if (request === sequence.current) report(e); }
    finally { if (request === sequence.current) { activeOperation.current = 0; setBusy(''); } }
  }
  async function openVideo() {
    pause(); ++sequence.current; activeOperation.current = 0; setBusy(''); setOpening(true); setError('');
    try {
      const selected = unwrap(await window.motion.media.open());
      if (!selected) return;
      controllerRef.current?.dispose();
      assetRef.current = selected; setAsset(selected); setNativeReady(null); setFrame(null); setCover(null); setThumbs([]);
      setPosition(0); target.current = displayed.current = 0;
      setClip({ startUs: 0, endUs: selected.info.durationUs }); setLocked(true);
      setProcessing(createProcessingState());
      setAudio(selected.info.hasAudio); setAudioIndex(initialAudioTrack(selected.info.audioTracks)); setDownmix(false); setBackground('#000000');
      setHdrConsent(false); setZoom(0); setViewStart(0); setNotice('');
    } catch (e) { report(e); } finally { setOpening(false); }
  }
  async function cancelOpening() {
    try { unwrap(await window.motion.media.cancelImport()); setNotice('导入已取消。'); }
    catch (e) { report(e); }
  }
  async function closeVideo() {
    if (!asset) return;
    pause(); ++sequence.current; activeOperation.current = 0; setBusy('正在关闭素材');
    try {
      unwrap(await window.motion.media.close({ assetId: asset.id })); assetRef.current = null; setAsset(null);
      controllerRef.current?.dispose(); setNativeReady(null); setFrame(null); setCover(null); setThumbs([]); setError('');
    } catch (e) { report(e); } finally { setBusy(''); }
  }
  async function cancel() {
    if (!asset || !activeOperation.current) return;
    const saveId = savingId.current;
    pause(); ++sequence.current; activeOperation.current = 0; renderingId.current = '';
    try {
      const result = unwrap(await window.motion.media.cancel({ assetId: asset.id, ...(saveId ? { saveId } : {}) }));
      if (result.saved) { setSaved(result.saved); setNotice(`已保存 ${result.saved.name}；取消请求到达时已完成发布。`); }
      else setNotice('处理已取消，未发布新的成品。');
    } catch (e) { report(e); } finally { setBusy(''); }
  }
  useEffect(() => {
    if (!asset) { setController(null); controllerRef.current = null; return; }
    const id = asset.id;
    const ctl = new PreviewController(id, asset.info.durationUs, {
      send: request => window.motion.media.native.control(request),
      acknowledge: request => window.motion.media.native.acknowledge(request),
      frame: pixels => {
        if (assetRef.current?.id === id && surface.current) surface.current.enqueue(pixels);
        else ctl.drop(pixels);
      },
      displayed: stamp => {
        if (assetRef.current?.id !== id) return;
        setFrame(stamp); displayed.current = stamp.timeUs;
        if (!ctl.isDragging && stamp.epoch === ctl.epoch && !['start', 'end'].includes(targetKind.current)) {
          target.current = stamp.timeUs; setPosition(stamp.timeUs);
        }
      },
      error: failure => { if (assetRef.current?.id === id) report(failure); },
    });
    controllerRef.current = ctl; setController(ctl);
    const unsubscribeFrame = window.motion.media.native.onFrame(pixels => { if (pixels.assetId === id) ctl.receive(pixels); });
    const unsubscribeStatus = window.motion.media.native.onStatus(status => {
      if (assetRef.current?.id !== id || !ctl.acceptsStatus(status)) return;
      if (status.state === 'preparing') {
        const labels = { 'source-index': '建立源帧索引', 'native-index': '核对原生帧映射', compatibility: '准备整片兼容素材', audio: '核对并准备音轨' };
        setNativeProgress(`${status.stage ? labels[status.stage] : '准备原生预览'}${status.frames !== undefined ? ` · ${status.frames} 个样本` : ''}${status.bytes !== undefined ? ` · ${(status.bytes / 1048576).toFixed(1)} MiB` : ''}`);
      }
      if (status.state === 'playing' || status.state === 'paused' || status.state === 'failed') {
        playIntent.current = status.state === 'playing'; setPlaying(status.state === 'playing');
      }
      if (status.state === 'failed') { ctl.dispose(); setNativeReady(null); setFrame(null); }
      if (status.error) report(Object.assign(new Error(status.error.message), { code: status.error.code }));
    });
    return () => { ctl.dispose(); unsubscribeFrame(); unsubscribeStatus(); if (controllerRef.current === ctl) controllerRef.current = null; };
  }, [asset?.id]);
  useEffect(() => {
    let active = true; setNativeReady(null); setFrame(null);
    if (!asset || !compatible) { if (nativeReady?.assetId === asset?.id && nativeReady) controllerRef.current?.pause(); setNativePreparing(false); return; }
    setNativePreparing(true); setNativeProgress('准备原生预览…');
    window.motion.media.native.prepare({ assetId: asset.id, hdrConsent }).then(unwrap).then(result => {
      if (active && assetRef.current?.id === result.assetId) { setNativeReady(result); setError(''); }
    }).catch(failure => { if (active) report(failure); }).finally(() => { if (active) setNativePreparing(false); });
    return () => { active = false; };
  }, [asset?.id, hdrConsent, prepareAttempt]);
  useEffect(() => {
    if (previewAvailable && controller) {
      targetKind.current = 'playhead'; controller.seek(target.current, target.current >= duration ? 'before' : 'after');
    }
  }, [nativeReady, controller]);
  const thumbnailsReady = previewAvailable;
  useEffect(() => {
    let active = true; setThumbs([]);
    if (!asset || !compatible || !thumbnailsReady) { setThumbBusy(false); return; }
    setThumbBusy(true);
    window.motion.media.thumbnails({ assetId: asset.id, startUs: start, endUs: end, count: 8, hdrConsent })
      .then(unwrap).then(result => { if (active) setThumbs(result); })
      .catch(e => { if (active) report(e); }).finally(() => { if (active) setThumbBusy(false); });
    return () => { active = false; };
  }, [asset?.id, hdrConsent, start, end, thumbnailsReady]);
  function interact({ kind, phase, timeUs }: TimelineInteraction) {
    const ctl = controllerRef.current; if (!ctl || !previewAvailable) return;
    playIntent.current = false; setPlaying(false); targetKind.current = kind;
    target.current = timeUs; setPosition(timeUs); setNotice('');
    const boundary: PreviewBoundary = kind === 'end' || timeUs >= duration ? 'before' : 'after';
    if (phase === 'begin') ctl.begin(timeUs, boundary);
    else if (phase === 'update') ctl.move(timeUs, boundary);
    else if (phase === 'keyboard') ctl.seek(timeUs, boundary);
    else ctl.end(timeUs, boundary);
  }
  function exactSeek(at: number) {
    if (!previewAvailable) return;
    if (!Number.isSafeInteger(at) || at < 0 || at > duration) { setError('定位时间必须位于视频内。'); return; }
    playIntent.current = false; setPlaying(false); targetKind.current = 'playhead'; target.current = at; setPosition(at);
    controllerRef.current?.seek(at, at >= duration ? 'before' : 'after');
  }
  function step(direction: -1 | 1) {
    const ctl = controllerRef.current; const shown = ctl?.confirmed;
    if (!previewAvailable || !ctl || !shown) { setNotice('请等待当前画面确认后逐帧。'); return; }
    playIntent.current = false; setPlaying(false); targetKind.current = 'step'; ctl.step(shown.frameId, direction);
  }
  function playAt(at: number) {
    if (!previewAvailable) return;
    if (audio && audioIndex === null) { setError('请先选择要预览的音轨，或关闭音轨。'); return; }
    targetKind.current = 'play'; target.current = at; setPosition(at); playIntent.current = true;
    controllerRef.current?.play(at, clip.endUs, audio ? audioIndex : null);
  }
  function changeClip(next: ClipSelection) {
    try { setClip(validateClip(next, duration)); setError(''); } catch (e) { report(e); }
  }
  async function capture() {
    if (!asset) return;
    const shown = controllerRef.current?.confirmed;
    if (!shown) { setNotice('请等待当前画面确认后选作封面。'); return; }
    const captureRequest = window.motion.media.native.capture({ assetId: asset.id, frameId: shown.frameId });
    pause();
    await primary('固定当前封面…', async () => unwrap(await captureRequest), setCover);
  }
  async function upload() {
    if (!asset) return; pause();
    await primary('选择自定义封面…', async () => unwrap(await window.motion.media.uploadCover({ assetId: asset.id })), result => { if (result) setCover(result); });
  }
  async function previewOutput() {
    if (!asset) return;
    setOutputOpen(true); setDraft(null); setSaved(null); setInspection(null); setError(''); setNotice('');
    if (!exportOptions) {
      setError('请选择要保留的音轨，或取消“保留音轨”。不会自动选择或导出静音。');
      return;
    }
    const requested = exportOptions;
    pause();
    await primary('分析实际剪点…', async () => {
      const current = sequence.current;
      const analyzed = unwrap(await window.motion.media.analyze({ assetId: asset.id, options: requested }));
      if (current !== sequence.current) return null;
      setInspection(analyzed);
      if (!analyzed.supported) throw new Error(analyzed.reasons.join('；') || '当前设置不支持导出，请关闭此窗口后调整参数。');
      renderingId.current = analyzed.id;
      try { return unwrap(await window.motion.media.renderDraft({ assetId: asset.id, analysisId: analyzed.id, image: { fit: coverFit, background } })); }
      finally { renderingId.current = ''; }
    }, result => { if (result) setDraft(result); });
  }
  async function saveMotion() {
    if (!asset || !draft || !savingReady) return;
    draftDialog.current?.querySelector('video')?.pause();
    setSaved(null);
    const saveId = crypto.randomUUID(); savingId.current = saveId; renderingId.current = draft.analysisId;
    try {
      await primary('选择保存位置…', async () => unwrap(await window.motion.media.saveDraft({ assetId: asset.id, draftId: draft.id, saveId })), result => {
        if (result) { setSaved(result); setNotice(`已保存 ${result.name}`); }
        else setNotice('已取消保存位置选择，未发布新的成品。');
      });
    } finally { if (savingId.current === saveId) { savingId.current = ''; renderingId.current = ''; } }
  }
  function exportMotion() {
    if (draft) setOutputOpen(true); else void previewOutput();
  }
  const importButton = <><button className="primary-button" data-testid="open-video" disabled={!ready || blocked} onClick={() => void openVideo()}>{preparing ? '正在准备引擎…' : opening ? '正在读取视频信息…' : asset ? '更换视频' : '导入本地视频'}</button>
    {(opening || nativePreparing) && <button onClick={() => void cancelOpening()}>取消导入</button>}</>;
  if (!asset) return <section className="editor-welcome">
    <div className="welcome-canvas"><div className="welcome-content"><div className="import-symbol" aria-hidden="true">＋</div>
      <h2>把视频，留在一张照片里</h2><p className="muted">选择视频 · 调整片段 · 定格封面</p>{importButton}
      <p className="hint">支持 MP4、MOV 等本地视频 · 不上传素材</p>
      {opening && <p className="hint" role="status">正在读取文件信息；不会先复制整个视频。读取后建立原生帧索引，必要时准备整片兼容素材。</p>}
      {notice && <p className="hint">{notice}</p>}{error && <p role="alert" className="error">{error}</p>}
    </div></div><div className="welcome-track" aria-hidden="true"><span>01</span><div /><div /><div /><div /><div /></div>
  </section>;
  if (asset.info.displayWidth < 2 || asset.info.displayHeight < 2) return <section className="panel">画面尺寸小于 2 像素，暂不支持偶数像素裁剪。{importButton}<button onClick={() => void closeVideo()}>关闭素材</button></section>;
  const pixels = copyMode ? { x: 0, y: 0, width: asset.info.displayWidth, height: asset.info.displayHeight }
    : cropToPixels(previewCrop(processing), asset.info.displayWidth, asset.info.displayHeight);
  const visibleCrop = { x: pixels.x / asset.info.displayWidth, y: pixels.y / asset.info.displayHeight,
    width: pixels.width / asset.info.displayWidth, height: pixels.height / asset.info.displayHeight };
  return <section data-testid="editor" className="editor">
    <div className="editor-heading"><div className="asset-heading"><span className="asset-symbol" aria-hidden="true">▤</span><div><h2 data-testid="asset-name" title={asset.name}>{asset.name}</h2>
      <p className="hint">{asset.info.displayWidth} × {asset.info.displayHeight} · {formatTime(duration)}</p></div></div>
      <div className="button-row">{importButton}<button disabled={opening || Boolean(savingId.current)} onClick={() => void closeVideo()}>关闭素材</button>
        <button data-testid="preview-output" disabled={blocked || !compatible && !copyMode} onClick={() => void previewOutput()}>预览输出</button>
        <button data-testid="export-motion" className="primary-button export-button" disabled={blocked || !savingReady || !compatible && !copyMode} onClick={exportMotion}>导出实况</button></div></div>
    {asset.info.hdr && <label className="warning check"><input type="checkbox" aria-label="同意 HDR 转 SDR" checked={hdrConsent} disabled={blocked}
      onChange={e => setHdrConsent(e.target.checked)} />这是 HDR 视频。我同意将预览、封面和导出统一转换为 SDR（源文件不变，不保留 HDR 效果）。</label>}
    <div className="workspace">
      <div className="editing-main panel">
        <div className="preview-caption"><strong>{!previewAvailable ? '原生预览未就绪' : nativeReady?.compatibility ? '兼容素材 · 原生低清预览，非成品' : '原片解码 · 原生低清预览，非成品'}</strong>
          {frame && <span data-testid="displayed-frame" data-pts={frame.pts}>已显示 {formatTime(frame.timeUs)} · 源帧 {frame.sourceFrame + 1}</span>}
          {!previewAvailable && compatible && !nativePreparing && <button onClick={() => setPrepareAttempt(value => value + 1)}>准备预览</button>}</div>
        {nativeReady?.warnings.length ? <details className="hint"><summary>预览处理说明</summary>{nativeReady.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details> : null}
        <CropStage width={asset.info.displayWidth} height={asset.info.displayHeight} crop={visibleCrop} locked={locked} disabled={blocked || copyMode} showOverlay={!copyMode} onChange={setCrop} onEdit={pause}>
          <PreviewSurface key={asset.id} ref={surface} controller={controller} enabled={previewAvailable && compatible} />
          {!previewAvailable && compatible && <div className="preview-buffering" role="status">{nativePreparing ? nativeProgress : '请准备预览或重新导入素材'}<br />完成准备后播放、拖动和选帧均由常驻引擎处理。</div>}
          {!compatible && <div className="stage-message">请先确认 HDR 转 SDR 策略</div>}
        </CropStage>
        <div className="transport button-row"><button data-testid="play-video" disabled={blocked || !compatible || !previewAvailable} onClick={() => playing ? pause() : void playAt(position < clip.startUs || position >= clip.endUs ? clip.startUs : position)}>{playing ? '暂停' : '播放选段'}</button>
          <button aria-label="上一帧" disabled={blocked || !compatible || !previewAvailable || !frame} onClick={() => void step(-1)}>◀ 帧</button>
          <button aria-label="下一帧" disabled={blocked || !compatible || !previewAvailable || !frame} onClick={() => void step(1)}>帧 ▶</button>
          <output data-testid="playhead">{formatTime(position)}</output></div>
        <div className="button-row crop-controls"><button aria-pressed={locked} disabled={blocked || copyMode} onClick={() => { setLocked(true); setCrop(fullCrop); }}>原比例</button>
          <button aria-pressed={!locked} disabled={blocked || copyMode} onClick={() => setLocked(false)}>自由框选</button><button disabled={blocked || copyMode} onClick={() => setCrop(fullCrop)}>重置画面</button>
          <span data-testid="crop-pixels">{pixels.width} × {pixels.height} · x {pixels.x} / y {pixels.y}</span></div>
      </div>
      <aside className="editor-sidebar">
        <section className="panel"><h3>封面</h3>
          <div className="cover-preview" style={{ aspectRatio: `${pixels.width} / ${pixels.height}`, width: `min(100%, ${140 * pixels.width / pixels.height}px)` }}>
            {cover ? <img data-testid="cover-preview" src={cover.url} alt={cover.name} style={cover.kind === 'custom' ? { width: '100%', height: '100%', objectFit: coverFit }
              : { position: 'absolute', width: `${100 / visibleCrop.width}%`, height: `${100 / visibleCrop.height}%`, maxWidth: 'none', left: `${-visibleCrop.x / visibleCrop.width * 100}%`, top: `${-visibleCrop.y / visibleCrop.height * 100}%` }} /> : <span>尚未选择封面</span>}
          </div>
          <div className="button-row"><button data-testid="capture-cover" disabled={blocked || !compatible || !previewAvailable || !frame} onClick={() => void capture()}>使用当前帧</button><button data-testid="upload-cover" disabled={blocked} onClick={() => void upload()}>上传 JPG / PNG</button></div>
          {cover && <p className="hint" data-testid="cover-description">{cover.name}{cover.timeUs !== null ? ` · ${formatTime(cover.timeUs)}` : ' · 独立封面'}</p>}
          {cover?.kind === 'custom' && <label className="field">封面适配<select aria-label="封面适配" disabled={blocked} value={coverFit} onChange={e => setCoverFit(e.target.value as 'cover' | 'contain')}><option value="cover">居中裁切，不拉伸</option><option value="contain">完整保留，黑色留边</option></select></label>}
        </section>
        <section className="panel"><h3>输出参数</h3>
          <label className="check mode-switch"><input type="checkbox" aria-label="原画质（跟随原片）" data-testid="source-matching" checked={copyMode} disabled={blocked} onChange={e => { pause(); setProcessing(previous => setProcessingMode(previous, e.target.checked ? 'copy' : 'encode')); }} />原画质（跟随原片）</label>
          {copyMode && <p className="hint">跟随原片分辨率、帧时序、音频采样率和声道数；视频高保真编码，音频采用 AAC-LC 兼容编码，非严格无损。关闭后恢复手动设置。</p>}
          <label className="field">输出帧率<select aria-label="输出帧率" disabled={blocked || copyMode} value={settings.fps ?? 'original'} onChange={e => setSettings({ ...settings, fps: e.target.value === 'original' ? null : Number(e.target.value) })}><option value="original">保持原片</option>{[24, 25, 30, 50, 60, 120].map(fps => <option key={fps} value={fps}>{fps} fps</option>)}</select></label>
          <label className="field">分辨率<select aria-label="分辨率" disabled={blocked || copyMode} value={settings.resolution} onChange={e => setSettings({ ...settings, resolution: e.target.value === 'original' ? 'original' : Number(e.target.value) as ExportSettings['resolution'] })}><option value="original">保留裁剪后分辨率</option>{[720, 1080, 1440, 2160].map(size => <option key={size} value={size}>最长边 {size} px</option>)}</select></label>
          <label className="field">画质 CRF · {settings.crf}<input aria-label="画质 CRF" disabled={blocked || copyMode} type="range" min="0" max="51" step="1" value={settings.crf} onChange={e => setSettings({ ...settings, crf: Number(e.target.value) })} /></label>
          <p className="hint">数值越低，质量越高，文件通常越大。</p>
          <label className="check"><input type="checkbox" aria-label="保留音轨" checked={audio} disabled={blocked || !asset.info.hasAudio} onChange={e => { pause(); setAudio(e.target.checked); }} />保留原视频音轨</label>
          {audio && asset.info.audioTracks.length > 1 && <label className="field">保留音轨<select aria-label="所保留的音轨" disabled={blocked} value={audioIndex ?? ''} onChange={e => { pause(); setAudioIndex(e.target.value === '' ? null : Number(e.target.value)); }}><option value="" disabled>请选择音轨 · 不会自动丢轨</option>{asset.info.audioTracks.map(track => <option key={track.index} value={track.index}>轨道 {track.index} · {track.codec} · {track.channels ?? '?'} 声道</option>)}</select></label>}
          {audio && (asset.info.audioTracks.find(t => t.index === audioIndex)?.channels ?? 0) > 2 && <label className="check"><input type="checkbox" aria-label="同意降混为立体声" disabled={blocked || copyMode} checked={downmix} onChange={e => setDownmix(e.target.checked)} />同意仅将音频降混为立体声</label>}
          {cover?.kind === 'custom' && <label className="field background-choice">透明区 / 留边背景<input aria-label="封面背景" type="color" value={background} disabled={blocked} onChange={e => setBackground(e.target.value)} /></label>}
          <p className="hint subtle-note">主画面是原片或兼容素材的低清预览；成品仍从原片处理。点击“预览输出”检查实际结果。</p>
          {inspection && <div className="inspection" data-testid="export-inspection"><p>请求 {formatTime(inspection.requested.startUs)} — {formatTime(inspection.requested.endUs)}</p>
            {inspection.actual && <p data-testid="actual-interval">实际 {formatTime(inspection.actual.startUs)} — {formatTime(inspection.actual.endUs)}</p>}
            {inspection.reasons.map((reason, i) => <p className="warning" key={i}>{reason}</p>)}
          </div>}
        </section>
      </aside>
    </div>
    <section className="timeline-panel panel" aria-label="片段剪辑">
      <div className="timeline-head"><div className="button-row"><strong>片段</strong><span data-testid="clip-duration">选段 {formatTime(clip.endUs - clip.startUs)}</span></div>
        <div className="button-row"><button disabled={blocked} onClick={() => { pause(); setZoom(0); setViewStart(0); changeClip({ startUs: 0, endUs: duration }); }}>全选片段</button>
          <label className="zoom-control">−<input aria-label="时间轴缩放" type="range" min="0" max={maxZoom} step="1" value={zoom} disabled={blocked} onChange={e => {
            const next = Number(e.target.value); const width = Math.max(minSpan, Math.round(duration / 2 ** next));
            setZoom(next); setViewStart(Math.max(0, Math.min(duration - width, position - width / 2)));
          }} />＋</label></div></div>
      <Timeline key={asset.id} durationUs={duration} startUs={start} endUs={end} selection={clip} positionUs={position} thumbnails={thumbs}
        disabled={blocked || !compatible || !previewAvailable} loading={thumbBusy} onSelect={changeClip} onInteraction={interact} />
      {span < duration && <label className="viewport-scroll">平移<input aria-label="时间轴视口起点" type="range" min="0" max={duration - span} step="1000" value={start} disabled={blocked} onChange={e => setViewStart(Number(e.target.value))} /></label>}
      <div className="timeline-bottom"><div className="time-fields"><TimeField label="截取开始" value={clip.startUs} disabled={blocked} change={value => { const next = validateClip({ ...clip, startUs: value }, duration); changeClip(next); interact({ kind: 'start', phase: 'keyboard', timeUs: next.startUs }); }} error={setError} />
        <TimeField label="截取结束" value={clip.endUs} disabled={blocked} change={value => { const next = validateClip({ ...clip, endUs: value }, duration); changeClip(next); interact({ kind: 'end', phase: 'keyboard', timeUs: next.endUs }); }} error={setError} />
        <TimeField label="精确定位" value={position} disabled={blocked || !compatible || !previewAvailable} change={exactSeek} error={setError} /></div>
        <span className="timeline-tip">拖动两端选择片段 · 白线定位画面</span></div>
    </section>
    {!outputOpen && (busy || notice || error) && <div className="editor-status" aria-live="polite">
      {busy && <p>{busy} <button onClick={() => void cancel()}>取消处理</button></p>}
      {notice && <p className="hint">{notice}</p>}{error && <p role="alert" className="error">{error}</p>}
    </div>}
    <dialog ref={draftDialog} className="draft-dialog" aria-labelledby="draft-title" onCancel={e => { if (busy) e.preventDefault(); else setOutputOpen(false); }} onClose={() => { if (!draftDialog.current?.open) setOutputOpen(false); draftDialog.current?.querySelector('video')?.pause(); }}>
      <div className="dialog-heading"><h2 id="draft-title">输出预览</h2><div className="button-row"><button data-testid="save-motion" className="primary-button" disabled={blocked || !savingReady || !draft} onClick={() => void saveMotion()}>保存实况照片</button><button aria-label="关闭输出预览" disabled={blocked} onClick={() => setOutputOpen(false)}>关闭</button></div></div>
      {busy && <div className="save-progress" aria-live="polite"><span data-testid="export-status" role="status">{busy}</span><button data-testid="cancel-export" onClick={() => void cancel()}>取消处理</button></div>}
      {error && <div className="export-failure" role="alert"><strong>本次操作未完成</strong><p>{error}</p><p>{copyMode ? '请关闭此窗口，按以上原因检查素材或音轨选择后重试。跟随原片预设不会静默丢轨。' : '请关闭此窗口，按上述原因调整音轨、降混等设置后重试。软件不会静默丢轨。'}</p></div>}
      {notice && !saved && <p className="hint" role="status">{notice}</p>}
      {!saved && <p className="hint" data-testid="export-save-hint">尚未收到保存成功确认。生成预览后点击“保存实况照片”，会弹出保存位置对话框；预览不会自动存成成品。</p>}
      {draft && <>{inspection?.id === draft.analysisId && inspection.actual && <p className="draft-range" data-testid="preview-actual-range">请求 {formatTime(inspection.requested.startUs)} — {formatTime(inspection.requested.endUs)}<br />实际 {formatTime(inspection.actual.startUs)} — {formatTime(inspection.actual.endUs)}</p>}
        <div className="draft-comparison"><div><h3>视频</h3><video data-testid="output-video" controls playsInline src={draft.videoUrl} preload="metadata" /></div>
        <div><h3>照片封面</h3><img data-testid="output-cover" src={draft.coverUrl} alt="处理后的照片封面" /></div></div>
        <p className="hint">{draft.width} × {draft.height} · {formatTime(draft.durationUs)} · {draft.coverTimestampUs === -1 ? '独立封面，无对应视频帧' : `封面对应 ${formatTime(draft.coverTimestampUs)}`}</p>
        <p data-testid="output-proof" className="draft-proof">{draft.proof.kind === 'copy' ? '视频原画：压缩包与时间戳对照、完整解码已通过，视频没有重新编码。JPEG 封面另行编码。' : draft.proof.sourceMatched ? '原画质预设：尺寸/帧时序跟随原片，高保真编码，非严格无损。输出已完整解码检查。' : '精确模式：视频已重新编码，输出配置与完整解码已检查。'}</p>
        {draft.proof.kind === 'encode' && <p className="hint" data-testid="output-color-compatibility">视频与封面统一采用 sRGB 色彩处理；目标设备播放效果仍需核对。</p>}
        {draft.proof.kind === 'encode' && draft.proof.sourceMatched && <p className="hint" data-testid="source-audio-parameters">音频：{draft.proof.audioCodec ?? '无音轨'} · {draft.proof.audioSampleRate ?? '—'} Hz · {draft.proof.audioChannels ?? 0} 声道</p>}
        {draft.proof.kind === 'encode' && draft.proof.sourceMatched && draft.proof.audioCodec === 'aac' && <p className="hint" data-testid="source-audio-compatibility">音频采用 AAC-LC，提高相册播放兼容性；原采样率和声道数保留，非无损音频。目标设备仍需实际验证。</p>}
        {draft.proof.kind === 'copy' && draft.proof.audioTailUs > 0 && <p className="warning" data-testid="audio-tail">完整音频包比视频尾部延长 {(draft.proof.audioTailUs / 1000).toFixed(3)} ms。</p>}
        <details className="draft-notes"><summary>处理说明</summary>{draft.warnings.map((warning, i) => <p className="hint" key={i}>{warning}</p>)}</details>
        {saved && <div data-testid="save-result" className="saved-result" role="status"><p>已保存 {saved.name}</p><p>{(saved.size / 1048576).toFixed(2)} MiB · 单个 JPG 实况照片</p>{saved.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</div>}
        <p className="hint">预览不会自动保存。确认后点击“保存实况照片”，请选择新文件名；已有文件不会被覆盖。</p></>}
    </dialog>
  </section>;
}
