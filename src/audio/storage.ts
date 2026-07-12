import { engine, useAudioStore, setTrackGain } from './store.ts';
import { encodeWav16, decodeWav } from './wav.ts';
import { NUM_TRACKS } from './types.ts';
import { currentSettings, updateSettings, type Settings } from '../settings/settings.ts';

const SESSION_DIR = 'sessions';
const META_FILE = 'session.json';

interface SessionMeta {
  version: 1;
  settings: Settings;
  trackGains: number[];
}

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

// Save a blob to a file the browser downloads directly (no picker).
function anchorDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  anchorDownload(blob, suggestedName);
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function timestampedName(prefix: string, ext = 'wav'): string {
  return `${prefix}-${timestamp()}.${ext}`;
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

// Export every non-empty track as its own WAV, rolled out to the longest
// track's length and anchor-aligned so all files share one timeline — drop
// them into a DAW at 0:00 and they line up as performed. Stems are raw
// (pre-fader) so levels/effects can be set in the DAW.
//
// Where the File System Access API exists, one folder picker drops all files
// into a chosen folder; otherwise each file downloads separately (the browser
// may ask to allow multiple downloads).
export async function exportStems(): Promise<void> {
  const reply = await engine.getStems();
  const files: { name: string; blob: Blob }[] = [];
  reply.stems.forEach((s, i) => {
    if (!s) return;
    files.push({
      name: `track${i + 1}.wav`,
      blob: encodeWav16(new Float32Array(s.l), new Float32Array(s.r), reply.sampleRate),
    });
  });
  if (files.length === 0) {
    alert('No audio to export yet.');
    return;
  }

  const folder = `barkback-stems-${timestamp()}`;
  const w = window as any;
  if (typeof w.showDirectoryPicker === 'function') {
    try {
      const dir = await w.showDirectoryPicker({ mode: 'readwrite' });
      const sub = await dir.getDirectoryHandle(folder, { create: true });
      for (const f of files) {
        const fh = await sub.getFileHandle(f.name, { create: true });
        const writable = await fh.createWritable();
        await writable.write(f.blob);
        await writable.close();
      }
      return;
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      // Any other failure falls through to per-file downloads below.
    }
  }

  // Fallback: download each stem separately, prefixed so they group together.
  for (const f of files) {
    anchorDownload(f.blob, `${folder}-${f.name}`);
  }
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

  // Persist settings + per-track gains so the session restores exactly.
  const meta: SessionMeta = {
    version: 1,
    settings: currentSettings(),
    trackGains: useAudioStore.getState().tracks.map(t => t.gain),
  };
  const metaFile = await dir.getFileHandle(META_FILE, { create: true });
  const mw = await metaFile.createWritable();
  await mw.write(new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  await mw.close();
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

  // Restore settings + per-track gains if this session has them. Applied
  // after loading buffers so the gains win over the loaded-track snapshot.
  try {
    const fh = await dir.getFileHandle(META_FILE, { create: false });
    const meta = JSON.parse(await (await fh.getFile()).text()) as Partial<SessionMeta>;
    if (meta.settings && typeof meta.settings === 'object') {
      updateSettings(meta.settings);
    }
    if (Array.isArray(meta.trackGains)) {
      meta.trackGains.forEach((g, i) => {
        if (i < NUM_TRACKS && typeof g === 'number') setTrackGain(i, g);
      });
    }
  } catch {
    // Older sessions have no metadata — leave current settings/gains as-is.
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
