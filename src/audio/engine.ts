import type {
  BufferReply,
  EngineState,
  LatencyTestReply,
  MetersData,
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
  // Skip the first 1 ms to ignore any inline electrical crosstalk.
  const skip = Math.floor(sr * 0.001);
  let peakIdx = -1;
  let peak = 0;
  for (let i = skip; i < data.length; i++) {
    const v = Math.abs(data[i]);
    if (v > peak) {
      peak = v;
      peakIdx = i;
    }
  }
  // Threshold is generous so quiet pickup still registers.
  if (peak < 0.01 || peakIdx < 0) {
    return {
      success: false,
      roundTripMs: 0,
      peakLevel: peak,
      reason: 'No impulse detected. Place the mic closer to the speaker, raise the input gain, and try again.',
    };
  }
  // Refine: walk back from peak to find the threshold-crossing onset, so we
  // measure first-arrival rather than the loudest reflection.
  const onsetThreshold = Math.max(0.005, peak * 0.25);
  let onsetIdx = peakIdx;
  for (let i = peakIdx; i >= skip; i--) {
    if (Math.abs(data[i]) >= onsetThreshold) onsetIdx = i;
    else break;
  }
  const ms = (onsetIdx / sr) * 1000;
  return { success: true, roundTripMs: ms, peakLevel: peak };
}
