import {
  useMidiStore,
  toggleInput,
  setLearnTarget,
  removeBinding,
  describeBinding,
  MIDI_ACTION_LABELS,
  type MidiAction,
} from '../midi/midi.ts';

const PRIMARY_ACTIONS: MidiAction[] = [
  'rec-selected',
  'stop-selected',
  'undo-selected',
  'select-next',
  'all-stop',
];

const TRACK_ACTIONS: MidiAction[] = [
  'rec-track-1', 'rec-track-2', 'rec-track-3', 'rec-track-4',
];

export function MidiPanel() {
  const supported = useMidiStore(s => s.supported);
  const inputs = useMidiStore(s => s.inputs);
  const enabled = useMidiStore(s => s.enabled);
  const bindings = useMidiStore(s => s.bindings);
  const learnTarget = useMidiStore(s => s.learnTarget);
  const lastEvent = useMidiStore(s => s.lastEvent);

  if (!supported) {
    return (
      <div className="midi-panel">
        <h2>MIDI</h2>
        <p className="muted">Web MIDI not supported in this browser.</p>
      </div>
    );
  }

  return (
    <div className="midi-panel">
      <h2>MIDI</h2>

      <div className="midi-section">
        <h3>Inputs</h3>
        {inputs.length === 0 ? (
          <p className="muted">No MIDI inputs detected. Plug in a device and reload.</p>
        ) : (
          <ul className="midi-inputs">
            {inputs.map(inp => (
              <li key={inp.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={enabled.has(inp.id)}
                    onChange={(e) => toggleInput(inp.id, e.currentTarget.checked)}
                  />
                  <span>{inp.name}</span>
                  {inp.manufacturer && <span className="muted"> · {inp.manufacturer}</span>}
                </label>
              </li>
            ))}
          </ul>
        )}
        {lastEvent && <p className="muted">last: <code>{lastEvent}</code></p>}
      </div>

      <div className="midi-section">
        <h3>Bindings</h3>
        <table className="midi-bindings">
          <thead>
            <tr><th>Action</th><th>Trigger</th><th></th></tr>
          </thead>
          <tbody>
            {[...PRIMARY_ACTIONS, ...TRACK_ACTIONS].map(action => {
              const b = bindings.find(x => x.action === action);
              const learning = learnTarget === action;
              return (
                <tr key={action}>
                  <td>{MIDI_ACTION_LABELS[action]}</td>
                  <td>{b ? <code>{describeBinding(b)}</code> : <span className="muted">—</span>}</td>
                  <td>
                    {learning ? (
                      <button className="btn btn-sm btn-learning" onClick={() => setLearnTarget(null)}>
                        waiting…
                      </button>
                    ) : (
                      <>
                        <button className="btn btn-sm" onClick={() => setLearnTarget(action)}>Learn</button>
                        {b && (
                          <button className="btn btn-sm" onClick={() => removeBinding(action)}>×</button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="muted">
          Click <em>Learn</em>, then tap a button on your MIDI controller. Bindings persist in this browser.
        </p>
      </div>

      {bindings.length === 0 && (
        <p className="muted">
          Suggested for a 3-button footswitch: bind to <em>REC selected</em>, <em>Stop selected</em>, <em>Undo selected</em>.
        </p>
      )}
    </div>
  );
}
