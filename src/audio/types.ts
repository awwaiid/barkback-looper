export type TrackMode = 'empty' | 'recording' | 'playing' | 'overdub' | 'stopped' | 'armed';

export type TrackAction = 'rec' | 'play' | 'stop';

export interface TrackSnapshot {
  mode: TrackMode;
  hasAudio: boolean;
  gain: number;
  durationFrames: number;
  canUndo: boolean;
  cycles: number;       // how many master cycles this track spans
  cycleIndex: number;   // current cycle being played (0..cycles-1)
  anchor: number;       // master-position phase offset of buffer[0], in frames
}

export interface EngineState {
  type: 'state';
  tracks: TrackSnapshot[];
  loopFrames: number;
  playhead: number;
  sampleRate: number;
}

export interface MetersData {
  type: 'meters';
  inputPeak: number;
  trackPeaks: number[];
  trackProgress: number[]; // per-track playback progress 0..1 across its full buffer
  playhead: number;
  loopFrames: number;
  growFrames: number;
  beatInMeasure: number;
  beatProgress: number; // 0..1 within current beat
  countInRemainingMs: number; // ms remaining on the longest active count-in, 0 if none
  cpuAvgPct: number;  // mean process() time / block budget over the last window
  cpuMaxPct: number;  // worst process() time / block budget in the last window
  cpuOverruns: number; // count of blocks that exceeded budget since engine start
}

export type EngineMessage = EngineState | MetersData;

export type WorkletCommand =
  | { type: 'cmd'; track: number; action: TrackAction }
  | { type: 'setGain'; track: number; value: number }
  | { type: 'clear'; track: number }
  | { type: 'clearAll' }
  | { type: 'undo'; track: number }
  | { type: 'stopAll' }
  | { type: 'playAll' }
  | { type: 'setMonitor'; value: number }
  | { type: 'getBuffer'; track: number; reqId: number }
  | { type: 'getMix'; reqId: number }
  | { type: 'getStems'; reqId: number }
  | { type: 'loadBuffer'; track: number; l: ArrayBuffer; r: ArrayBuffer; anchor?: number }
  | { type: 'setRecAction'; value: 'rec-play' | 'rec-overdub' }
  | { type: 'setAutoRec'; enabled: boolean; threshold: number }
  | {
      type: 'setTempo';
      bpm: number;
      beatsPerMeasure: number;
      metronomeOn: boolean;
      metronomeLevel: number;
      countInMeasures: number;
      recQuantize: 'off' | 'beat' | 'measure';
      fixedLoopMeasures: number;
    }
  | {
      type: 'provideRecBuffers';
      buffers: { track: number; l: ArrayBuffer; r: ArrayBuffer }[];
    }
  | { type: 'setLatencyCompensation'; ms: number }
  | { type: 'startLatencyTest'; reqId: number };

export interface LatencyTestReply {
  type: 'latencyTestResult';
  reqId: number;
  buffer: ArrayBuffer;        // captured input samples (mono, Float32)
  sampleRate: number;
  impulseStartFrame: number;  // sample index where the impulse output began
}

export interface BufferReply {
  type: 'buffer';
  reqId: number;
  track: number | 'mix';
  l: ArrayBuffer;
  r: ArrayBuffer;
  sampleRate: number;
}

export interface StemsReply {
  type: 'stems';
  reqId: number;
  sampleRate: number;
  // One entry per track; null for empty tracks. Each is rolled out to the
  // longest track's length and anchor-aligned so all stems share a timeline.
  stems: ({ l: ArrayBuffer; r: ArrayBuffer } | null)[];
}

export const NUM_TRACKS = 4;
