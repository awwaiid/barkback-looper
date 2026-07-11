import { useEffect, useRef, useState } from 'react';
import {
  useAudioStore,
  startEngine,
  stopEngine,
} from '../audio/store.ts';

export function AudioSetup() {
  const ready = useAudioStore(s => s.ready);
  const statusMsg = useAudioStore(s => s.statusMsg);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string>('');
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const refreshDevices = async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter(d => d.kind === 'audioinput'));
    } catch {}
  };

  useEffect(() => { refreshDevices(); }, []);

  // Close the menu on an outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const connect = async (deviceId: string) => {
    setMenuOpen(false);
    setActiveDeviceId(deviceId);
    await startEngine(deviceId || undefined);
    refreshDevices();
  };

  const disconnect = () => {
    setMenuOpen(false);
    stopEngine();
  };

  const activeLabel = (() => {
    if (!activeDeviceId) return 'default input';
    const d = devices.find(d => d.deviceId === activeDeviceId);
    return d?.label || `Input ${activeDeviceId.slice(0, 6)}`;
  })();

  const deviceLabel = (d: MediaDeviceInfo) =>
    d.label || `Input ${d.deviceId.slice(0, 6)}`;

  return (
    <div className="audio-setup" ref={rootRef}>
      <div className="input-picker">
        <button
          className={`btn ${ready ? 'input-btn-connected' : 'btn-primary'}`}
          onClick={() => {
            if (!ready) refreshDevices();
            setMenuOpen(o => !o);
          }}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          {ready ? (
            <>
              <span className="input-dot" aria-hidden="true" />
              <span className="input-btn-label">{activeLabel}</span>
            </>
          ) : (
            'Connect input'
          )}
          <span className="input-caret" aria-hidden="true">▾</span>
        </button>

        {menuOpen && (
          <div className="input-menu" role="menu">
            <div className="input-menu-heading">Input device</div>
            <button
              className={`input-menu-item ${ready && activeDeviceId === '' ? 'active' : ''}`}
              role="menuitem"
              onClick={() => connect('')}
            >
              — default input —
            </button>
            {devices.map(d => (
              <button
                key={d.deviceId}
                className={`input-menu-item ${ready && activeDeviceId === d.deviceId ? 'active' : ''}`}
                role="menuitem"
                onClick={() => connect(d.deviceId)}
              >
                {deviceLabel(d)}
              </button>
            ))}
            {ready && (
              <button
                className="input-menu-item input-menu-disconnect"
                role="menuitem"
                onClick={disconnect}
              >
                Disconnect
              </button>
            )}
          </div>
        )}
      </div>

      {statusMsg && <span className="status-err">{statusMsg}</span>}
    </div>
  );
}
