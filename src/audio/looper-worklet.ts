/// <reference types="audioworklet" />

const NUM_TRACKS = 4;
const MAX_LOOP_SECONDS = 120;

type Mode = 'empty' | 'recording' | 'playing' | 'overdub' | 'stopped';

interface Track {
  mode: Mode;
  bufL: Float32Array | null;
  bufR: Float32Array | null;
  undoL: Float32Array | null;
  undoR: Float32Array | null;
  gain: number;
  peak: number;
}

const makeTrack = (): Track => ({
  mode: 'empty',
  bufL: null,
  bufR: null,
  undoL: null,
  undoR: null,
  gain: 1.0,
  peak: 0,
});

class LooperProcessor extends AudioWorkletProcessor {
  tracks: Track[] = Array.from({ length: NUM_TRACKS }, makeTrack);
  loopFrames = 0;
  playhead = 0;

  // Track 1 grows into these until loop length is locked.
  growL: Float32Array | null = null;
  growR: Float32Array | null = null;
  growIdx = 0;

  monitor = 0; // 0..1 input passthrough gain
  inputPeak = 0;

  meterCounter = 0;
  meterIntervalFrames = 0;

  constructor() {
    super();
    this.meterIntervalFrames = Math.floor(sampleRate / 30);
    this.port.onmessage = (e: MessageEvent) => this.onMessage(e.data);
  }

  onMessage(msg: any) {
    switch (msg.type) {
      case 'cmd':
        this.cycle(msg.track, msg.action);
        break;
      case 'setGain':
        this.tracks[msg.track].gain = msg.value;
        this.publishState();
        break;
      case 'clear':
        this.clearTrack(msg.track);
        this.publishState();
        break;
      case 'clearAll':
        for (let i = 0; i < NUM_TRACKS; i++) this.clearTrack(i);
        this.loopFrames = 0;
        this.playhead = 0;
        this.publishState();
        break;
      case 'undo':
        this.undo(msg.track);
        this.publishState();
        break;
      case 'stopAll':
        for (const t of this.tracks) {
          if (t.mode === 'recording' || t.mode === 'overdub' || t.mode === 'playing') {
            t.mode = 'stopped';
          }
        }
        this.finalizeGrow();
        this.playhead = 0;
        this.publishState();
        break;
      case 'playAll':
        for (const t of this.tracks) {
          if (t.mode === 'stopped') t.mode = 'playing';
        }
        this.publishState();
        break;
      case 'setMonitor':
        this.monitor = msg.value;
        break;
      case 'getBuffer':
        this.sendBuffer(msg.track, msg.reqId);
        break;
      case 'getMix':
        this.sendMix(msg.reqId);
        break;
      case 'loadBuffer':
        this.loadBuffer(msg.track, msg.l, msg.r);
        break;
    }
  }

  sendBuffer(idx: number, reqId: number) {
    const t = this.tracks[idx];
    if (!t.bufL || !t.bufR) {
      this.port.postMessage({ type: 'buffer', reqId, track: idx, l: new ArrayBuffer(0), r: new ArrayBuffer(0), sampleRate });
      return;
    }
    const l = new Float32Array(t.bufL).buffer;
    const r = new Float32Array(t.bufR).buffer;
    this.port.postMessage(
      { type: 'buffer', reqId, track: idx, l, r, sampleRate },
      [l, r],
    );
  }

  sendMix(reqId: number) {
    if (this.loopFrames === 0) {
      this.port.postMessage({ type: 'buffer', reqId, track: 'mix', l: new ArrayBuffer(0), r: new ArrayBuffer(0), sampleRate });
      return;
    }
    const mixL = new Float32Array(this.loopFrames);
    const mixR = new Float32Array(this.loopFrames);
    for (const t of this.tracks) {
      if (!t.bufL || !t.bufR) continue;
      const len = t.bufL.length;
      const g = t.gain;
      for (let i = 0; i < this.loopFrames; i++) {
        const pos = i % len;
        mixL[i] += t.bufL[pos] * g;
        mixR[i] += t.bufR[pos] * g;
      }
    }
    this.port.postMessage(
      { type: 'buffer', reqId, track: 'mix', l: mixL.buffer, r: mixR.buffer, sampleRate },
      [mixL.buffer, mixR.buffer],
    );
  }

  loadBuffer(idx: number, lBuf: ArrayBuffer, rBuf: ArrayBuffer) {
    const l = new Float32Array(lBuf);
    const r = new Float32Array(rBuf);
    if (l.length === 0) return;
    if (this.loopFrames === 0) {
      this.loopFrames = l.length;
      this.playhead = 0;
    }
    const t = this.tracks[idx];
    t.bufL = l;
    t.bufR = r;
    t.undoL = null;
    t.undoR = null;
    t.mode = 'stopped';
    this.publishState();
  }

  clearTrack(idx: number) {
    const t = this.tracks[idx];
    t.mode = 'empty';
    t.bufL = null;
    t.bufR = null;
    t.undoL = null;
    t.undoR = null;
    t.peak = 0;
    if (idx === 0 && this.tracks.every(tr => tr.mode === 'empty')) {
      this.loopFrames = 0;
      this.playhead = 0;
      this.growL = null;
      this.growR = null;
      this.growIdx = 0;
    }
  }

  undo(idx: number) {
    const t = this.tracks[idx];
    if (t.undoL && t.undoR) {
      const prevL = t.bufL;
      const prevR = t.bufR;
      t.bufL = t.undoL;
      t.bufR = t.undoR;
      t.undoL = prevL;
      t.undoR = prevR;
    }
  }

  snapshot(t: Track) {
    if (t.bufL && t.bufR) {
      t.undoL = new Float32Array(t.bufL);
      t.undoR = new Float32Array(t.bufR);
    }
  }

  finalizeGrow() {
    if (this.loopFrames === 0 && this.growL && this.growIdx > 0) {
      const t = this.tracks[0];
      t.bufL = this.growL.slice(0, this.growIdx);
      t.bufR = this.growR!.slice(0, this.growIdx);
      this.loopFrames = this.growIdx;
      this.growL = null;
      this.growR = null;
      this.growIdx = 0;
      this.playhead = 0;
    }
  }

  cycle(idx: number, action: 'rec' | 'play' | 'stop') {
    const t = this.tracks[idx];

    if (action === 'stop') {
      if (t.mode === 'recording' && idx === 0 && this.loopFrames === 0) {
        this.finalizeGrow();
        t.mode = 'stopped';
      } else if (t.mode !== 'empty') {
        t.mode = 'stopped';
      }
      this.publishState();
      return;
    }

    if (action === 'play') {
      if (t.mode === 'stopped' || t.mode === 'overdub') t.mode = 'playing';
      else if (t.mode === 'recording') {
        if (idx === 0 && this.loopFrames === 0) this.finalizeGrow();
        t.mode = 'playing';
      }
      this.publishState();
      return;
    }

    // action === 'rec' — main one-button cycle
    if (t.mode === 'empty') {
      if (idx === 0 && this.loopFrames === 0) {
        // Track 1 defines master loop length.
        this.growL = new Float32Array(sampleRate * MAX_LOOP_SECONDS);
        this.growR = new Float32Array(sampleRate * MAX_LOOP_SECONDS);
        this.growIdx = 0;
        this.playhead = 0;
        t.mode = 'recording';
      } else if (this.loopFrames > 0) {
        t.bufL = new Float32Array(this.loopFrames);
        t.bufR = new Float32Array(this.loopFrames);
        t.mode = 'recording';
      }
      // else: tracks 2-4 can't record before track 1 sets the loop
    } else if (t.mode === 'recording') {
      // First tap after starting record exits recording into playback.
      // The loop is now established; a second tap will enter overdub.
      if (idx === 0 && this.loopFrames === 0) this.finalizeGrow();
      t.mode = 'playing';
    } else if (t.mode === 'playing') {
      this.snapshot(t);
      t.mode = 'overdub';
    } else if (t.mode === 'overdub') {
      t.mode = 'playing';
    } else if (t.mode === 'stopped') {
      t.mode = 'playing';
    }
    this.publishState();
  }

  publishState() {
    const tracks = this.tracks.map(t => ({
      mode: t.mode,
      hasAudio: t.bufL !== null || (this.tracks[0] === t && this.growL !== null && this.growIdx > 0),
      gain: t.gain,
      durationFrames: t.bufL ? t.bufL.length : 0,
      canUndo: t.undoL !== null,
    }));
    this.port.postMessage({
      type: 'state',
      tracks,
      loopFrames: this.loopFrames,
      playhead: this.playhead,
      sampleRate,
    });
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0] ?? [];
    const output = outputs[0];
    const outL = output[0];
    const outR = output[1] ?? output[0];
    const block = outL.length;

    const inL = input[0];
    const inR = input[1] ?? input[0];

    const hasInput = !!inL;
    const monitor = this.monitor;

    // reset per-block peak tracking
    let inPeak = this.inputPeak;
    for (const t of this.tracks) {
      // decay peaks
      t.peak *= 0.9;
    }
    inPeak *= 0.9;

    const haveLoop = this.loopFrames > 0;
    let ph = this.playhead;

    let anyActive = false;
    for (const t of this.tracks) {
      if (t.mode === 'playing' || t.mode === 'overdub' || t.mode === 'recording') {
        anyActive = true;
        break;
      }
    }

    for (let i = 0; i < block; i++) {
      const sL = hasInput ? inL[i] : 0;
      const sR = hasInput ? inR[i] : 0;

      const aL = Math.abs(sL);
      const aR = Math.abs(sR);
      const a = aL > aR ? aL : aR;
      if (a > inPeak) inPeak = a;

      let mixL = monitor * sL;
      let mixR = monitor * sR;

      // Track 1 growing into its buffer until loop length locks.
      if (!haveLoop && this.tracks[0].mode === 'recording' && this.growL) {
        if (this.growIdx < this.growL.length) {
          this.growL[this.growIdx] = sL;
          this.growR![this.growIdx] = sR;
          this.growIdx++;
        }
      }

      if (haveLoop) {
        for (let ti = 0; ti < NUM_TRACKS; ti++) {
          const t = this.tracks[ti];
          if (!t.bufL || !t.bufR) continue;
          const len = t.bufL.length;
          if (len === 0) continue;
          const pos = ph % len;

          if (t.mode === 'playing' || t.mode === 'overdub' || t.mode === 'recording') {
            const playL = t.bufL[pos] * t.gain;
            const playR = t.bufR[pos] * t.gain;
            mixL += playL;
            mixR += playR;
            const tp = Math.max(Math.abs(playL), Math.abs(playR));
            if (tp > t.peak) t.peak = tp;
          }
          if (t.mode === 'recording' || t.mode === 'overdub') {
            t.bufL[pos] = t.bufL[pos] + sL;
            t.bufR[pos] = t.bufR[pos] + sR;
          }
        }
        if (anyActive) {
          ph = (ph + 1) % this.loopFrames;
        }
      }

      outL[i] = mixL;
      if (outR !== outL) outR[i] = mixR;
    }

    this.playhead = ph;
    this.inputPeak = inPeak;

    this.meterCounter += block;
    if (this.meterCounter >= this.meterIntervalFrames) {
      this.meterCounter = 0;
      this.port.postMessage({
        type: 'meters',
        inputPeak: this.inputPeak,
        trackPeaks: this.tracks.map(t => t.peak),
        playhead: this.playhead,
        loopFrames: this.loopFrames,
        growFrames: this.growIdx,
      });
    }

    return true;
  }
}

registerProcessor('looper', LooperProcessor);
