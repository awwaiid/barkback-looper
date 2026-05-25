import { useEffect, useState } from 'react';
import {
  useAudioStore,
  startEngine,
  stopEngine,
  setMonitor,
} from '../audio/store.ts';

export function AudioSetup() {
  const ready = useAudioStore(s => s.ready);
  const monitor = useAudioStore(s => s.monitor);
  const statusMsg = useAudioStore(s => s.statusMsg);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [chosen, setChosen] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        setDevices(all.filter(d => d.kind === 'audioinput'));
      } catch {}
    })();
  }, []);

  const onConnect = async () => {
    await startEngine(chosen || undefined);
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter(d => d.kind === 'audioinput'));
    } catch {}
  };

  if (ready) {
    return (
      <div className="audio-setup">
        <span className="ok-pill">audio engine: running</span>
        <label className="monitor-row">
          <span>monitor</span>
          <input
            type="range" min="0" max="1" step="0.01"
            value={monitor}
            onChange={(e) => setMonitor(parseFloat(e.currentTarget.value))}
          />
        </label>
        <button className="btn" onClick={stopEngine}>Disconnect</button>
      </div>
    );
  }

  return (
    <div className="audio-setup">
      <select value={chosen} onChange={(e) => setChosen(e.currentTarget.value)}>
        <option value="">— default input —</option>
        {devices.map(d => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `Input ${d.deviceId.slice(0, 6)}`}
          </option>
        ))}
      </select>
      <button className="btn btn-primary" onClick={onConnect}>Connect input</button>
      {statusMsg && <span className="status-err">{statusMsg}</span>}
    </div>
  );
}
