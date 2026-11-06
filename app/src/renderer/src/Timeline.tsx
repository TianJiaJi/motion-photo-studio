import { useRef } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import type { ClipModel, ClipSelection } from '../../shared/editor.ts';
import { formatTime } from '../../shared/editor.ts';
import type { Thumbnail } from '../../shared/media.ts';
import { timelineTime, trimKeyValue, trimSelection, type TrimEdge } from '../../shared/timeline.ts';

export type TimelineInteraction = { kind: TrimEdge | 'playhead'; phase: 'begin' | 'update' | 'end' | 'cancel' | 'keyboard'; timeUs: number };
type TimelineClip = Pick<ClipModel, 'id' | 'number' | 'revision' | 'selection'>;
type Props = {
  durationUs: number; startUs: number; endUs: number; clips: readonly TimelineClip[]; activeClipId: string; positionUs: number;
  thumbnails: Thumbnail[]; disabled: boolean; loading: boolean;
  onActivate(id: string): void;
  onSelect(value: ClipSelection, id: string): void; onInteraction(value: TimelineInteraction): void;
};
type Drag = { pointer: number; clipId: string; kind: TrimEdge | 'playhead'; initial: ClipSelection; position: number; anchor: number };
export function Timeline(props: Props) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const latest = useRef(props); latest.current = props;
  const span = props.endUs - props.startUs;
  const percent = (us: number) => Math.max(0, Math.min(100, (us - props.startUs) / span * 100));
  const visible = (us: number) => us >= props.startUs && us <= props.endUs;
  const activeClip = props.clips.find(clip => clip.id === props.activeClipId)!;
  function timeAt(event: PointerEvent): number {
    const rect = track.current!.getBoundingClientRect(); const p = latest.current;
    return timelineTime(event.clientX, rect.left, rect.width, p.startUs, p.endUs);
  }
  function apply(event: PointerEvent) {
    const d = drag.current; if (!d || d.pointer !== event.pointerId) return;
    event.stopPropagation();
    const p = latest.current;
    if (p.disabled || !p.clips.some(clip => clip.id === d.clipId)) return;
    const value = timeAt(event);
    if (d.kind === 'playhead') d.position = value;
    else {
      const initial = d.kind === 'start' ? d.initial.startUs : d.initial.endUs;
      const selection = trimSelection(d.initial, d.kind, initial + value - d.anchor, p.durationUs);
      d.position = d.kind === 'start' ? selection.startUs : selection.endUs;
      // Retain the grabbed identity across activation/re-renders; never trim a different clip.
      p.onSelect(selection, d.clipId);
    }
    p.onInteraction({ kind: d.kind, phase: 'update', timeUs: d.position });
  }
  function begin(event: PointerEvent, kind: Drag['kind'], item = activeClip) {
    if (props.disabled || event.button !== 0 || !item) return;
    event.preventDefault(); event.stopPropagation(); props.onActivate(item.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget instanceof HTMLElement && event.currentTarget.focus();
    const position = kind === 'playhead' ? timeAt(event) : kind === 'start' ? item.selection.startUs : item.selection.endUs;
    drag.current = { pointer: event.pointerId, clipId: item.id, kind, initial: { ...item.selection }, position, anchor: timeAt(event) };
    // Grabbing a wide handle does not shift the edge until it actually moves.
    props.onInteraction({ kind, phase: 'begin', timeUs: position });
  }
  function finish(event: PointerEvent, cancelled = false) {
    const d = drag.current; if (!d || event.pointerId !== d.pointer) return;
    if (!cancelled) apply(event);
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    latest.current.onInteraction({ kind: d.kind, phase: cancelled || latest.current.disabled ? 'cancel' : 'end', timeUs: d.position });
  }
  function keyboard(event: KeyboardEvent, kind: Drag['kind'], item = activeClip) {
    if (props.disabled || !item) return;
    const minGap = Math.min(1000, props.durationUs);
    const value = kind === 'playhead' ? props.positionUs : kind === 'start' ? item.selection.startUs : item.selection.endUs;
    const min = kind === 'end' ? item.selection.startUs + minGap : kind === 'playhead' ? props.startUs : 0;
    const max = kind === 'start' ? item.selection.endUs - minGap : kind === 'playhead' ? props.endUs : props.durationUs;
    const next = trimKeyValue(event.key, value, min, max, event.shiftKey);
    if (next === null) return;
    event.preventDefault(); props.onActivate(item.id);
    let at = next;
    if (kind !== 'playhead') {
      const selection = trimSelection(item.selection, kind, next, props.durationUs);
      props.onSelect(selection, item.id); at = kind === 'start' ? selection.startUs : selection.endUs;
    }
    props.onInteraction({ kind, phase: 'keyboard', timeUs: at });
  }
  const interactions = { onPointerMove: apply, onPointerUp: (e: PointerEvent) => finish(e),
    onPointerCancel: (e: PointerEvent) => finish(e, true), onLostPointerCapture: () => {
      const d = drag.current; drag.current = null;
      if (d) latest.current.onInteraction({ kind: d.kind, phase: 'cancel', timeUs: d.position });
    } };
  return <div className={`trim-timeline ${props.disabled ? 'is-disabled' : ''}`} data-testid="trim-timeline">
    <div className="time-ticks" aria-hidden="true">{Array.from({ length: 5 }, (_, i) => <span key={i}>{formatTime(Math.round(props.startUs + span * i / 4))}</span>)}</div>
    <div ref={track} className="timeline-track" data-testid="timeline" onPointerDown={e => begin(e, 'playhead')} {...interactions}>
      <div className="thumbnails" aria-hidden="true">{props.thumbnails.map((thumb, i) => <img key={`${thumb.url}:${i}`} src={thumb.url} alt="" draggable={false} />)}</div>
      {props.loading && props.thumbnails.length === 0 && <div className="timeline-loading">正在读取画面…</div>}
      {props.clips.length === 1 && <><div className="trim-dim trim-dim-left" style={{ width: `${percent(activeClip.selection.startUs)}%` }} />
        <div className="trim-dim trim-dim-right" style={{ left: `${percent(activeClip.selection.endUs)}%`, width: `${100 - percent(activeClip.selection.endUs)}%` }} /></>}
      {props.clips.map(item => {
        const active = item.id === props.activeClipId;
        const left = percent(item.selection.startUs), right = percent(item.selection.endUs);
        return <div key={item.id} className={`clip-range ${active ? 'is-active' : ''}`} data-testid="clip-range" data-clip-id={item.id} data-revision={item.revision}
          role="group" aria-label={`片段 ${item.number} 范围`} style={{ '--clip-color': ['#8bcec1', '#e6b76c', '#99b7ef', '#d89ecb', '#bdd285'][(item.number - 1) % 5] } as CSSProperties}>
          {right > left && <button type="button" className="selection-band" aria-label={`选择片段 ${item.number}`} aria-pressed={active}
            title={`片段 ${item.number} · ${formatTime(item.selection.startUs)} — ${formatTime(item.selection.endUs)}`}
            disabled={props.disabled} style={{ left: `${left}%`, width: `${right - left}%` }}
            onClick={() => props.onActivate(item.id)} onPointerDown={e => begin(e, 'playhead', item)} {...interactions}>
            <span className="range-number">{String(item.number).padStart(2, '0')}</span>
          </button>}
          {(['start', 'end'] as const).map(edge => {
            const value = edge === 'start' ? item.selection.startUs : item.selection.endUs;
            if (!visible(value)) return null;
            return <button key={edge} type="button" role="slider" aria-label={`片段 ${item.number} ${edge === 'start' ? '入点' : '出点'}`}
              aria-orientation="horizontal" aria-valuemin={edge === 'start' ? 0 : item.selection.startUs + Math.min(1000, props.durationUs)}
              aria-valuemax={edge === 'start' ? item.selection.endUs - Math.min(1000, props.durationUs) : props.durationUs}
              aria-valuenow={value} aria-valuetext={formatTime(value)} disabled={props.disabled}
              data-testid={active ? `trim-${edge}` : undefined} className={`trim-handle trim-${edge}`} style={{ left: `${percent(value)}%` }}
              onPointerDown={e => begin(e, edge, item)} onKeyDown={e => keyboard(e, edge, item)} {...interactions}>
              <span aria-hidden="true" /><span className="trim-tooltip">片段 {item.number} · {formatTime(value)}</span>
            </button>;
          })}
        </div>;
      })}
      {visible(props.positionUs) && <button type="button" role="slider" aria-label="播放位置" aria-orientation="horizontal"
        aria-valuemin={props.startUs} aria-valuemax={props.endUs} aria-valuenow={props.positionUs} aria-valuetext={formatTime(props.positionUs)}
        disabled={props.disabled} className="timeline-playhead" data-testid="timeline-playhead" style={{ left: `${percent(props.positionUs)}%` }}
        onPointerDown={e => begin(e, 'playhead')} onKeyDown={e => keyboard(e, 'playhead')} {...interactions}><span aria-hidden="true" /></button>}
    </div>
  </div>;
}
