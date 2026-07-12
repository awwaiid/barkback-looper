import type {
  BufferReply,
  EngineState,
  LatencyTestReply,
  MetersData,
  StemsReply,
  TrackAction,
  WorkletCommand,
} from './types.ts';
import { NUM_TRACKS } from './types.ts';
import workletUrl from './looper-worklet.ts?worker&url';

export interface LatencyTestResult {
  success: boolean;
  roundTripMs: number;
  peakLevel: number;
  reason?: string;
}

export interface EngineCallbacks {
  onState?: (s: EngineState) => void;
  onMeters?: (m: MetersData) => void;
  onLatency?: (ms: number) => void;
}

export class LooperEngine {
  ctx: AudioContext | null = null;
  node: AudioWorkletNode | null = null;
  stream: MediaStream | null = null;
  source: MediaStreamAudioSourceNode | null = null;
  cb: EngineCallbacks = {};
  ready = false;
  bufferRequests = new Map<number, (reply: BufferReply) => void>();
  stemsRequests = new Map<number, (reply: StemsReply) => void>();
  latencyTestRequests = new Map<number, (reply: LatencyTestReply) => void>();
  nextReqId = 1;

  setCallbacks(cb: EngineCallbacks) {
    this.cb = cb;
  }

  async start(opts: { deviceId?: string; monitor?: number } = {}) {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      await this.ctx.audioWorklet.addModule(workletUrl);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      },
      video: false,
    });

    this.source = this.ctx.createMediaStreamSource(this.stream);

    this.node = new AudioWorkletNode(this.ctx, 'looper', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    this.node.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'state') this.cb.onState?.(d);
      else if (d.type === 'meters') this.cb.onMeters?.(d);
      else if (d.type === 'buffer') {
        const pending = this.bufferRequests.get(d.reqId);
        if (pending) {
          this.bufferRequests.delete(d.reqId);
          pending(d);
        }
      } else if (d.type === 'stems') {
        const pending = this.stemsRequests.get(d.reqId);
        if (pending) {
          this.stemsRequests.delete(d.reqId);
          pending(d);
        }
      } else if (d.type === 'latencyTestResult') {
        const pending = this.latencyTestRequests.get(d.reqId);
        if (pending) {
          this.latencyTestRequests.delete(d.reqId);
          pending(d);
        }
      }
    };

    if (opts.monitor !== undefined) {
      this.send({ type: 'setMonitor', value: opts.monitor });
    }

    this.source.connect(this.node);
    this.node.connect(this.ctx.destination);

    // Pre-allocate per-track recording buffers on the main thread and
    // transfer them into the worklet. This keeps REC presses from
    // triggering ~230 MB allocations on the audio thread.
    this.provideRecBuffers(this.ctx.sampleRate);

    this.ready = true;
    this.cb.onLatency?.((this.ctx.baseLatency + (this.ctx.outputLatency || 0)) * 1000);
  }

  // Pre-allocate ~60s per track. Anything longer triggers the worklet's
  // on-demand allocation path (one-time small glitch). Reserving the full
  // 10-minute cap upfront would be ~920 MB across 4 tracks — way too much
  // on phones, where it can OOM the tab silently.
  private static PRE_ALLOC_SECONDS = 60;

  private provideRecBuffers(sampleRate: number) {
    if (!this.node) return;
    const bytes = sampleRate * LooperEngine.PRE_ALLOC_SECONDS * 4;
    const buffers: { track: number; l: ArrayBuffer; r: ArrayBuffer }[] = [];
    const transfers: ArrayBuffer[] = [];
    try {
      for (let i = 0; i < NUM_TRACKS; i++) {
        const l = new ArrayBuffer(bytes);
        const r = new ArrayBuffer(bytes);
        buffers.push({ track: i, l, r });
        transfers.push(l, r);
      }
    } catch {
      // OOM on a memory-constrained device — skip the pre-alloc and let
      // the worklet allocate on demand when the user hits REC.
      return;
    }
    this.node.port.postMessage({ type: 'provideRecBuffers', buffers }, transfers);
  }

  async stop() {
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop());
    this.node = null;
    this.source = null;
    this.stream = null;
    this.ready = false;
  }

  send(cmd: WorkletCommand) {
    this.node?.port.postMessage(cmd);
  }

  // Mobile browsers (especially iOS Safari) suspend AudioContext when the
  // tab loses focus, the screen sleeps, or for various other reasons; each
  // user-initiated action gives the context a chance to resume.
  ensureRunning() {
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
  }

  cmd(track: number, action: TrackAction) { this.ensureRunning(); this.send({ type: 'cmd', track, action }); }
  setGain(track: number, value: number) { this.send({ type: 'setGain', track, value }); }
  clear(track: number) { this.send({ type: 'clear', track }); }
  clearAll() { this.ensureRunning(); this.send({ type: 'clearAll' }); }
  undo(track: number) { this.ensureRunning(); this.send({ type: 'undo', track }); }
  stopAll() { this.ensureRunning(); this.send({ type: 'stopAll' }); }
  playAll() { this.ensureRunning(); this.send({ type: 'playAll' }); }
  setMonitor(value: number) { this.send({ type: 'setMonitor', value }); }

  async listInputs(): Promise<MediaDeviceInfo[]> {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter(d => d.kind === 'audioinput');
  }

  private requestBuffer(payload: WorkletCommand): Promise<BufferReply> {
    if (!this.node) return Promise.reject(new Error('engine not started'));
    const reqId = this.nextReqId++;
    return new Promise<BufferReply>((resolve, reject) => {
      const to = setTimeout(() => {
        this.bufferRequests.delete(reqId);
        reject(new Error('buffer request timed out'));
      }, 5000);
      this.bufferRequests.set(reqId, (reply) => {
        clearTimeout(to);
        resolve(reply);
      });
      this.send({ ...payload, reqId } as WorkletCommand);
    });
  }

  getTrackBuffer(track: number) {
    return this.requestBuffer({ type: 'getBuffer', track, reqId: 0 });
  }

  getMixBuffer() {
    return this.requestBuffer({ type: 'getMix', reqId: 0 });
  }

  getStems(): Promise<StemsReply> {
    if (!this.node) return Promise.reject(new Error('engine not started'));
    const reqId = this.nextReqId++;
    return new Promise<StemsReply>((resolve, reject) => {
      const to = setTimeout(() => {
        this.stemsRequests.delete(reqId);
        reject(new Error('stems request timed out'));
      }, 10000);
      this.stemsRequests.set(reqId, (reply) => {
        clearTimeout(to);
        resolve(reply);
      });
      this.send({ type: 'getStems', reqId });
    });
  }

  loadBuffer(track: number, l: ArrayBuffer, r: ArrayBuffer) {
    this.send({ type: 'loadBuffer', track, l, r });
  }

  setRecAction(value: 'rec-play' | 'rec-overdub') {
    this.send({ type: 'setRecAction', value });
  }

  setAutoRec(enabled: boolean, threshold: number) {
    this.send({ type: 'setAutoRec', enabled, threshold });
  }

  setTempo(args: {
    bpm: number;
    beatsPerMeasure: number;
    metronomeOn: boolean;
    metronomeLevel: number;
    countInMeasures: number;
    recQuantize: 'off' | 'beat' | 'measure';
    fixedLoopMeasures: number;
  }) {
    this.send({ type: 'setTempo', ...args });
  }

  setLatencyCompensation(ms: number) {
    this.send({ type: 'setLatencyCompensation', ms });
  }

  async runLatencyTest(): Promise<LatencyTestResult> {
    if (!this.node) {
      return { success: false, roundTripMs: 0, peakLevel: 0, reason: 'Engine not started.' };
    }
    const reqId = this.nextReqId++;
    const reply = await new Promise<LatencyTestReply>((resolve, reject) => {
      // Capture is 250 ms of audio; give it 5 s wall-clock to cover slow systems.
      const to = setTimeout(() => {
        this.latencyTestRequests.delete(reqId);
        reject(new Error('Latency test timed out'));
      }, 5000);
      this.latencyTestRequests.set(reqId, (r) => { clearTimeout(to); resolve(r); });
      this.send({ type: 'startLatencyTest', reqId });
    });
    return analyzeLatencyTest(reply);
  }
}

// Find the round-trip latency from a captured input buffer. The buffer
// starts the moment the worklet began emitting its 5 ms tone burst.
function analyzeLatencyTest(reply: LatencyTestReply): LatencyTestResult {
  const data = new Float32Array(reply.buffer);
  const sr = reply.sampleRate;
  const TONE_HZ = 1000;

  // Skip the first 1 ms to ignore any inline electrical crosstalk.
  const skip = Math.floor(sr * 0.001);

  // Detect the 1 kHz test tone specifically, not just the loudest sample.
  // A plain amplitude peak fires on mic self-noise or room sound, so on
  // headphones — where the mic never hears the click — it would report a
  // bogus latency. A sliding Goertzel filter measures 1 kHz energy per
  // window; requiring that energy to clear both an absolute floor and the
  // ambient level makes "nothing heard" fail correctly.
  const win = Math.max(8, Math.floor(sr * 0.005)); // ~tone burst length
  const hop = Math.max(1, Math.floor(win / 4));
  const k = Math.round((win * TONE_HZ) / sr);
  const coeff = 2 * Math.cos((2 * Math.PI * k) / win);

  const mags: number[] = [];
  const starts: number[] = [];
  for (let start = skip; start + win <= data.length; start += hop) {
    let s0 = 0;
    let s1 = 0;
    for (let i = 0; i < win; i++) {
      const s = data[start + i] + coeff * s0 - s1;
      s1 = s0;
      s0 = s;
    }
    const power = s0 * s0 + s1 * s1 - coeff * s0 * s1;
    mags.push((2 * Math.sqrt(Math.max(0, power))) / win); // ~tone amplitude
    starts.push(start);
  }

  if (mags.length === 0) {
    return { success: false, roundTripMs: 0, peakLevel: 0, reason: 'Capture too short to analyze.' };
  }

  let peakMag = 0;
  let peakWin = -1;
  for (let i = 0; i < mags.length; i++) {
    if (mags[i] > peakMag) {
      peakMag = mags[i];
      peakWin = i;
    }
  }
  // Robust ambient 1 kHz level: median across all windows.
  const sortedMags = mags.slice().sort((a, b) => a - b);
  const ambient = sortedMags[Math.floor(sortedMags.length / 2)] || 1e-9;

  if (peakWin < 0 || peakMag < 0.01 || peakMag < ambient * 8) {
    return {
      success: false,
      roundTripMs: 0,
      peakLevel: peakMag,
      reason:
        'No test tone detected. On headphones the mic can’t hear the click — ' +
        'switch to speakers (or just leave compensation at 0). Otherwise place ' +
        'the mic near the speaker and raise the input gain.',
    };
  }

  // The 5 ms Goertzel window matches the 5 ms burst, so the 1 kHz energy
  // peaks when the window start aligns with the tone's arrival. Use that
  // window start as the onset, refined with parabolic interpolation of the
  // magnitude curve for sub-hop precision. (Walking back over raw samples is
  // unreliable here — the tone's own zero-crossings trip up an amplitude
  // threshold, and in noise there is no clean onset to find.)
  let onsetIdx = starts[peakWin];
  if (peakWin > 0 && peakWin < mags.length - 1) {
    const a = mags[peakWin - 1];
    const b = mags[peakWin];
    const c = mags[peakWin + 1];
    const denom = a - 2 * b + c;
    if (denom !== 0) {
      const delta = (0.5 * (a - c)) / denom; // fraction of a hop, ~[-1, 1]
      onsetIdx += Math.round(delta * hop);
    }
  }
  onsetIdx = Math.max(0, onsetIdx);

  const ms = (onsetIdx / sr) * 1000;
  return { success: true, roundTripMs: ms, peakLevel: peakMag };
}
