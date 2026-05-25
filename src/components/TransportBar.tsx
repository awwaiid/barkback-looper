import {
  useAudioStore,
  selectLoopSeconds,
  selectLoopProgress,
  stopAll,
  playAll,
  clearAll,
} from '../audio/store.ts';
import { peakToPct } from '../audio/meter.ts';

export function TransportBar() {
  const inputPeak = useAudioStore(s => s.inputPeak);
  const latencyMs = useAudioStore(s => s.latencyMs);
  const sampleRate = useAudioStore(s => s.sampleRate);
  const loopFrames = useAudioStore(s => s.loopFrames);
  const growFrames = useAudioStore(s => s.growFrames);
  const loopSeconds = useAudioStore(selectLoopSeconds);
  const progress = useAudioStore(selectLoopProgress);

  const recording = loopFrames === 0 && growFrames > 0;
  const growSeconds = sampleRate > 0 ? growFrames / sampleRate : 0;
  const loopLabel = loopSeconds > 0 ? `${loopSeconds.toFixed(2)}s` : '—';

  return (
    <div className="transport">
      <div className="transport-left">
        <button className="btn btn-big" onClick={stopAll}>ALL STOP</button>
        <button className="btn" onClick={playAll}>PLAY ALL</button>
        <button
          className="btn btn-danger"
          onClick={() => { if (confirm('Clear ALL tracks and reset loop?')) clearAll(); }}
        >
          CLEAR ALL
        </button>
      </div>

      <div className="transport-center">
        <div className={`loop-bar ${recording ? 'recording' : ''}`}>
          <div
            className="loop-bar-fill"
            style={{ width: `${recording ? 100 : progress * 100}%` }}
          />
        </div>
        <div className="loop-meta">
          {recording ? (
            <span className="rec-counter">REC <strong>{growSeconds.toFixed(2)}s</strong></span>
          ) : (
            <span>loop: <strong>{loopLabel}</strong></span>
          )}
          {latencyMs > 0 && (
            <span>latency: <strong>{latencyMs.toFixed(0)} ms</strong></span>
          )}
          {sampleRate > 0 && <span>{sampleRate} Hz</span>}
        </div>
      </div>

      <div className="transport-right">
        <span className="input-label">in</span>
        <div className="meter input-meter">
          <div className="meter-fill" style={{ width: `${peakToPct(inputPeak)}%` }} />
        </div>
      </div>
    </div>
  );
}
