import { engine, useAudioStore } from './store.ts';
import { encodeWav16, decodeWav } from './wav.ts';
import { NUM_TRACKS } from './types.ts';

const SESSION_DIR = 'sessions';

async function getRoot(): Promise<FileSystemDirectoryHandle | null> {
  if (!('storage' in navigator) || !navigator.storage.getDirectory) return null;
  return navigator.storage.getDirectory();
}

async function getSessionDir(name: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  const root = await getRoot();
  if (!root) return null;
  try {
    const sessions = await root.getDirectoryHandle(SESSION_DIR, { create });
    return await sessions.getDirectoryHandle(name, { create });
  } catch {
    return null;
  }
}

// Trigger a download in the user's browser. Uses File System Access API picker
// when available, falls back to a blob link.
export async function downloadBlob(blob: Blob, suggestedName: string): Promise<void> {
  const w = window as any;
  if (typeof w.showSaveFilePicker === 'function') {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'WAV audio', accept: { 'audio/wav': ['.wav'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function timestampedName(prefix: string): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${prefix}-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.wav`;
}

export async function exportTrackWav(track: number): Promise<void> {
  const reply = await engine.getTrackBuffer(track);
  if (reply.l.byteLength === 0) {
    alert(`Track ${track + 1} is empty.`);
    return;
  }
  // The raw track buffer is stored at unity; bake in the track's volume
  // fader so the bounce matches what you hear (the mix bounce already does).
  const l = new Float32Array(reply.l);
  const r = new Float32Array(reply.r);
  const gain = useAudioStore.getState().tracks[track]?.gain ?? 1;
  if (gain !== 1) {
    for (let i = 0; i < l.length; i++) l[i] *= gain;
    for (let i = 0; i < r.length; i++) r[i] *= gain;
  }
  const blob = encodeWav16(l, r, reply.sampleRate);
  await downloadBlob(blob, timestampedName(`track${track + 1}`));
}

export async function exportMixWav(): Promise<void> {
  const reply = await engine.getMixBuffer();
  if (reply.l.byteLength === 0) {
    alert('No audio to bounce yet.');
    return;
  }
  const blob = encodeWav16(new Float32Array(reply.l), new Float32Array(reply.r), reply.sampleRate);
  await downloadBlob(blob, timestampedName('mix'));
}

export interface SessionInfo {
  name: string;
  modified: number;
  hasTracks: number;
}

export async function listSessions(): Promise<SessionInfo[]> {
  const root = await getRoot();
  if (!root) return [];
  let sessions: FileSystemDirectoryHandle;
  try {
    sessions = await root.getDirectoryHandle(SESSION_DIR, { create: false });
  } catch {
    return [];
  }
  const out: SessionInfo[] = [];
  for await (const [name, h] of (sessions as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (h.kind !== 'directory') continue;
    const dir = h as FileSystemDirectoryHandle;
    let count = 0;
    let modified = 0;
    for await (const [fname, fh] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
      if (fh.kind === 'file' && fname.endsWith('.wav')) {
        count++;
        try {
          const file = await (fh as FileSystemFileHandle).getFile();
          if (file.lastModified > modified) modified = file.lastModified;
        } catch {}
      }
    }
    out.push({ name, modified, hasTracks: count });
  }
  out.sort((a, b) => b.modified - a.modified);
  return out;
}

export async function saveSession(name: string): Promise<void> {
  const dir = await getSessionDir(name, true);
  if (!dir) throw new Error('OPFS not available');
  for (let i = 0; i < NUM_TRACKS; i++) {
    const reply = await engine.getTrackBuffer(i);
    if (reply.l.byteLength === 0) {
      // remove stale file
      try { await dir.removeEntry(`track${i + 1}.wav`); } catch {}
      continue;
    }
    const blob = encodeWav16(new Float32Array(reply.l), new Float32Array(reply.r), reply.sampleRate);
    const file = await dir.getFileHandle(`track${i + 1}.wav`, { create: true });
    const w = await file.createWritable();
    await w.write(blob);
    await w.close();
  }
}

export async function loadSession(name: string): Promise<void> {
  const dir = await getSessionDir(name, false);
  if (!dir) throw new Error('OPFS not available');
  for (let i = 0; i < NUM_TRACKS; i++) {
    try {
      const fh = await dir.getFileHandle(`track${i + 1}.wav`, { create: false });
      const file = await fh.getFile();
      const buf = await file.arrayBuffer();
      const decoded = decodeWav(buf);
      if (decoded) {
        engine.loadBuffer(i, decoded.l.buffer as ArrayBuffer, decoded.r.buffer as ArrayBuffer);
      }
    } catch {
      // missing track is fine
    }
  }
}

export async function deleteSession(name: string): Promise<void> {
  const root = await getRoot();
  if (!root) return;
  try {
    const sessions = await root.getDirectoryHandle(SESSION_DIR, { create: false });
    await sessions.removeEntry(name, { recursive: true });
  } catch {}
}
