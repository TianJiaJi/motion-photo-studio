import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Reply } from '../../shared/contracts.ts';
import type { VideoAsset, Thumbnail, CoverAsset } from '../../shared/media.ts';
import type { PreviewReady, PreviewStamp, PreviewBoundary } from '../../shared/native-preview.ts';
import { PreviewController } from './preview-controller.ts';
import { PreviewSurface, type PreviewSurfaceHandle } from './PreviewSurface.tsx';
import { centeredAspectCrop, clipSelectionWithDuration, parseClipDurationSeconds, cropToPixels, formatTime, parseTime, validateClip, createClip, clipSelectionAt, MAX_CLIPS } from '../../shared/editor.ts';
import type { CropRect, ClipSelection, ExportSettings, ClipModel } from '../../shared/editor.ts';
import type { ClipReference } from '../../shared/media-ipc.ts';
import type { ProcessingState } from '../../shared/processing.ts';
import { CropStage } from './CropStage.tsx';
import { ImportWelcome } from './ImportWelcome.tsx';
import { Timeline, type TimelineInteraction } from './Timeline.tsx';
import { createProcessingState, effectiveProcessing, previewCrop, setProcessingMode, updateProcessingEdits, SOURCE_MATCH_EDITS } from '../../shared/processing.ts';
import type { BatchSnapshot, BatchResult } from '../../shared/export.ts';
import { initialAudioTrack, audioSelection } from '../../shared/export.ts';
import './editor.css';
import './workspace.css';
import './export-dialog.css';

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
type EditorClip = ClipModel & { cover: CoverAsset | null };
const emptyClip: EditorClip = { ...createClip('empty', { startUs: 0, endUs: 1 }, 1), cover: null };
export function Editor({ ready, preparing, diagnosticsBusy, savingReady }: { ready: boolean; preparing: boolean; diagnosticsBusy: boolean; savingReady: boolean }) {
  const [asset, setAsset] = useState<VideoAsset | null>(null);
  const assetRef = useRef<VideoAsset | null>(null);
  const [nativeReady, setNativeReady] = useState<PreviewReady | null>(null);
  const [nativePreparing, setNativePreparing] = useState(false);
  const [nativeProgress, setNativeProgress] = useState('准备原生预览…');
  const [prepareAttempt, setPrepareAttempt] = useState(0);
  const [forceStrict, setForceStrict] = useState(false);
  const previewEpoch = useRef(0);
  const [controller, setController] = useState<PreviewController | null>(null);
  const controllerRef = useRef<PreviewController | null>(null);
  const surface = useRef<PreviewSurfaceHandle>(null);
  const [frame, setFrame] = useState<PreviewStamp | null>(null);
  const targetKind = useRef<'start' | 'end' | 'playhead' | 'step' | 'play'>('playhead');
  const [clips, setClips] = useState<EditorClip[]>([]);
  const clipsRef = useRef<EditorClip[]>([]);
  const [activeClipId, setActiveClipId] = useState('');
  const activeClipRef = useRef('');
  const nextClipNumber = useRef(2);
  const clipSync = useRef<Promise<void>>(Promise.resolve());
  const activeClip = clips.find(item => item.id === activeClipId) ?? emptyClip;
  const { cover, selection: clip, cropLocked: locked, coverFit, background } = activeClip;
  function commitClips(next: EditorClip[], sync = true) {
    clipsRef.current = next; setClips(next);
    const source = assetRef.current;
    if (sync && source) {
      const promise = window.motion.media.syncClips({ assetId: source.id, clips: next.map(({ cover: _cover, ...model }) => model) }).then(unwrap).then(() => {});
      clipSync.current = promise;
      void promise.catch(report);
    }
  }
  function updateClip(change: Partial<Omit<EditorClip, 'id' | 'number' | 'revision'>>, id = activeClipRef.current) {
    commitClips(clipsRef.current.map(item => item.id === id ? { ...item, ...change, revision: item.revision + 1 } : item));
  }
  function changeShared(action: () => void) {
    commitClips(clipsRef.current.map(item => ({ ...item, revision: item.revision + 1 })));
    action();
  }
  async function syncedClip(): Promise<ClipReference> {
    const chosen = clipsRef.current.find(item => item.id === activeClipRef.current);
    if (!chosen) throw new Error('没有活动片段。');
    const ref = { clipId: chosen.id, revision: chosen.revision };
    await clipSync.current;
    if (clipsRef.current.find(item => item.id === ref.clipId)?.revision !== ref.revision)
      throw Object.assign(new Error('片段已变化。'), { code: 'CANCELLED' });
    return ref;
  }
  function acceptCover(ref: ClipReference, value: CoverAsset | null) {
    if (clipsRef.current.find(item => item.id === ref.clipId)?.revision === ref.revision) updateClip({ cover: value }, ref.clipId);
  }
  const setLocked = (cropLocked: boolean) => updateClip({ cropLocked });
  const setCoverFit = (fit: 'cover' | 'contain') => updateClip({ coverFit: fit });
  const setBackground = (value: string) => updateClip({ background: value });
  const [thumbs, setThumbs] = useState<Thumbnail[]>([]);
  const [thumbBusy, setThumbBusy] = useState(false);
  const [position, setPosition] = useState(0);
  const [sharedProcessing, setSharedProcessing] = useState(() => createProcessingState());
  const processing: ProcessingState = { ...sharedProcessing, saved: { ...sharedProcessing.saved, crop: activeClip.crop } };
  const setProcessing = (update: (previous: ProcessingState) => ProcessingState) => changeShared(() => setSharedProcessing(update(processing)));
  const copyMode = processing.mode === 'copy';
  const settings = copyMode ? SOURCE_MATCH_EDITS.settings : processing.saved.settings;
  const setCrop = (crop: CropRect) => { if (!copyMode) updateClip({ crop }); };
  const setSettings = (settings: ExportSettings) => setProcessing(previous => updateProcessingEdits(previous, { settings }));
  const [audio, setAudio] = useState(true);
  const [audioIndex, setAudioIndex] = useState<number | null>(null); const [downmix, setDownmix] = useState(false);
  const [exportPreviewId, setExportPreviewId] = useState('');
  const [automaticPreviewCover, setAutomaticPreviewCover] = useState<string | null>(null);
  const automaticCoverEpoch = useRef<number | null>(null);
  const editingReturnPosition = useRef(0);
  const editingReturnKind = useRef<typeof targetKind.current>('playhead');
  const exportViewing = useRef(false);
  const draftDialog = useRef<HTMLDialogElement>(null);
  const [outputOpen, setOutputOpen] = useState(false);
  const activeOperation = useRef(0);
  const [exportScope, setExportScope] = useState<'current' | 'all'>('all');
  const exportSelectionId = clips.some(item => item.id === exportPreviewId) ? exportPreviewId : activeClipId;
  const exportClips = exportScope === 'all' ? clips : clips.filter(item => item.id === exportSelectionId);
  const exportPreviewClip = exportClips.find(item => item.id === exportPreviewId) ?? exportClips.find(item => item.id === activeClipId) ?? exportClips[0] ?? activeClip;
  const playbackSelection = outputOpen ? exportPreviewClip.selection : clip;
  const exportInterval = useRef<ClipSelection | null>(null); exportInterval.current = outputOpen ? exportPreviewClip.selection : null;
  const [batchDuration, setBatchDuration] = useState('3');
  const batchDurationUs = parseClipDurationSeconds(batchDuration);
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
  const batchRef = useRef('');
  const [hdrConsent, setHdrConsent] = useState(false);
  const [zoom, setZoom] = useState(0); const [viewStart, setViewStart] = useState(0);
  const [readingImport, setReadingImport] = useState(false);
  const [opening, setOpening] = useState(false); const [busy, setBusy] = useState('');
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [playing, setPlaying] = useState(false);
  const sequence = useRef(0); const target = useRef(0); const displayed = useRef(0);
  const playIntent = useRef(false); const playbackEnded = useRef(false);
  const duration = asset?.info.durationUs ?? 1;
  const minSpan = Math.min(duration, 500000);
  const maxZoom = Math.max(0, Math.ceil(Math.log2(duration / minSpan)));
  const span = Math.max(minSpan, Math.round(duration / 2 ** zoom));
  const start = Math.min(viewStart, Math.max(0, duration - span));
  const end = Math.min(duration, start + span);
  const blocked = opening || Boolean(busy) || diagnosticsBusy || nativePreparing;
  const previewAvailable = Boolean(nativeReady && nativeReady.assetId === asset?.id && !nativePreparing);
  const previewAudioTrack = audio ? audioIndex : null;
  const audioChoicePending = Boolean(audio && asset?.info.hasAudio && audioIndex === null);
  const compatible = !asset?.info.hdr || hdrConsent;
  const chosenAudio = audioSelection(audio, audioIndex, asset?.info.audioTracks ?? [], downmix);
  const exportKey = JSON.stringify({ asset: asset?.id, clipId: activeClipId, revision: activeClip.revision, clip, processing: effectiveProcessing(processing), audio, audioIndex, downmix, hdrConsent });
  useEffect(() => { setBatchResult(null); }, [exportKey]);
  useEffect(() => {
    const dialog = draftDialog.current;
    if (outputOpen && asset) { if (dialog && !dialog.open) dialog.showModal(); }
    else dialog?.close();
  }, [outputOpen, asset?.id]);
  useEffect(() => {
    if (!window.motion) return;
    return window.motion.media.onExportProgress(progress => {
    if (!activeOperation.current || progress.assetId !== assetRef.current?.id) return;
    if (!progress.batch || progress.batch.batchId !== batchRef.current) return;
    const stages: Record<string, string> = { plan: '确认剪点', audio: '处理音轨', video: '编码画面', copy: '复制原始码流',
      'verify-packets': '校验视频与音频包', 'verify-source-audio': '对照源音轨', decode: '完整解码检查', verify: '校验输出', cover: '生成封面', image: '处理封面色彩', mux: '写入实况照片', 'read-back': '回读检查格式', 'verify-jpeg': '核对照片字节',
      'verify-video-bytes': '核对视频字节', publish: '安全发布文件' };
    const detail = progress.writtenBytes !== undefined && progress.totalBytes !== undefined
      ? ` · ${(progress.writtenBytes / 1048576).toFixed(1)} / ${(progress.totalBytes / 1048576).toFixed(1)} MiB`
      : progress.timeUs === undefined ? '…' : ` · ${formatTime(Math.max(0, progress.timeUs))}`;
    setBusy(`${progress.batch ? `${progress.batch.clipName}（${progress.batch.index}/${progress.batch.total}） · ` : ''}${stages[progress.stage] ?? '处理输出'}${detail}`);
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
    playIntent.current = false; playbackEnded.current = false; setPlaying(false);
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
    pause(); ++sequence.current; activeOperation.current = 0; setBusy(''); setOpening(true); setReadingImport(false); setError(''); setNotice('');
    const unsubscribe = window.motion.media.onImportSelected(() => setReadingImport(true));
    try {
      const selected = unwrap(await window.motion.media.open());
      if (!selected) return;
      controllerRef.current?.dispose();
      assetRef.current = selected; setAsset(selected); setNativeReady(null); setFrame(null); setThumbs([]);
      setPosition(0); target.current = displayed.current = 0;
      commitClips([{ ...createClip(selected.id, { startUs: 0, endUs: selected.info.durationUs }, selected.info.durationUs), cover: null }], false);
      activeClipRef.current = selected.id; setActiveClipId(selected.id); nextClipNumber.current = 2; clipSync.current = Promise.resolve();
      setSharedProcessing(createProcessingState()); setExportScope('all'); setBatchResult(null); setOutputOpen(false);
      setAudio(selected.info.hasAudio); setAudioIndex(initialAudioTrack(selected.info.audioTracks)); setDownmix(false);
      setHdrConsent(false); setForceStrict(false); setZoom(0); setViewStart(0); setNotice('');
    } catch (e) { report(e); } finally { unsubscribe(); setOpening(false); setReadingImport(false); }
  }
  async function closeVideo() {
    if (!asset) return;
    pause(); ++sequence.current; activeOperation.current = 0; setBusy('正在关闭素材');
    try {
      unwrap(await window.motion.media.close({ assetId: asset.id })); assetRef.current = null; setAsset(null);
      controllerRef.current?.dispose(); setNativeReady(null); setFrame(null); commitClips([], false); setThumbs([]); setError('');
    } catch (e) { report(e); } finally { setBusy(''); }
  }
  async function cancel() {
    if (!asset || !activeOperation.current) return;
    const batchId = batchRef.current;
    pause(); ++sequence.current; activeOperation.current = 0;
    try {
      const result = unwrap(await window.motion.media.cancel({ assetId: asset.id, ...(batchId ? { batchId } : {}) }));
      if (result.batch) { setBatchResult(result.batch); setNotice(`批次已停止；保留 ${result.batch.saved.length} 个已发布文件。`); }
      else if (result.saved) setNotice(`已保存 ${result.saved.name}`);
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
        const range = exportViewing.current ? exportInterval.current : null;
        if (range && (pixels.timeUs < range.startUs || pixels.timeUs >= range.endUs)) {
          ctl.drop(pixels); setFrame(null);
          if (pixels.timeUs >= range.endUs && automaticCoverEpoch.current !== pixels.epoch) ctl.seek(range.endUs, 'before');
          else { if (playIntent.current) ctl.pause(); playIntent.current = false; setPlaying(false); setError('选段内没有可预览的画面，请调整范围。'); }
          return;
        }
        if (assetRef.current?.id === id && surface.current) surface.current.enqueue(pixels);
        else ctl.drop(pixels);
      },
      displayed: stamp => {
        if (assetRef.current?.id !== id) return;
        setFrame(stamp); displayed.current = stamp.timeUs;
        if (exportViewing.current && automaticCoverEpoch.current === stamp.epoch) {
          setAutomaticPreviewCover(surface.current?.snapshot() ?? null); automaticCoverEpoch.current = null;
        }
        if (!ctl.isDragging && stamp.epoch === ctl.epoch && !['start', 'end'].includes(targetKind.current)) {
          target.current = stamp.timeUs; setPosition(stamp.timeUs);
        }
      },
      error: failure => { if (assetRef.current?.id === id) report(failure); },
    }, previewEpoch.current);
    controllerRef.current = ctl; setController(ctl);
    const unsubscribeFrame = window.motion.media.native.onFrame(pixels => { if (pixels.assetId === id) ctl.receive(pixels); });
    const unsubscribeStatus = window.motion.media.native.onStatus(status => {
      if (assetRef.current?.id !== id || !ctl.acceptsStatus(status)) return;
      if (status.state === 'preparing') {
        const labels = { 'source-index': '建立源帧索引', 'native-index': '核对原生帧映射', compatibility: '准备整片兼容素材', audio: '核对并准备音轨' };
        setNativeProgress(`${status.reason ? `${status.reason} · ` : ''}${status.stage ? labels[status.stage] : '准备原生预览'}${status.frames !== undefined ? ` · ${status.frames} 个样本` : ''}${status.bytes !== undefined ? ` · ${(status.bytes / 1048576).toFixed(1)} MiB` : ''}`);
      }
      if (status.state === 'playing' || status.state === 'paused' || status.state === 'failed') {
        if (status.state === 'paused' && !status.error && playIntent.current) playbackEnded.current = true;
        playIntent.current = status.state === 'playing'; setPlaying(status.state === 'playing');
      }
      if (status.state === 'failed') { ctl.dispose(); setNativeReady(null); setFrame(null); }
      if (status.error) report(Object.assign(new Error(status.error.message), { code: status.error.code }));
    });
    return () => { previewEpoch.current = Math.max(previewEpoch.current, ctl.epoch); ctl.dispose(); unsubscribeFrame(); unsubscribeStatus(); if (controllerRef.current === ctl) controllerRef.current = null; };
  }, [asset?.id, prepareAttempt]);
  useEffect(() => {
    let active = true; setNativeReady(null); setFrame(null);
    if (!asset || !compatible || audioChoicePending) { if (nativeReady?.assetId === asset?.id && nativeReady) controllerRef.current?.pause(); setNativePreparing(false); return; }
    setNativePreparing(true); setNativeProgress('准备原生预览…');
    window.motion.media.native.prepare({ assetId: asset.id, hdrConsent, audioTrack: previewAudioTrack, forceStrict }).then(unwrap).then(result => {
      if (active && assetRef.current?.id === result.assetId) { setNativeReady(result); setError(''); }
    }).catch(failure => { if (active) report(failure); }).finally(() => { if (active) setNativePreparing(false); });
    return () => { active = false; };
  }, [asset?.id, hdrConsent, prepareAttempt, previewAudioTrack, audioChoicePending, forceStrict]);
  useEffect(() => {
    if (previewAvailable && controller) {
      playIntent.current = false; playbackEnded.current = false; setPlaying(false); setFrame(null);
      const at = outputOpen ? exportPreviewClip.selection.startUs : target.current;
      if (outputOpen) targetKind.current = 'playhead';
      target.current = at; setPosition(at);
      setAutomaticPreviewCover(null);
      controller.seek(at, targetKind.current === 'end' || at >= duration ? 'before' : 'after');
      automaticCoverEpoch.current = outputOpen ? controller.epoch : null;
    }
  }, [nativeReady, controller, previewAvailable, outputOpen, outputOpen ? exportPreviewClip.id : null]);
  const thumbnailsReady = previewAvailable;
  useEffect(() => {
    let active = true;
    if (!asset || !compatible || !thumbnailsReady) { setThumbs([]); setThumbBusy(false); return; }
    setThumbBusy(true);
    // Viewport-only requests, deduplicated by range: keep the previous strip visible while the
    // superseding request runs (the main-process background lane cancels the stale one).
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
    targetKind.current = 'play'; target.current = at; setPosition(at); playIntent.current = true; playbackEnded.current = false; setPlaying(true);
    controllerRef.current?.play(at, playbackSelection.endUs, audio ? audioIndex : null);
  }
  function changeClip(next: ClipSelection, id = activeClipRef.current) {
    try { updateClip({ selection: validateClip(next, duration) }, id); setError(''); } catch (e) { report(e); }
  }
  function trimAtPlayhead(kind: 'start' | 'end') {
    if (blocked || !previewAvailable || !frame) return;
    const at = playIntent.current ? displayed.current : position;
    try {
      const next = validateClip({ ...clip, ...(kind === 'start' ? { startUs: at } : { endUs: at }) }, duration);
      changeClip(next); interact({ kind, phase: 'keyboard', timeUs: at });
    } catch (e) { report(e); }
  }
  function applyAspect(aspect: number | null) {
    if (blocked || copyMode || !asset) return;
    pause();
    updateClip({ crop: aspect === null ? { ...fullCrop } : centeredAspectCrop(asset.info.displayWidth, asset.info.displayHeight, aspect), cropLocked: aspect === null });
  }
  function uniformDuration() {
    if (blocked || !asset || batchDurationUs === null) return;
    pause();
    const next = clipsRef.current.map(item => ({ ...item, revision: item.revision + 1, selection: clipSelectionWithDuration(item.selection, duration, batchDurationUs) }));
    commitClips(next);
    const short = next.filter(item => item.selection.endUs - item.selection.startUs < batchDurationUs).length;
    const seconds = batchDurationUs / 1e6;
    setError(''); setNotice(`已按 ${seconds} 秒调整 ${next.length} 段，起点保持不变。${short ? `其中 ${short} 段距片尾不足 ${seconds} 秒，保留剩余时长。` : `每段均为 ${seconds} 秒。`}`);
  }
  function syncCurrentCrop() {
    if (blocked || copyMode || clipsRef.current.length < 2) return;
    pause();
    const current = clipsRef.current.find(item => item.id === activeClipRef.current)!;
    commitClips(clipsRef.current.map(item => item.id === current.id ? item : { ...item, revision: item.revision + 1, crop: { ...current.crop }, cropLocked: current.cropLocked }));
    setError(''); setNotice(`已将当前裁剪应用到全部 ${clipsRef.current.length} 段，封面和选段时间不变。`);
  }
  function activateClip(id: string) {
    if (id === activeClipRef.current) return;
    pause(); activeClipRef.current = id; setActiveClipId(id); setOutputOpen(false);
  }
  function addClip() {
    if (!asset || clipsRef.current.length >= MAX_CLIPS) return;
    pause(); const id = crypto.randomUUID();
    const next = { ...createClip(id, clipSelectionAt(position, duration), duration, nextClipNumber.current++), cover: null };
    commitClips([...clipsRef.current, next]); activateClip(id);
  }
  function deleteClip(id: string) {
    if (clipsRef.current.length <= 1) return;
    pause(); const remaining = clipsRef.current.filter(item => item.id !== id);
    commitClips(remaining);
    if (activeClipRef.current === id) activateClip(remaining[0]!.id);
  }
  async function capture() {
    if (!asset) return;
    await primary('固定当前封面…', async () => {
      const ref = await syncedClip(); const shown = controllerRef.current?.confirmed;
      if (!shown) throw new Error('请等待当前画面确认后选作封面。');
      const request = window.motion.media.native.capture({ assetId: asset.id, ...ref, frameId: shown.frameId, epoch: shown.epoch });
      pause(); return { ref, cover: unwrap(await request) };
    }, result => acceptCover(result.ref, result.cover));
  }
  async function upload() {
    if (!asset) return; pause();
    await primary('选择自定义封面…', async () => {
      const ref = await syncedClip(); return { ref, cover: unwrap(await window.motion.media.uploadCover({ assetId: asset.id, ...ref })) };
    }, result => { if (result.cover) acceptCover(result.ref, result.cover); });
  }
  async function automaticCover() {
    if (!asset) return; pause();
    await primary('恢复自动封面…', async () => {
      const ref = await syncedClip(); unwrap(await window.motion.media.clearCover({ assetId: asset.id, ...ref })); return ref;
    }, ref => acceptCover(ref, null));
  }
  function togglePlayback() {
    if (blocked || !compatible || !previewAvailable || !frame) return;
    if (playIntent.current) pause();
    else playAt(playbackEnded.current || position < playbackSelection.startUs || position >= playbackSelection.endUs ? playbackSelection.startUs : position);
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || event.defaultPrevented) return;
      const element = event.target instanceof Element ? event.target : null;
      if (element?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"]:not([data-playback-shortcut]), summary, a')) return;
      // Space is the transport shortcut even after clicking an editor command.
      // Timeline handles use Space for transport, arrows for editing; ordinary form sliders keep native keys.
      const modal = document.querySelector('dialog[open]');
      if (modal && modal !== draftDialog.current) return;
      if (!asset) return;
      event.preventDefault();
      if (!event.repeat) togglePlayback();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });
  function selectExportPreview(id: string) {
    if (blocked) return;
    pause(false); setExportPreviewId(id);
    if (id === exportPreviewClip.id) seekExportPreview(exportPreviewClip.selection.startUs);
  }
  function seekExportPreview(at: number) {
    if (blocked || !previewAvailable) return;
    const range = exportPreviewClip.selection;
    const bounded = Math.max(range.startUs, Math.min(range.endUs, at));
    pause(false); targetKind.current = 'playhead'; target.current = bounded; setPosition(bounded);
    controllerRef.current?.seek(bounded, bounded >= range.endUs ? 'before' : 'after');
  }
  function closeExport() {
    if (blocked) return;
    pause(false); exportViewing.current = false; automaticCoverEpoch.current = null;
    targetKind.current = editingReturnKind.current;
    target.current = editingReturnPosition.current; setPosition(target.current); setFrame(null);
    setOutputOpen(false);
  }
  async function exportAll() {
    if (!asset || !chosenAudio) { setError('请选择音轨或关闭声音。'); return; }
    const selected = exportScope === 'all' ? clipsRef.current : clipsRef.current.filter(item => item.id === exportPreviewClip.id);
    const snapshot: BatchSnapshot = { assetId: asset.id, batchId: crypto.randomUUID(),
      mode: copyMode ? 'source' : 'encode', settings: { ...settings }, audio: { ...chosenAudio }, hdrConsent,
      clips: selected.map(item => ({ clipId: item.id, revision: item.revision, selection: { ...item.selection }, crop: { ...item.crop },
        cover: item.cover ? { kind: item.cover.kind, coverId: item.cover.id } : { kind: 'auto' },
        coverFit: item.coverFit, background: item.background })) };
    pause();
    setBatchResult(null); batchRef.current = snapshot.batchId;
    try {
      await primary('选择导出文件夹…', async () => {
        await clipSync.current;
        return unwrap(await window.motion.media.exportAll({ assetId: snapshot.assetId, snapshot }));
      }, setBatchResult);
    } finally { if (batchRef.current === snapshot.batchId) batchRef.current = ''; }
  }
  function exportMotion() {
    const wasPlaying = playIntent.current; const at = pause();
    editingReturnPosition.current = wasPlaying ? at : position;
    editingReturnKind.current = targetKind.current; exportViewing.current = true;
    setExportPreviewId(activeClipRef.current); setFrame(null); setError(''); setNotice(''); setBatchResult(null); setOutputOpen(true);
  }
  const importButton = <button className="primary-button" data-testid="open-video" disabled={!ready || blocked} onClick={() => void openVideo()}>
    {!asset && <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z"/><path d="M8 13h8m-4-4v8"/></svg>}
    {preparing ? '正在准备引擎…' : opening ? readingImport ? '正在打开视频…' : '正在选择视频…' : asset ? '更换视频' : '选择本地视频'}
  </button>;
  if (!asset) return <ImportWelcome action={importButton} phase={opening ? readingImport ? 'reading' : 'choosing' : 'idle'} error={error} notice={notice} />;
  if (asset.info.displayWidth < 2 || asset.info.displayHeight < 2) return <section className="panel">画面尺寸小于 2 像素，暂不支持偶数像素裁剪。{importButton}<button onClick={() => void closeVideo()}>关闭素材</button></section>;
  const pixels = copyMode ? { x: 0, y: 0, width: asset.info.displayWidth, height: asset.info.displayHeight }
    : cropToPixels(previewCrop(processing), asset.info.displayWidth, asset.info.displayHeight);
  const visibleCrop = { x: pixels.x / asset.info.displayWidth, y: pixels.y / asset.info.displayHeight,
    width: pixels.width / asset.info.displayWidth, height: pixels.height / asset.info.displayHeight };
  const exportPixels = copyMode ? { x: 0, y: 0, width: asset.info.displayWidth, height: asset.info.displayHeight }
    : cropToPixels(exportPreviewClip.crop, asset.info.displayWidth, asset.info.displayHeight);
  const exportCrop = { x: exportPixels.x / asset.info.displayWidth, y: exportPixels.y / asset.info.displayHeight,
    width: exportPixels.width / asset.info.displayWidth, height: exportPixels.height / asset.info.displayHeight };
  const previewCover = exportPreviewClip.cover;
  const exportCoverUrl = previewCover?.url ?? automaticPreviewCover;
  const audioControls = <>          <label className="check"><input type="checkbox" aria-label="保留音轨" checked={audio} disabled={blocked || !asset.info.hasAudio} onChange={e => { pause(); changeShared(() => setAudio(e.target.checked)); }} />保留原视频音轨</label>
          {audio && asset.info.audioTracks.length > 1 && <label className="field">保留音轨<select aria-label="所保留的音轨" disabled={blocked} value={audioIndex ?? ''} onChange={e => { pause(); changeShared(() => setAudioIndex(e.target.value === '' ? null : Number(e.target.value))); }}><option value="" disabled>请选择音轨 · 不会自动丢轨</option>{asset.info.audioTracks.map(track => <option key={track.index} value={track.index}>轨道 {track.index} · {track.codec} · {track.channels ?? '?'} 声道</option>)}</select></label>}
</>;
  const outputSettings = (<section className="panel"><h3>输出设置</h3>
          {outputOpen && <div className="export-audio-controls">{audioControls}{!asset.info.hasAudio && <p className="hint">原视频没有音轨</p>}</div>}
          <label className="check mode-switch"><input type="checkbox" aria-label="原画质（跟随原片）" data-testid="source-matching" checked={copyMode} disabled={blocked} onChange={e => { pause(); setProcessing(previous => setProcessingMode(previous, e.target.checked ? 'copy' : 'encode')); }} />原画质（跟随原片）</label>
          {copyMode && <p className="hint">保留原片规格，不应用裁剪；兼容编码，非无损。</p>}
          <label className="field">输出帧率<select aria-label="输出帧率" disabled={blocked || copyMode} value={settings.fps ?? 'original'} onChange={e => setSettings({ ...settings, fps: e.target.value === 'original' ? null : Number(e.target.value) })}><option value="original">保持原片</option>{[24, 25, 30, 50, 60, 120].map(fps => <option key={fps} value={fps}>{fps} fps</option>)}</select></label>
          <label className="field">分辨率<select aria-label="分辨率" disabled={blocked || copyMode} value={settings.resolution} onChange={e => setSettings({ ...settings, resolution: e.target.value === 'original' ? 'original' : Number(e.target.value) as ExportSettings['resolution'] })}><option value="original">保留裁剪后分辨率</option>{[720, 1080, 1440, 2160].map(size => <option key={size} value={size}>最长边 {size} px</option>)}</select></label>
          <label className="field">画质 CRF · {settings.crf}<input aria-label="画质 CRF" disabled={blocked || copyMode} type="range" min="0" max="51" step="1" value={settings.crf} onChange={e => setSettings({ ...settings, crf: Number(e.target.value) })} /></label>
          <p className="hint">数值越低，质量越高，文件通常越大。</p>
          {audio && (asset.info.audioTracks.find(t => t.index === audioIndex)?.channels ?? 0) > 2 && <label className="check"><input type="checkbox" aria-label="同意降混为立体声" disabled={blocked || copyMode} checked={downmix} onChange={e => changeShared(() => setDownmix(e.target.checked))} />同意仅将音频降混为立体声</label>}



        </section>);
  const toolbarHost = document.getElementById('editor-toolbar');
  return <section data-testid="editor" className="editor">
    {toolbarHost && createPortal(<><div className="asset-heading"><div><h2 data-testid="asset-name" title={asset.name}>{asset.name}</h2>
      <p className="hint">{asset.info.displayWidth} × {asset.info.displayHeight} · {formatTime(duration)}</p></div></div>
      <div className="button-row file-actions">{importButton}<button disabled={opening || Boolean(busy) || Boolean(batchRef.current)} onClick={() => void closeVideo()}>关闭素材</button>
      <button data-testid="export-motion" className="primary-button export-button" disabled={blocked || !savingReady || !compatible} onClick={exportMotion}>导出实况 ↗</button></div></>, toolbarHost)}
    {asset.info.hdr && <label className="warning check"><input type="checkbox" aria-label="同意 HDR 转 SDR" checked={hdrConsent} disabled={blocked}
      onChange={e => changeShared(() => setHdrConsent(e.target.checked))} />这是 HDR 视频。我同意将预览、封面和导出统一转换为 SDR（源文件不变，不保留 HDR 效果）。</label>}
    <div className="workspace">
      <div className="editing-main panel">
        <div className="preview-caption"><strong title="编辑为低清预览，成品从原片处理">{!previewAvailable ? '正在准备画面' : nativeReady?.compatibility ? '兼容预览' : '编辑预览'}</strong>
          {frame && <span data-testid="displayed-frame" data-pts={frame.pts ?? ''}>已显示 {formatTime(frame.timeUs)} · {frame.pts === null ? '源帧待核对' : frame.sourceFrame === null ? `源 PTS ${frame.pts}` : `源帧 ${frame.sourceFrame + 1}`}</span>}
          {!previewAvailable && compatible && !nativePreparing && <button onClick={() => setPrepareAttempt(value => value + 1)}>准备预览</button>}
          {compatible && !blocked && !forceStrict && <button onClick={() => { pause(); setForceStrict(true); setPrepareAttempt(value => value + 1); }}>精确兼容准备（较慢）</button>}</div>
        {nativeReady?.warnings.length ? <details className="hint"><summary>预览处理说明</summary>{nativeReady.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details> : null}
        <CropStage width={asset.info.displayWidth} height={asset.info.displayHeight} crop={visibleCrop} locked={locked} disabled={blocked || copyMode} showOverlay={!copyMode} onChange={setCrop} onEdit={pause}>
          {!outputOpen && <PreviewSurface key={asset.id} ref={surface} controller={controller} enabled={previewAvailable && compatible} />}
          {!previewAvailable && compatible && <div className={`preview-buffering${audioChoicePending ? ' needs-audio' : ''}`} role="status">{audioChoicePending ? <div className="preview-audio-choice"><p>此视频包含多条音轨，请先确认预览声音。</p><button disabled={blocked} onPointerDown={e => e.stopPropagation()} onClick={exportMotion}>前往导出设置选择音轨</button></div> : nativePreparing ? nativeProgress : '请准备预览或重新导入素材'}</div>}
          {!compatible && <div className="stage-message">请先确认 HDR 转 SDR 策略</div>}
        </CropStage>
        <div className="transport button-row"><button data-testid="play-video" data-playback-control title="空格：播放 / 暂停" disabled={blocked || !compatible || !previewAvailable || !frame} onClick={togglePlayback}>{playing ? '暂停' : '播放选段'}</button>
          <button aria-label="上一帧" disabled={blocked || !compatible || !previewAvailable || !frame} onClick={() => void step(-1)}>◀ 帧</button>
          <button aria-label="下一帧" disabled={blocked || !compatible || !previewAvailable || !frame} onClick={() => void step(1)}>帧 ▶</button>
          <output data-testid="playhead">{formatTime(position)}</output></div>
        <div className="button-row crop-controls"><button aria-pressed={locked} disabled={blocked || copyMode} onClick={() => { setLocked(true); setCrop(fullCrop); }}>原比例</button>
          <button aria-pressed={!locked} disabled={blocked || copyMode} onClick={() => setLocked(false)}>自由框选</button><button disabled={blocked || copyMode} onClick={() => setCrop(fullCrop)}>重置画面</button>
          <span data-testid="crop-pixels">{pixels.width} × {pixels.height} · x {pixels.x} / y {pixels.y}</span></div>
      </div>
      <aside className="editor-sidebar" aria-label="片段属性">
        <div className="panel inspector-card" data-testid="clip-inspector">
        <section className="inspector-cover"><div className="inspector-heading"><h3>封面</h3><span className="inspector-clip" data-testid="inspector-clip">片段 {String(activeClip.number).padStart(2, '0')}</span></div>
          <div className="cover-preview" data-testid="inspector-cover-stage" style={{ aspectRatio: `${pixels.width} / ${pixels.height}`, width: `min(100%, ${200 * pixels.width / pixels.height}px)`, background: background }}>
            {cover ? <img data-testid="cover-preview" src={cover.url} alt={cover.name} style={cover.kind === 'custom' ? { width: '100%', height: '100%', objectFit: coverFit }
              : { position: 'absolute', width: `${100 / visibleCrop.width}%`, height: `${100 / visibleCrop.height}%`, maxWidth: 'none', left: `${-visibleCrop.x / visibleCrop.width * 100}%`, top: `${-visibleCrop.y / visibleCrop.height * 100}%` }} /> : <div className="cover-placeholder"><svg viewBox="0 0 32 32" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="5" y="4" width="22" height="24" rx="3"/><circle cx="20" cy="11" r="2"/><path d="m5 23 7-8 5 5 3-3 7 6"/></svg><strong>自动首帧</strong><span>使用选段起点的画面</span></div>}
          </div>
          <div className="button-row"><button data-testid="capture-cover" disabled={blocked || !compatible || !previewAvailable || !frame} onClick={() => void capture()}>使用当前帧</button><button data-testid="upload-cover" disabled={blocked} onClick={() => void upload()}>上传 JPG / PNG</button></div>
          {cover && <button className="cover-reset" disabled={blocked} onClick={() => void automaticCover()}>恢复自动首帧封面</button>}
          {cover?.timeUs !== null && cover?.timeUs !== undefined && (cover.timeUs < clip.startUs || cover.timeUs >= clip.endUs) && <p className="hint">手选封面位于本段范围外，将作为独立封面保留。</p>}
          {cover && <p className="hint cover-description" title={cover.name} data-testid="cover-description">{cover.name}{cover.timeUs !== null ? ` · ${formatTime(cover.timeUs)}` : ' · 独立封面'}</p>}
          {cover?.kind === 'custom' && <div className="inspector-cover-options"><label className="field">封面适配<select aria-label="封面适配" disabled={blocked} value={coverFit} onChange={e => setCoverFit(e.target.value as 'cover' | 'contain')}><option value="cover">居中裁切，不拉伸</option><option value="contain">完整保留，留边</option></select></label>
            <label className="field background-choice" title="透明区域与留边的背景颜色">背景<input aria-label="封面背景" type="color" value={background} disabled={blocked} onChange={e => setBackground(e.target.value)} /></label></div>}
        </section>
        <section className="inspector-selection" aria-label="当前选段信息">
          <dl><div><dt>选段时长</dt><dd data-testid="inspector-duration">{((clip.endUs - clip.startUs) / 1e6).toFixed(2)}<small> 秒</small></dd></div><div><dt>画面尺寸</dt><dd data-testid="inspector-dimensions">{pixels.width} × {pixels.height}</dd></div></dl>
          <div className="inspector-jump"><button data-testid="jump-clip-start" disabled={blocked || !compatible || !previewAvailable} onClick={() => exactSeek(clip.startUs)}><span aria-hidden="true">↤</span> 定位入点</button>
            <button data-testid="jump-clip-end" disabled={blocked || !compatible || !previewAvailable} onClick={() => interact({ kind: 'end', phase: 'keyboard', timeUs: clip.endUs })}>定位出点 <span aria-hidden="true">↦</span></button></div>
          <div className="inspector-trim"><button data-testid="set-clip-start" title="将播放头位置设为当前片段入点" disabled={blocked || !previewAvailable || !frame || position >= clip.endUs} onClick={() => trimAtPlayhead('start')}>设为入点</button>
            <button data-testid="set-clip-end" title="将播放头位置设为当前片段出点（不含该时刻）" disabled={blocked || !previewAvailable || !frame || position <= clip.startUs} onClick={() => trimAtPlayhead('end')}>设为出点</button></div>
        </section>
        <section className="inspector-aspect" aria-label="画面比例"><div className="inspector-heading"><h3>画面比例</h3><span>居中裁剪</span></div>
          <div className="aspect-presets">{([{ label: '原比例', ratio: null }, { label: '1:1', ratio: 1 }, { label: '4:5', ratio: 4 / 5 }, { label: '9:16', ratio: 9 / 16 }, { label: '16:9', ratio: 16 / 9 }] as const).map(item => {
            const preset = item.ratio === null ? fullCrop : centeredAspectCrop(asset.info.displayWidth, asset.info.displayHeight, item.ratio);
            const selected = item.ratio === null ? (copyMode || locked && activeClip.crop.width === 1 && activeClip.crop.height === 1)
              : !copyMode && !locked && (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(activeClip.crop[key] - preset[key]) < 1e-8);
            return <button key={item.label} aria-label={`裁剪比例 ${item.label}`} aria-pressed={selected} disabled={blocked || copyMode} onClick={() => applyAspect(item.ratio)}>{item.label}</button>;
          })}</div>
          {copyMode && <p className="hint">原画质模式使用完整画面</p>}
        </section>
        <details className="inspector-batch" data-testid="batch-clip-tools"><summary><span>批量操作 · {clips.length} 段</span><span data-testid="total-clip-duration" title="各选段时长之和；重叠部分按各段分别计入">合计 {clips.reduce((sum, item) => sum + (item.selection.endUs - item.selection.startUs) / 1e6, 0).toFixed(2)} 秒</span></summary>
          <div className="batch-clip-actions">
            <label className="field batch-duration-field">目标时长<div className="batch-duration-value"><input aria-label="统一片段时长（秒）" aria-describedby="batch-duration-help" aria-invalid={batchDurationUs === null} inputMode="decimal" maxLength={32} disabled={blocked} value={batchDuration} onChange={e => setBatchDuration(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); uniformDuration(); } }} /><span>秒</span></div></label>
            <p className={`hint${batchDurationUs === null ? ' batch-duration-invalid' : ''}`} id="batch-duration-help">{batchDurationUs === null ? '请输入大于 0 的秒数，最多 3 位小数。' : '固定每段入点；片尾不足目标时长则保留剩余部分。'}</p>
            <button data-testid="apply-all-clips-duration" disabled={blocked || batchDurationUs === null} onClick={uniformDuration}>应用到全部片段</button>
            <button data-testid="sync-all-crops" disabled={blocked || copyMode || clips.length < 2} onClick={syncCurrentCrop}>同步当前裁剪到全部</button></div>
        </details>
        </div>
      </aside>
    </div>
    <section className="timeline-panel panel" aria-label="片段剪辑">
      <div className="timeline-head"><div className="button-row"><strong>片段 {activeClip.number} / 共 {clips.length} 段</strong><button data-testid="add-clip" disabled={opening || Boolean(busy) || diagnosticsBusy || clips.length >= MAX_CLIPS} onClick={addClip}>＋ 添加片段</button><span data-testid="clip-duration">选段 {formatTime(clip.endUs - clip.startUs)}</span></div>
        <div className="button-row"><button disabled={blocked} onClick={() => { pause(); setZoom(0); setViewStart(0); changeClip({ startUs: 0, endUs: duration }); }}>全选片段</button>
          <label className="zoom-control">−<input aria-label="时间轴缩放" type="range" min="0" max={maxZoom} step="1" value={zoom} disabled={blocked} onChange={e => {
            const next = Number(e.target.value); const width = Math.max(minSpan, Math.round(duration / 2 ** next));
            setZoom(next); setViewStart(Math.max(0, Math.min(duration - width, position - width / 2)));
          }} />＋</label></div></div>
      <div className="clip-tabs" aria-label="切换片段（重叠选区可用编号选择）">{clips.map(item => <div key={item.id} className={`clip-tab ${item.id === activeClipId ? 'is-active' : ''}`}>
        <button aria-pressed={item.id === activeClipId} disabled={opening || Boolean(busy) || diagnosticsBusy}
          title={`${formatTime(item.selection.startUs)} — ${formatTime(item.selection.endUs)} · ${formatTime(item.selection.endUs - item.selection.startUs)}`}
          aria-label={`片段 ${String(item.number).padStart(2, '0')}`} onClick={() => activateClip(item.id)}>片段 {String(item.number).padStart(2, '0')}<span className="clip-length" aria-hidden="true">{((item.selection.endUs - item.selection.startUs) / 1e6).toFixed(2)}s</span></button>
        <button aria-label={`删除片段 ${item.number}`} disabled={clips.length === 1 || opening || Boolean(busy) || diagnosticsBusy} onClick={() => deleteClip(item.id)}>×</button>
      </div>)}</div>
      <Timeline key={asset.id} durationUs={duration} startUs={start} endUs={end} clips={clips} activeClipId={activeClipId} positionUs={position} thumbnails={thumbs}
        disabled={opening || Boolean(busy) || diagnosticsBusy} loading={thumbBusy} onActivate={activateClip} onSelect={changeClip} onInteraction={interact} />
      {span < duration && <label className="viewport-scroll">平移<input aria-label="时间轴视口起点" type="range" min="0" max={duration - span} step="1000" value={start} disabled={blocked} onChange={e => setViewStart(Number(e.target.value))} /></label>}
      <div className="timeline-bottom"><div className="time-fields"><TimeField label="截取开始" value={clip.startUs} disabled={blocked} change={value => { const next = validateClip({ ...clip, startUs: value }, duration); changeClip(next); interact({ kind: 'start', phase: 'keyboard', timeUs: next.startUs }); }} error={setError} />
        <TimeField label="截取结束" value={clip.endUs} disabled={blocked} change={value => { const next = validateClip({ ...clip, endUs: value }, duration); changeClip(next); interact({ kind: 'end', phase: 'keyboard', timeUs: next.endUs }); }} error={setError} />
        <TimeField label="精确定位" value={position} disabled={blocked || !compatible || !previewAvailable} change={exactSeek} error={setError} /></div>
        <span className="timeline-tip">同一时间轴上拖动各组选区 · 重叠时按编号切换</span></div>
    </section>
    {!outputOpen && (busy || notice || error) && <div className="editor-status" aria-live="polite">
      {busy && <p>{busy} <button onClick={() => void cancel()}>取消处理</button></p>}
      {notice && <p className="hint">{notice}</p>}{error && <p role="alert" className="error">{error}</p>}
    </div>}
    <dialog ref={draftDialog} className="draft-dialog export-dialog" aria-labelledby="export-title"
      onCancel={e => { e.preventDefault(); closeExport(); }}
      onClose={() => { if (outputOpen && !draftDialog.current?.open) closeExport(); }}>
      <header className="export-header"><div><span className="eyebrow">MOTION PHOTO</span><h2 id="export-title">导出实况照片</h2><p title={asset.name}>{asset.name}</p></div>
        <button className="close-export" aria-label="关闭导出" disabled={blocked} onClick={closeExport}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6L18 18M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg></button></header>
      <div className="export-body">
        <section className="export-content">
          <div className="export-scope" role="group" aria-label="导出范围">
            <button aria-pressed={exportScope === 'current'} disabled={blocked} onClick={() => { pause(false); setExportScope('current'); setBatchResult(null); }}>当前片段</button>
            <button aria-pressed={exportScope === 'all'} disabled={blocked} onClick={() => { pause(false); setExportScope('all'); setBatchResult(null); }}>全部片段（{clips.length}）</button>
          </div>
          {batchResult ? <section className="export-results" data-testid="batch-result" aria-live="polite">
            <h3>{batchResult.stopped ? '导出已停止' : batchResult.canceled ? '已取消导出' : batchResult.results.some(item => item.status === 'failed') ? '部分导出完成' : '导出完成'}</h3>
            <div className="result-counts"><span>已保存 <b>{batchResult.saved.length}</b></span><span>失败 <b>{batchResult.results.filter(item => item.status === 'failed').length}</b></span><span>未完成 <b>{batchResult.results.filter(item => item.status === 'skipped' || item.status === 'cancelled').length}</b></span></div>
            {batchResult.stopReason && <p className="error">{batchResult.stopReason}</p>}
            <ul className="export-result-list">{batchResult.results.map(item => <li key={item.clipId} data-status={item.status}><button className="export-result-select" data-preview-select aria-label={`预览片段 ${item.number}`} aria-pressed={exportPreviewClip.id === item.clipId} disabled={blocked} onClick={() => selectExportPreview(item.clipId)}>
              <span className="result-icon" aria-hidden="true">{item.saved ? '✓' : item.status === 'failed' ? '!' : '—'}</span>
              <div><strong>{item.saved?.name ?? `片段 ${String(item.number).padStart(2, '0')}`}</strong>
                {!item.saved && <p>{item.error?.message ?? (item.status === 'cancelled' ? '已取消' : '未执行')}</p>}
              </div></button></li>)}</ul>
          </section> : <div className="export-queue">
            <div className="export-list-heading"><h3>{exportClips.length} 个实况照片</h3><span>每段独立保存</span></div>
            <ol>{exportClips.map(item => <li key={item.id}><button className="export-preview-select" data-preview-select data-clip-id={item.id} aria-pressed={exportPreviewClip.id === item.id} aria-label={`预览片段 ${item.number}`} disabled={blocked} onClick={() => selectExportPreview(item.id)}><span className="export-clip-number">{String(item.number).padStart(2, '0')}</span>
              <div className="export-clip-info"><strong>片段 {String(item.number).padStart(2, '0')}</strong><span>{formatTime(item.selection.startUs)} — {formatTime(item.selection.endUs)}</span></div>
              <div className="export-clip-meta"><strong>{((item.selection.endUs - item.selection.startUs) / 1e6).toFixed(2)} 秒</strong><span>{item.cover?.kind === 'custom' ? '自定义封面' : item.cover ? '已选封面' : '自动封面'}</span></div>
            </button></li>)}</ol>
          </div>}
          <section className="export-live-preview" aria-label="选段预览" data-testid="export-live-preview" data-clip-id={exportPreviewClip.id}>
            <div className="export-live-heading"><h3>片段 {String(exportPreviewClip.number).padStart(2, '0')}</h3><span>片段预览</span></div>
            <div className="export-live-media">
              <CropStage testId="export-preview-stage" width={exportPixels.width} height={exportPixels.height} crop={fullCrop} locked disabled showOverlay={false} onChange={() => {}} onEdit={() => {}}>
                <div className="export-source-crop" style={{ width: `${100 / exportCrop.width}%`, height: `${100 / exportCrop.height}%`, left: `${-exportCrop.x / exportCrop.width * 100}%`, top: `${-exportCrop.y / exportCrop.height * 100}%` }}>
                  {outputOpen && <PreviewSurface key={asset.id} ref={surface} controller={controller} enabled={previewAvailable && compatible} />}
                </div>
                {(!frame || !previewAvailable) && <div className="preview-buffering" role="status">{audioChoicePending ? '请选择音轨或关闭声音' : nativePreparing ? '正在准备预览…' : '正在读取画面…'}</div>}
              </CropStage>
              <div className="export-live-cover"><h4>封面</h4>
                <div className="export-cover-image" style={{ aspectRatio: `${exportPixels.width} / ${exportPixels.height}`, width: `min(100%, ${154 * exportPixels.width / exportPixels.height}px)`, background: exportPreviewClip.background }}>
                  {exportCoverUrl ? <img data-testid="export-cover-preview" src={exportCoverUrl} alt="所选片段封面"
                    style={previewCover?.kind === 'custom' ? { width: '100%', height: '100%', objectFit: exportPreviewClip.coverFit }
                    : { position: 'absolute', width: `${100 / exportCrop.width}%`, height: `${100 / exportCrop.height}%`, maxWidth: 'none', left: `${-exportCrop.x / exportCrop.width * 100}%`, top: `${-exportCrop.y / exportCrop.height * 100}%` }} /> : <span>读取中</span>}
                </div><span>{previewCover?.kind === 'custom' ? '自定义封面' : previewCover ? '已选封面' : '自动首帧'}</span>
              </div>
            </div>
            <div className="export-live-transport">
              <button data-testid="export-play" data-playback-control title="空格：播放 / 暂停" disabled={blocked || !previewAvailable || !compatible || !frame} onClick={togglePlayback}>{playing ? '暂停' : '播放'}</button>
              <input type="range" aria-label="片段预览进度" min={exportPreviewClip.selection.startUs} max={exportPreviewClip.selection.endUs} step={1000}
                value={Math.max(exportPreviewClip.selection.startUs, Math.min(exportPreviewClip.selection.endUs, position))} disabled={blocked || !previewAvailable}
                onChange={event => seekExportPreview(Number(event.target.value))} />
              <output data-testid="export-preview-time">{formatTime(Math.max(0, position - exportPreviewClip.selection.startUs))} / {formatTime(exportPreviewClip.selection.endUs - exportPreviewClip.selection.startUs)}</output>
            </div>
          </section>
        </section>
        <aside className="export-settings">{outputSettings}</aside>
      </div>
      <footer className="export-footer">
        {busy && <div className="export-progress" aria-live="polite"><progress aria-label="导出进度" /><span data-testid="export-status" role="status">{busy}</span><button data-testid="cancel-export" onClick={() => void cancel()}>取消处理</button></div>}
        {error && <div className="export-failure" role="alert"><strong>未能完成导出</strong><p>{error}</p></div>}
        {notice && !busy && !batchResult && <p className="hint" role="status">{notice}</p>}
        <div className="export-footer-actions"><span className="hint">JPG 实况照片 · 同名自动编号，不覆盖</span><div className="button-row">
          <button disabled={blocked} onClick={closeExport}>{batchResult ? '完成' : '返回编辑'}</button>
          <button data-testid="confirm-export-all" className="primary-button" disabled={blocked || !savingReady || !compatible || !chosenAudio} onClick={() => void exportAll()}>{batchResult ? '再次导出' : `选择文件夹并导出 ${exportClips.length} 张`}</button>
        </div></div>
      </footer>
    </dialog>
  </section>;
}
