/// <reference types="audioworklet" />

const NUM_TRACKS = 4;
const MAX_LOOP_SECONDS = 120;

type Mode = 'empty' | 'recording' | 'playing' | 'overdub' | 'stopped' | 'armed';
type RecAction = 'rec-play' | 'rec-overdub';
type RecQuantize = 'off' | 'beat' | 'measure';

interface Track {
  mode: Mode;
  bufL: Float32Array | null;
  bufR: Float32Array | null;
  undoL: Float32Array | null;
  undoR: Float32Array | null;
  gain: number;
  peak: number;
  pendingBeats: number; // count-in/quantize countdown; 0 means not pending
}

const makeTrack = (): Track => ({
  mode: 'empty',
  bufL: null,
  bufR: null,
  undoL: null,
  undoR: null,
  gain: 1.0,
  peak: 0,
  pendingBeats: 0,
});

class LooperProcessor extends AudioWorkletProcessor {
  tracks: Track[] = Array.from({ length: NUM_TRACKS }, makeTrack);
  loopFrames = 0;
  playhead = 0;

  // Track 1 grows into these until loop length is locked.
  growL: Float32Array | null = null;
  growR: Float32Array | null = null;
  growIdx = 0;

  monitor = 0;
  inputPeak = 0;

  recAction: RecAction = 'rec-play';
  autoRec = false;
  autoRecThreshold = 0.05;

  // Tempo + metronome
  bpm = 120;
  beatsPerMeasure = 4;
  metronomeOn = false;
  metronomeLevel = 0.4;
  countInMeasures = 0;
  recQuantize: RecQuantize = 'off';
  fixedLoopMeasures = 0;

  framesPerBeat = 0;
  beatFrame = 0;
  beatInMeasure = 0;

  clickActive = false;
  clickPhase = 0;
  clickLength = 0;
  clickFreq = 440;

  meterCounter = 0;
  meterIntervalFrames = 0;

  constructor() {
    super();
    this.meterIntervalFrames = Math.floor(sampleRate / 30);
    this.clickLength = Math.floor(sampleRate * 0.06);
    this.recomputeTempo();
    this.port.onmessage = (e: MessageEvent) => this.onMessage(e.data);
  }

  recomputeTempo() {
    this.framesPerBeat = Math.max(1, Math.floor(sampleRate * 60 / Math.max(20, this.bpm)));
    if (this.beatFrame >= this.framesPerBeat) this.beatFrame = 0;
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
          if (t.mode === 'armed') this.cancelArm(t, this.tracks.indexOf(t));
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
      case 'setRecAction':
        this.recAction = msg.value;
        break;
      case 'setAutoRec':
        this.autoRec = msg.enabled;
        this.autoRecThreshold = msg.threshold;
        break;
      case 'setTempo':
        this.bpm = msg.bpm;
        this.beatsPerMeasure = Math.max(1, msg.beatsPerMeasure);
        this.metronomeOn = msg.metronomeOn;
        this.metronomeLevel = msg.metronomeLevel;
        this.countInMeasures = Math.max(0, msg.countInMeasures);
        this.recQuantize = msg.recQuantize;
        this.fixedLoopMeasures = Math.max(0, msg.fixedLoopMeasures);
        this.recomputeTempo();
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
    t.pendingBeats = 0;
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

  // Compute how many beats to wait before recording starts based on count-in / quantize.
  schedulePendingBeats(): number {
    if (this.countInMeasures > 0) {
      return this.countInMeasures * this.beatsPerMeasure;
    }
    if (this.recQuantize === 'beat') return 1;
    if (this.recQuantize === 'measure') {
      const remaining = this.beatsPerMeasure - this.beatInMeasure;
      return remaining;
    }
    return 0;
  }

  cancelArm(t: Track, idx: number) {
    if (idx === 0 && this.loopFrames === 0) {
      this.growL = null;
      this.growR = null;
      this.growIdx = 0;
    } else {
      t.bufL = null;
      t.bufR = null;
    }
    t.mode = 'empty';
    t.pendingBeats = 0;
  }

  // Allocate buffer for a track and switch to recording state.
  enterRecording(idx: number) {
    const t = this.tracks[idx];
    if (idx === 0 && this.loopFrames === 0) {
      this.growL = new Float32Array(sampleRate * MAX_LOOP_SECONDS);
      this.growR = new Float32Array(sampleRate * MAX_LOOP_SECONDS);
      this.growIdx = 0;
      this.playhead = 0;
    } else if (this.loopFrames > 0) {
      t.bufL = new Float32Array(this.loopFrames);
      t.bufR = new Float32Array(this.loopFrames);
    } else {
      // Should not happen: tracks 2-4 can't record without a master loop yet.
      t.mode = 'empty';
      return;
    }
    t.mode = 'recording';
    t.pendingBeats = 0;
  }

  // Apply the post-record transition based on recAction.
  finishRecord(idx: number) {
    const t = this.tracks[idx];
    if (idx === 0 && this.loopFrames === 0) this.finalizeGrow();
    if (this.recAction === 'rec-overdub') {
      this.snapshot(t);
      t.mode = 'overdub';
    } else {
      t.mode = 'playing';
    }
  }

  cycle(idx: number, action: 'rec' | 'play' | 'stop') {
    const t = this.tracks[idx];

    if (action === 'stop') {
      if (t.mode === 'armed') {
        this.cancelArm(t, idx);
      } else if (t.mode === 'recording' && idx === 0 && this.loopFrames === 0) {
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
      } else if (t.mode === 'armed') {
        this.cancelArm(t, idx);
      }
      this.publishState();
      return;
    }

    // action === 'rec' — main one-button cycle
    if (t.mode === 'empty') {
      // Reject tracks 2-4 attempting to record before track 1 sets the loop.
      if (idx !== 0 && this.loopFrames === 0) {
        this.publishState();
        return;
      }
      const pending = this.schedulePendingBeats();
      if (pending > 0) {
        // Quantize or count-in: just arm; buffer allocates when recording actually starts.
        t.mode = 'armed';
        t.pendingBeats = pending;
      } else if (this.autoRec) {
        // Audio-threshold arm. Allocate buffer now so recording can start the moment audio crosses.
        this.enterRecording(idx);
        t.mode = 'armed';
      } else {
        this.enterRecording(idx);
      }
    } else if (t.mode === 'armed') {
      this.cancelArm(t, idx);
    } else if (t.mode === 'recording') {
      this.finishRecord(idx);
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

    let inPeak = this.inputPeak;
    for (const t of this.tracks) t.peak *= 0.9;
    inPeak *= 0.9;

    const haveLoop = this.loopFrames > 0;
    let ph = this.playhead;

    // Auto-rec trigger: check if any audio-armed track should start now.
    if (hasInput && this.autoRec) {
      let triggered = false;
      for (let i = 0; i < block && !triggered; i++) {
        if (Math.abs(inL[i]) >= this.autoRecThreshold || Math.abs(inR[i]) >= this.autoRecThreshold) {
          triggered = true;
        }
      }
      if (triggered) {
        let changed = false;
        for (const t of this.tracks) {
          // Only audio-armed (no pending beats and buffer already allocated).
          if (t.mode === 'armed' && t.pendingBeats === 0 && (t.bufL !== null || this.growL !== null)) {
            t.mode = 'recording';
            changed = true;
          }
        }
        if (changed) this.publishState();
      }
    }

    let anyActive = false;
    for (const t of this.tracks) {
      if (t.mode === 'playing' || t.mode === 'overdub' || t.mode === 'recording') {
        anyActive = true;
        break;
      }
    }

    // Beat boundary inside this block?
    const framesUntilBeat = this.framesPerBeat - this.beatFrame;
    const beatHitAt = framesUntilBeat < block ? framesUntilBeat : -1;

    // Fixed-length auto-stop for track 1
    const fixedFrames = (this.fixedLoopMeasures > 0 && this.loopFrames === 0)
      ? this.fixedLoopMeasures * this.beatsPerMeasure * this.framesPerBeat
      : 0;

    let fixedAutoFinishPending = false;

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
          if (fixedFrames > 0 && this.growIdx >= fixedFrames) {
            fixedAutoFinishPending = true;
          }
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

      // Beat fires at this sample index
      if (i === beatHitAt) {
        this.beatInMeasure = (this.beatInMeasure + 1) % this.beatsPerMeasure;
        // Trigger metronome click
        if (this.metronomeOn) {
          this.clickActive = true;
          this.clickPhase = 0;
          this.clickFreq = this.beatInMeasure === 0 ? 880 : 440;
        }
        // Advance count-in / quantize countdowns
        for (let ti = 0; ti < NUM_TRACKS; ti++) {
          const t = this.tracks[ti];
          if (t.mode === 'armed' && t.pendingBeats > 0) {
            t.pendingBeats--;
            if (t.pendingBeats === 0) {
              this.enterRecording(ti);
            }
          }
        }
      }

      // Click synthesis (after potential start above)
      if (this.clickActive) {
        const env = Math.exp(-this.clickPhase / (sampleRate * 0.025));
        const v = Math.sin(2 * Math.PI * this.clickFreq * this.clickPhase / sampleRate) * env * this.metronomeLevel;
        mixL += v;
        mixR += v;
        this.clickPhase++;
        if (this.clickPhase >= this.clickLength) this.clickActive = false;
      }

      outL[i] = mixL;
      if (outR !== outL) outR[i] = mixR;
    }

    this.playhead = ph;
    this.inputPeak = inPeak;
    // Advance beat clock by block length
    this.beatFrame = (this.beatFrame + block) % this.framesPerBeat;

    if (fixedAutoFinishPending) {
      this.finishRecord(0);
      this.publishState();
    }

    this.meterCounter += block;
    if (this.meterCounter >= this.meterIntervalFrames) {
      this.meterCounter = 0;
      let countInMs = 0;
      for (const t of this.tracks) {
        if (t.mode === 'armed' && t.pendingBeats > 0) {
          const frames = t.pendingBeats * this.framesPerBeat - this.beatFrame;
          const ms = (frames / sampleRate) * 1000;
          if (ms > countInMs) countInMs = ms;
        }
      }
      this.port.postMessage({
        type: 'meters',
        inputPeak: this.inputPeak,
        trackPeaks: this.tracks.map(t => t.peak),
        playhead: this.playhead,
        loopFrames: this.loopFrames,
        growFrames: this.growIdx,
        beatInMeasure: this.beatInMeasure,
        beatProgress: this.framesPerBeat > 0 ? this.beatFrame / this.framesPerBeat : 0,
        countInRemainingMs: countInMs,
      });
    }

    return true;
  }
}

registerProcessor('looper', LooperProcessor);
