import { useSettingsStore, updateSettings, resetSettings } from '../settings/settings.ts';
import { NUM_TRACKS } from '../audio/types.ts';

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const recAction = useSettingsStore(s => s.recAction);
  const trackPlayMode = useSettingsStore(s => s.trackPlayMode);
  const allStopTargets = useSettingsStore(s => s.allStopTargets);
  const allPlayTargets = useSettingsStore(s => s.allPlayTargets);
  const autoRec = useSettingsStore(s => s.autoRec);
  const threshold = useSettingsStore(s => s.autoRecThreshold);

  const toggleStopTarget = (i: number, on: boolean) => {
    const next = allStopTargets.slice();
    next[i] = on;
    updateSettings({ allStopTargets: next });
  };
  const togglePlayTarget = (i: number, on: boolean) => {
    const next = allPlayTargets.slice();
    next[i] = on;
    updateSettings({ allPlayTargets: next });
  };

  return (
    <div className="midi-panel">
      <div className="session-head">
        <h2>Settings</h2>
        <button className="btn btn-sm" onClick={onClose}>close</button>
      </div>

      <div className="midi-section">
        <h3>Rec Action</h3>
        <p className="muted setting-help">
          What the REC button cycles to after recording. <em>RC-505 calls this "Rec Action".</em>
        </p>
        <div className="setting-choice">
          <label>
            <input
              type="radio"
              name="recAction"
              checked={recAction === 'rec-play'}
              onChange={() => updateSettings({ recAction: 'rec-play' })}
            />
            <span><code>REC → PLAY → OVERDUB</code></span>
            <span className="muted"> &nbsp; second tap drops into playback; you have to tap again to overdub</span>
          </label>
          <label>
            <input
              type="radio"
              name="recAction"
              checked={recAction === 'rec-overdub'}
              onChange={() => updateSettings({ recAction: 'rec-overdub' })}
            />
            <span><code>REC → OVERDUB → PLAY</code></span>
            <span className="muted"> &nbsp; RC-505 default; second tap immediately layers another pass</span>
          </label>
        </div>
      </div>

      <div className="midi-section">
        <h3>Track Play Mode</h3>
        <p className="muted setting-help">
          Whether selecting/playing a track also stops the others.
        </p>
        <div className="setting-choice">
          <label>
            <input
              type="radio"
              name="trackPlayMode"
              checked={trackPlayMode === 'multi'}
              onChange={() => updateSettings({ trackPlayMode: 'multi' })}
            />
            <span><code>MULTI</code></span>
            <span className="muted"> &nbsp; tracks layer together (default looping behaviour)</span>
          </label>
          <label>
            <input
              type="radio"
              name="trackPlayMode"
              checked={trackPlayMode === 'single'}
              onChange={() => updateSettings({ trackPlayMode: 'single' })}
            />
            <span><code>SINGLE</code></span>
            <span className="muted"> &nbsp; activating a track stops the others (phrase-launcher / scene-clip mode)</span>
          </label>
        </div>
      </div>

      <div className="midi-section">
        <h3>Auto Rec</h3>
        <p className="muted setting-help">
          With Auto Rec on, REC arms the track. Recording starts the moment input crosses the threshold.
        </p>
        <label className="setting-row">
          <input
            type="checkbox"
            checked={autoRec}
            onChange={(e) => updateSettings({ autoRec: e.currentTarget.checked })}
          />
          <span>Enable Auto Rec</span>
        </label>
        <label className={`setting-row ${autoRec ? '' : 'disabled-row'}`}>
          <span style={{ minWidth: '90px' }}>threshold</span>
          <input
            type="range" min="0.005" max="0.5" step="0.005"
            value={threshold}
            disabled={!autoRec}
            onChange={(e) => updateSettings({ autoRecThreshold: parseFloat(e.currentTarget.value) })}
          />
          <span className="muted" style={{ fontFamily: 'var(--mono)', minWidth: '60px' }}>
            {(20 * Math.log10(Math.max(threshold, 0.0001))).toFixed(1)} dB
          </span>
        </label>
      </div>

      <div className="midi-section">
        <h3>All Stop / All Play targets</h3>
        <p className="muted setting-help">
          Choose which tracks the big ALL STOP / PLAY ALL buttons (and the spacebar) affect — handy for keeping a drone going while the rest stops.
        </p>
        <table className="midi-bindings target-table">
          <thead>
            <tr>
              <th>Track</th>
              <th>All Stop</th>
              <th>Play All</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: NUM_TRACKS }, (_, i) => (
              <tr key={i}>
                <td><code>track {i + 1}</code></td>
                <td>
                  <input
                    type="checkbox"
                    checked={allStopTargets[i]}
                    onChange={(e) => toggleStopTarget(i, e.currentTarget.checked)}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={allPlayTargets[i]}
                    onChange={(e) => togglePlayTarget(i, e.currentTarget.checked)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="midi-section">
        <button className="btn" onClick={resetSettings}>Reset to defaults</button>
      </div>
    </div>
  );
}
