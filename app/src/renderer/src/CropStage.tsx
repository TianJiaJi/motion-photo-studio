import { useEffect, useRef, useState } from 'react';
import type { ReactNode, PointerEvent } from 'react';
import type { CropRect } from '../../shared/editor.ts';

type Point = { x: number; y: number };
export function CropStage({ width, height, crop, locked, disabled = false, showOverlay = true, onChange, onEdit, children }: {
  width: number; height: number; crop: CropRect; locked: boolean; disabled?: boolean; showOverlay?: boolean;
  onChange(value: CropRect): void; onEdit(): void; children: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null); const stage = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState({ width: 600, height: 360 });
  const drag = useRef<{ kind: 'draw' | 'move'; anchor: Point; initial: CropRect } | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0]!.contentRect;
      setAvailable({ width: Math.max(1, width), height: Math.max(1, height) });
    });
    observer.observe(host.current); return () => observer.disconnect();
  }, []);
  const scale = Math.min(available.width / width, available.height / height);
  const point = (event: PointerEvent): Point => {
    const box = stage.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) };
  };
  function start(event: PointerEvent, kind: 'draw' | 'move', anchor?: Point) {
    if (disabled || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); onEdit();
    stage.current!.setPointerCapture(event.pointerId);
    const p = point(event);
    drag.current = { kind, initial: crop, anchor: anchor ?? (kind === 'draw'
      ? { x: Math.min(p.x, 1 - 2 / width), y: Math.min(p.y, 1 - 2 / height) } : p) };
  }
  function move(event: PointerEvent) {
    const d = drag.current; if (!d || disabled) return;
    const p = point(event);
    if (d.kind === 'move') {
      onChange({ ...d.initial, x: Math.max(0, Math.min(1 - d.initial.width, d.initial.x + p.x - d.anchor.x)),
        y: Math.max(0, Math.min(1 - d.initial.height, d.initial.y + p.y - d.anchor.y)) }); return;
    }
    const dx = p.x - d.anchor.x; const dy = p.y - d.anchor.y;
    let w = Math.abs(dx); let h = Math.abs(dy);
    if (locked) w = h = Math.min(Math.max(w, h), dx < 0 ? d.anchor.x : 1 - d.anchor.x, dy < 0 ? d.anchor.y : 1 - d.anchor.y);
    if (w < 2 / width || h < 2 / height) return;
    onChange({ x: dx < 0 ? d.anchor.x - w : d.anchor.x, y: dy < 0 ? d.anchor.y - h : d.anchor.y, width: w, height: h });
  }
  return <div ref={host} className="stage-host">
    <div ref={stage} data-testid="crop-stage" className="crop-stage" style={{ width: width * scale, height: height * scale }}
      onPointerDown={e => start(e, 'draw')} onPointerMove={move}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      {children}
      {showOverlay && <div data-testid="crop-box" className="crop-box" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }} onPointerDown={e => start(e, crop.width > .999999 && crop.height > .999999 ? 'draw' : 'move')}>
        {(['nw', 'ne', 'sw', 'se'] as const).map(corner => <span key={corner} className={`crop-handle ${corner}`} aria-hidden="true"
          onPointerDown={e => start(e, 'draw', { x: corner.endsWith('w') ? crop.x + crop.width : crop.x, y: corner.startsWith('n') ? crop.y + crop.height : crop.y })} />)}
      </div>}
    </div>
  </div>;
}
