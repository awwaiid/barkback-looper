import type { BufferReply, EngineState, MetersData, TrackAction, WorkletCommand } from './types.ts';
import { NUM_TRACKS } from './types.ts';
import { MAX_RECORDING_SECONDS } from './constants.ts';
import workletUrl from './looper-worklet.ts?worker&url';

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

  private provideRecBuffers(sampleRate: number) {
    if (!this.node) return;
    const bytes = sampleRate * MAX_RECORDING_SECONDS * 4;
    const buffers: { track: number; l: ArrayBuffer; r: ArrayBuffer }[] = [];
    const transfers: ArrayBuffer[] = [];
    for (let i = 0; i < NUM_TRACKS; i++) {
      const l = new ArrayBuffer(bytes);
      const r = new ArrayBuffer(bytes);
      buffers.push({ track: i, l, r });
      transfers.push(l, r);
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

  cmd(track: number, action: TrackAction) { this.send({ type: 'cmd', track, action }); }
  setGain(track: number, value: number) { this.send({ type: 'setGain', track, value }); }
  clear(track: number) { this.send({ type: 'clear', track }); }
  clearAll() { this.send({ type: 'clearAll' }); }
  undo(track: number) { this.send({ type: 'undo', track }); }
  stopAll() { this.send({ type: 'stopAll' }); }
  playAll() { this.send({ type: 'playAll' }); }
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
}
