import { useRef, useCallback } from 'react';

interface Props {
  value: number;        // current gain
  max?: number;         // top of the fader's range (default 1.5)
  unity?: number;       // mark "0 dB" line at this value (default 1.0)
  onChange: (v: number) => void;
  label?: string;
}

const STEP = 0.01;

export function Fader({ value, max = 1.5, unity = 1.0, onChange, label }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const fromClient = useCallback((clientY: number) => {
    const el = ref.current;
    if (!el) return value;
    const rect = el.getBoundingClientRect();
    const inner = 12; // matches CSS padding above/below the track
    const usableTop = rect.top + inner;
    const usableHeight = rect.height - inner * 2;
    const t = 1 - (clientY - usableTop) / usableHeight; // 0 at bottom, 1 at top
    const clamped = Math.max(0, Math.min(1, t));
    return Math.round((clamped * max) / STEP) * STEP;
  }, [value, max]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    e.preventDefault();
    e.stopPropagation();
    onChange(fromClient(e.clientY));
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    onChange(fromClient(e.clientY));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(unity);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    let delta = 0;
    if (e.key === 'ArrowUp') delta = e.shiftKey ? 0.1 : STEP;
    else if (e.key === 'ArrowDown') delta = e.shiftKey ? -0.1 : -STEP;
    else if (e.key === 'Home') { onChange(0); e.preventDefault(); return; }
    else if (e.key === 'End') { onChange(max); e.preventDefault(); return; }
    if (delta !== 0) {
      onChange(Math.max(0, Math.min(max, value + delta)));
      e.preventDefault();
    }
  };

  const fillPct = (value / max) * 100;
  const thumbPct = 100 - fillPct; // measured from top
  const unityPct = 100 - (unity / max) * 100;
  const dbLabel = value > 0
    ? `${(20 * Math.log10(value)).toFixed(1)} dB`
    : '−∞';

  return (
    <div
      className="fader"
      ref={ref}
      tabIndex={0}
      role="slider"
      aria-label={label ?? 'volume'}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="fader-track">
        <div className="fader-fill" style={{ height: `${fillPct}%` }} />
        <div className="fader-unity" style={{ top: `${unityPct}%` }} />
      </div>
      <div className="fader-thumb" style={{ top: `${thumbPct}%` }}>
        <span className="fader-thumb-grip" />
      </div>
      <div className="fader-readout">{dbLabel}</div>
    </div>
  );
}
