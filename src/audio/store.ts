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
  selectedTrack: number;
  monitor: number;
  statusMsg: string;
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
  selectedTrack: 0,
  monitor: 0,
  statusMsg: '',
}));

export const engine = new LooperEngine();

engine.setCallbacks({
  onState(s: EngineState) {
    useAudioStore.setState({
      loopFrames: s.loopFrames,
      playhead: s.playhead,
      sampleRate: s.sampleRate,
      tracks: s.tracks,
    });
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
