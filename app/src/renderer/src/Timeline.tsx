import { useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { ClipSelection } from '../../shared/editor.ts';
import { formatTime } from '../../shared/editor.ts';
import type { Thumbnail } from '../../shared/media.ts';
import { timelineTime, trimKeyValue, trimSelection, type TrimEdge } from '../../shared/timeline.ts';

export type TimelineInteraction = { kind: TrimEdge | 'playhead'; phase: 'begin' | 'update' | 'end' | 'cancel' | 'keyboard'; timeUs: number };
type Props = {
  durationUs: number; startUs: number; endUs: number; selection: ClipSelection; positionUs: number;
  thumbnails: Thumbnail[]; disabled: boolean; loading: boolean;
  onSelect(value: ClipSelection): void; onInteraction(value: TimelineInteraction): void;
};
type Drag = { pointer: number; kind: TrimEdge | 'playhead'; initial: ClipSelection; position: number; anchor: number };
export function Timeline(props: Props) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const latest = useRef(props); latest.current = props;
  const span = props.endUs - props.startUs;
  const percent = (us: number) => Math.max(0, Math.min(100, (us - props.startUs) / span * 100));
  const left = percent(props.selection.startUs); const right = percent(props.selection.endUs);
  const visible = (us: number) => us >= props.startUs && us <= props.endUs;
  function timeAt(event: PointerEvent): number {
    const rect = track.current!.getBoundingClientRect(); const p = latest.current;
    return timelineTime(event.clientX, rect.left, rect.width, p.startUs, p.endUs);
  }
  function apply(event: PointerEvent) {
    const d = drag.current; if (!d || d.pointer !== event.pointerId) return;
    event.stopPropagation();
    const p = latest.current;
    if (p.disabled) return;
    const value = timeAt(event);
    if (d.kind === 'playhead') d.position = value;
    else {
      const initial = d.kind === 'start' ? d.initial.startUs : d.initial.endUs;
      const selection = trimSelection(d.initial, d.kind, initial + value - d.anchor, p.durationUs);
      d.position = d.kind === 'start' ? selection.startUs : selection.endUs;
      p.onSelect(selection);
    }
    p.onInteraction({ kind: d.kind, phase: 'update', timeUs: d.position });
  }
  function begin(event: PointerEvent, kind: Drag['kind']) {
    if (props.disabled || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget instanceof HTMLElement && event.currentTarget.focus();
    const position = kind === 'playhead' ? timeAt(event) : kind === 'start' ? props.selection.startUs : props.selection.endUs;
    drag.current = { pointer: event.pointerId, kind, initial: { ...props.selection }, position, anchor: timeAt(event) };
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
  function keyboard(event: KeyboardEvent, kind: Drag['kind']) {
    if (props.disabled) return;
    const minGap = Math.min(1000, props.durationUs);
    const value = kind === 'playhead' ? props.positionUs : kind === 'start' ? props.selection.startUs : props.selection.endUs;
    const min = kind === 'end' ? props.selection.startUs + minGap : kind === 'playhead' ? props.startUs : 0;
    const max = kind === 'start' ? props.selection.endUs - minGap : kind === 'playhead' ? props.endUs : props.durationUs;
    const next = trimKeyValue(event.key, value, min, max, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    let at = next;
    if (kind !== 'playhead') {
      const selection = trimSelection(props.selection, kind, next, props.durationUs);
      props.onSelect(selection); at = kind === 'start' ? selection.startUs : selection.endUs;
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
      <div className="trim-dim trim-dim-left" style={{ width: `${left}%` }} />
      <div className="trim-dim trim-dim-right" style={{ left: `${right}%`, width: `${100 - right}%` }} />
      <div className="selection-band" style={{ left: `${left}%`, width: `${Math.max(0, right - left)}%` }} />
      {(['start', 'end'] as const).map(edge => {
        const value = edge === 'start' ? props.selection.startUs : props.selection.endUs;
        if (!visible(value)) return null;
        return <button key={edge} type="button" role="slider" aria-label={edge === 'start' ? '片段入点' : '片段出点'}
          aria-orientation="horizontal" aria-valuemin={edge === 'start' ? 0 : props.selection.startUs + Math.min(1000, props.durationUs)}
          aria-valuemax={edge === 'start' ? props.selection.endUs - Math.min(1000, props.durationUs) : props.durationUs}
          aria-valuenow={value} aria-valuetext={formatTime(value)} disabled={props.disabled}
          data-testid={`trim-${edge}`} className={`trim-handle trim-${edge}`} style={{ left: `${percent(value)}%` }}
          onPointerDown={e => begin(e, edge)} onKeyDown={e => keyboard(e, edge)} {...interactions}>
          <span aria-hidden="true" /><span className="trim-tooltip">{formatTime(value)}</span>
        </button>;
      })}
      {visible(props.positionUs) && <button type="button" role="slider" aria-label="播放位置" aria-orientation="horizontal"
        aria-valuemin={props.startUs} aria-valuemax={props.endUs} aria-valuenow={props.positionUs} aria-valuetext={formatTime(props.positionUs)}
        disabled={props.disabled} className="timeline-playhead" data-testid="timeline-playhead" style={{ left: `${percent(props.positionUs)}%` }}
        onPointerDown={e => begin(e, 'playhead')} onKeyDown={e => keyboard(e, 'playhead')} {...interactions}><span aria-hidden="true" /></button>}
    </div>
  </div>;
}
