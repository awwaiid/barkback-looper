import { useRef } from 'react';
import { useSettingsStore, updateSettings } from '../settings/settings.ts';
import { useAudioStore } from '../audio/store.ts';

const BPM_MIN = 40;
const BPM_MAX = 300;

export function TempoBar() {
  const bpm = useSettingsStore(s => s.bpm);
  const beatsPerMeasure = useSettingsStore(s => s.beatsPerMeasure);
  const metronomeOn = useSettingsStore(s => s.metronomeOn);
  const metronomeLevel = useSettingsStore(s => s.metronomeLevel);
  const fixedLoopMeasures = useSettingsStore(s => s.fixedLoopMeasures);
  const beatInMeasure = useAudioStore(s => s.beatInMeasure);
  const beatProgress = useAudioStore(s => s.beatProgress);
  const countInMs = useAudioStore(s => s.countInRemainingMs);
  const ready = useAudioStore(s => s.ready);

  const tapsRef = useRef<number[]>([]);

  const setBpm = (next: number) => {
    const clamped = Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(next)));
    if (clamped !== bpm) updateSettings({ bpm: clamped });
  };

  const tap = () => {
    const now = performance.now();
    const taps = tapsRef.current.filter(t => now - t < 3000);
    taps.push(now);
    tapsRef.current = taps;
    if (taps.length >= 2) {
      const diffs: number[] = [];
      for (let i = 1; i < taps.length; i++) diffs.push(taps[i] - taps[i - 1]);
      const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      const next = Math.round(60000 / avg);
      setBpm(next);
    }
  };

  return (
    <div className="tempobar">
      <div className="tempo-block">
        <button
          className="btn btn-tempo-step"
          onClick={() => setBpm(bpm - 1)}
          aria-label="Slow down"
        >−</button>
        <div className="tempo-display">
          <input
            type="number"
            min={BPM_MIN}
            max={BPM_MAX}
            value={bpm}
            onChange={(e) => setBpm(parseInt(e.currentTarget.value, 10))}
            aria-label="BPM"
          />
          <span className="tempo-unit">BPM</span>
        </div>
        <button
          className="btn btn-tempo-step"
          onClick={() => setBpm(bpm + 1)}
          aria-label="Speed up"
        >+</button>
        <button className="btn btn-tap" onClick={tap}>TAP</button>
      </div>

      <div className="tempo-block">
        <label className="tempo-select">
          <span>time</span>
          <select
            value={beatsPerMeasure}
            onChange={(e) => updateSettings({ beatsPerMeasure: parseInt(e.currentTarget.value, 10) })}
          >
            {[2, 3, 4, 5, 6, 7, 8, 9, 12].map(n => (
              <option key={n} value={n}>{n}/4</option>
            ))}
          </select>
        </label>
      </div>

      <div className="tempo-block beat-display" aria-label="beat indicator">
        {Array.from({ length: beatsPerMeasure }, (_, i) => (
          <span
            key={i}
            className={`beat-dot ${ready && beatInMeasure === i ? 'active' : ''} ${i === 0 ? 'accent' : ''}`}
            style={{
              opacity: ready && beatInMeasure === i
                ? Math.max(0.45, 1 - beatProgress)
                : undefined,
            }}
          />
        ))}
      </div>

      <div className="tempo-block">
        <button
          className={`btn btn-metronome ${metronomeOn ? 'on' : ''}`}
          onClick={() => updateSettings({ metronomeOn: !metronomeOn })}
          aria-pressed={metronomeOn}
        >
          {metronomeOn ? 'CLICK ON' : 'click'}
        </button>
        <input
          type="range"
          className="metronome-level"
          min="0" max="1" step="0.01"
          value={metronomeLevel}
          disabled={!metronomeOn}
          onChange={(e) => updateSettings({ metronomeLevel: parseFloat(e.currentTarget.value) })}
          aria-label="Metronome level"
        />
      </div>

      {fixedLoopMeasures > 0 && (
        <div className="tempo-block">
          <span className="fixed-loop-badge">loop: <strong>{fixedLoopMeasures}</strong> bars</span>
        </div>
      )}

      {countInMs > 0 && (
        <div className="tempo-block countin-block">
          <span className="countin">COUNT-IN <strong>{(countInMs / 1000).toFixed(1)}s</strong></span>
        </div>
      )}
    </div>
  );
}
