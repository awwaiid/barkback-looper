import { useEffect, useState } from 'react';
import {
  exportMixWav,
  listSessions,
  saveSession,
  loadSession,
  deleteSession,
  type SessionInfo,
} from '../audio/storage.ts';

function fmtTime(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

export function SessionPanel({ onClose }: { onClose: () => void }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const refresh = async () => {
    try {
      setSessions(await listSessions());
    } catch (e: any) {
      setErr(e?.message ?? 'Could not read OPFS.');
    }
  };

  useEffect(() => { refresh(); }, []);

  const doSave = async () => {
    if (!name.trim()) { setErr('Name required.'); return; }
    setBusy(true);
    setErr('');
    try {
      await saveSession(name.trim());
      await refresh();
      setName('');
    } catch (e: any) {
      setErr(e?.message ?? 'Save failed.');
    } finally {
      setBusy(false);
    }
  };

  const doLoad = async (n: string) => {
    setBusy(true);
    setErr('');
    try {
      await loadSession(n);
    } catch (e: any) {
      setErr(e?.message ?? 'Load failed.');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (n: string) => {
    if (!confirm(`Delete session "${n}"?`)) return;
    await deleteSession(n);
    await refresh();
  };

  return (
    <div className="midi-panel">
      <div className="session-head">
        <h2>Sessions</h2>
        <button className="btn btn-sm" onClick={onClose}>close</button>
      </div>

      <div className="midi-section">
        <h3>Save current</h3>
        <div className="session-save">
          <input
            type="text"
            placeholder="session name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') doSave(); }}
          />
          <button className="btn btn-primary" disabled={busy} onClick={doSave}>save to browser</button>
          <button className="btn" disabled={busy} onClick={() => exportMixWav()}>bounce mix → .wav</button>
        </div>
        {err && <p className="status-err">{err}</p>}
      </div>

      <div className="midi-section">
        <h3>Saved (in this browser)</h3>
        {sessions.length === 0 ? (
          <p className="muted">No sessions yet. Sessions are stored locally via OPFS — they stay in this browser only.</p>
        ) : (
          <table className="midi-bindings">
            <thead>
              <tr><th>Name</th><th>Tracks</th><th>Saved</th><th></th></tr>
            </thead>
            <tbody>
              {sessions.map(s => (
                <tr key={s.name}>
                  <td><code>{s.name}</code></td>
                  <td>{s.hasTracks}</td>
                  <td className="muted">{fmtTime(s.modified)}</td>
                  <td>
                    <button className="btn btn-sm" disabled={busy} onClick={() => doLoad(s.name)}>load</button>
                    <button className="btn btn-sm" onClick={() => doDelete(s.name)}>×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
