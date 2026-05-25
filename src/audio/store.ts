import { create } from 'zustand';
import type { EngineState, MetersData, TrackSnapshot } from './types.ts';
import { NUM_TRACKS } from './types.ts';
import { LooperEngine } from './engine.ts';

const emptyTrack = (): TrackSnapshot => ({
  mode: 'empty',
  hasAudio: false,
  gain: 1.0,
  durationFrames: 0,
  canUndo: false,
});

export interface AudioStoreState {
  ready: boolean;
  contextRunning: boolean;
  sampleRate: number;
  loopFrames: number;
  playhead: number;
  growFrames: number;
  latencyMs: number;
  tracks: TrackSnapshot[];
  inputPeak: number;
  trackPeaks: number[];
  trackWaveforms: (Float32Array | null)[];
  selectedTrack: number;
  monitor: number;
  statusMsg: string;
}

const WAVEFORM_BUCKETS = 200;

function computePeaks(l: Float32Array, r: Float32Array, buckets: number): Float32Array {
  const out = new Float32Array(buckets);
  const n = Math.min(l.length, r.length);
  if (n === 0) return out;
  const step = n / buckets;
  for (let i = 0; i < buckets; i++) {
    const s0 = Math.floor(i * step);
    const s1 = Math.min(n, Math.floor((i + 1) * step));
    let max = 0;
    for (let j = s0; j < s1; j++) {
      const a = Math.abs(l[j]);
      const b = Math.abs(r[j]);
      const m = a > b ? a : b;
      if (m > max) max = m;
    }
    out[i] = max;
  }
  return out;
}

export const useAudioStore = create<AudioStoreState>(() => ({
  ready: false,
  contextRunning: false,
  sampleRate: 0,
  loopFrames: 0,
  playhead: 0,
  growFrames: 0,
  latencyMs: 0,
  tracks: Array.from({ length: NUM_TRACKS }, emptyTrack),
  inputPeak: 0,
  trackPeaks: Array.from({ length: NUM_TRACKS }, () => 0),
  trackWaveforms: Array.from({ length: NUM_TRACKS }, () => null),
  selectedTrack: 0,
  monitor: 0,
  statusMsg: '',
}));

export const engine = new LooperEngine();

const lastTrackSignature: string[] = Array.from({ length: NUM_TRACKS }, () => '');

async function refreshWaveform(idx: number) {
  try {
    const reply = await engine.getTrackBuffer(idx);
    const l = new Float32Array(reply.l);
    const r = new Float32Array(reply.r);
    const peaks = l.length > 0 ? computePeaks(l, r, WAVEFORM_BUCKETS) : null;
    useAudioStore.setState(state => {
      const next = state.trackWaveforms.slice();
      next[idx] = peaks;
      return { trackWaveforms: next };
    });
  } catch {}
}

function clearWaveform(idx: number) {
  useAudioStore.setState(state => {
    if (state.trackWaveforms[idx] === null) return state;
    const next = state.trackWaveforms.slice();
    next[idx] = null;
    return { trackWaveforms: next };
  });
}

function handleStateTransition(tracks: TrackSnapshot[]) {
  // Refresh the waveform whenever a track enters a stable post-record state, or clear on empty.
  // We don't refresh during recording/overdub because those modes change every block.
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const sig = `${t.mode}:${t.hasAudio}:${t.durationFrames}`;
    if (sig === lastTrackSignature[i]) continue;
    lastTrackSignature[i] = sig;
    if (t.mode === 'empty' || !t.hasAudio) {
      clearWaveform(i);
    } else if (t.mode === 'playing' || t.mode === 'stopped') {
      void refreshWaveform(i);
    }
  }
}

engine.setCallbacks({
  onState(s: EngineState) {
    useAudioStore.setState({
      loopFrames: s.loopFrames,
      playhead: s.playhead,
      sampleRate: s.sampleRate,
      tracks: s.tracks,
    });
    handleStateTransition(s.tracks);
  },
  onMeters(m: MetersData) {
    useAudioStore.setState({
      inputPeak: m.inputPeak,
      trackPeaks: [...m.trackPeaks],
      playhead: m.playhead,
      growFrames: m.growFrames,
    });
  },
  onLatency(ms: number) {
    useAudioStore.setState({ latencyMs: ms });
  },
});

export async function startEngine(deviceId?: string) {
  try {
    const monitor = useAudioStore.getState().monitor;
    await engine.start({ deviceId, monitor });
    useAudioStore.setState({ ready: true, contextRunning: true, statusMsg: '' });
  } catch (err: any) {
    useAudioStore.setState({ statusMsg: `Mic error: ${err?.message ?? err}` });
  }
}

export async function stopEngine() {
  await engine.stop();
  useAudioStore.setState({ ready: false, contextRunning: false });
}

export function setMonitor(value: number) {
  useAudioStore.setState({ monitor: value });
  engine.setMonitor(value);
}

export function setSelectedTrack(i: number) {
  useAudioStore.setState({ selectedTrack: i });
}

export function getSelectedTrack(): number {
  return useAudioStore.getState().selectedTrack;
}

export function trackAction(i: number, action: 'rec' | 'play' | 'stop') {
  engine.cmd(i, action);
}

export function clearTrack(i: number) { engine.clear(i); }
export function clearAll() { engine.clearAll(); }
export function undoTrack(i: number) { engine.undo(i); }
export function stopAll() { engine.stopAll(); }
export function playAll() { engine.playAll(); }
export function setTrackGain(i: number, v: number) {
  engine.setGain(i, v);
  useAudioStore.setState(s => {
    const tracks = s.tracks.slice();
    tracks[i] = { ...tracks[i], gain: v };
    return { tracks };
  });
}

export const selectLoopSeconds = (s: AudioStoreState) =>
  s.sampleRate > 0 ? s.loopFrames / s.sampleRate : 0;

export const selectLoopProgress = (s: AudioStoreState) =>
  s.loopFrames > 0 ? s.playhead / s.loopFrames : 0;
