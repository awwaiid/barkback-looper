/// <reference types="audioworklet" />

import { MAX_RECORDING_SECONDS } from './constants.ts';

const NUM_TRACKS = 4;
const MAX_LOOP_SECONDS = MAX_RECORDING_SECONDS;

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
  pendingBeats: number;
  cycles: number;       // 1 means equal to master, 2 means 2x master, etc.
  cycleIndex: number;   // 0..cycles-1
  // Growing-buffer state used during initial recording (before length is locked):
  growL: Float32Array | null;
  growR: Float32Array | null;
  growIdx: number;
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
  cycles: 1,
  cycleIndex: 0,
  growL: null,
  growR: null,
  growIdx: 0,
});

class LooperProcessor extends AudioWorkletProcessor {
  tracks: Track[] = Array.from({ length: NUM_TRACKS }, makeTrack);
  masterFrames = 0;
  playhead = 0; // 0..masterFrames-1

  monitor = 0;
  inputPeak = 0;

  recAction: RecAction = 'rec-play';
  autoRec = false;
  autoRecThreshold = 0.05;

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
  // Time-based exponential decay applied to peak meters each block.
  // Half-life ~150 ms — long enough that transients stay visible, short
  // enough that meters fall back to the noise floor between hits.
  peakDecayPerBlock = 1;

  constructor() {
    super();
    this.meterIntervalFrames = Math.floor(sampleRate / 30);
    this.clickLength = Math.floor(sampleRate * 0.06);
    // Assume Web Audio's standard 128-frame render quantum for decay sizing.
    const blockMs = (128 / sampleRate) * 1000;
    this.peakDecayPerBlock = Math.pow(0.5, blockMs / 150);
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
        this.masterFrames = 0;
        this.playhead = 0;
        this.publishState();
        break;
      case 'undo':
        this.undo(msg.track);
        this.publishState();
        break;
      case 'stopAll':
        for (let i = 0; i < NUM_TRACKS; i++) {
          const t = this.tracks[i];
          if (t.mode === 'recording' || t.mode === 'overdub' || t.mode === 'playing') {
            t.mode = 'stopped';
          }
          if (t.mode === 'armed') this.cancelArm(i);
        }
        this.finalizeAllRecordings();
        this.playhead = 0;
        for (const t of this.tracks) t.cycleIndex = 0;
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
      case 'provideRecBuffers':
        // Main thread pre-allocates per-track recording buffers and
        // transfers them in so we never have to allocate on the audio
        // thread when REC is pressed.
        for (const b of msg.buffers) {
          const t = this.tracks[b.track];
          if (!t) continue;
          // Only adopt while the track is empty — never blow away an
          // active recording or finalized take.
          if (t.mode === 'empty' && !t.bufL) {
            t.growL = new Float32Array(b.l);
            t.growR = new Float32Array(b.r);
            t.growIdx = 0;
          }
        }
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
    if (this.masterFrames === 0) {
      this.port.postMessage({ type: 'buffer', reqId, track: 'mix', l: new ArrayBuffer(0), r: new ArrayBuffer(0), sampleRate });
      return;
    }
    // Use the LCM of all track lengths so each track plays in its entirety,
    // but cap the result at MAX_LOOP_SECONDS to keep coprime cycles
    // (e.g. x7 + x11 = 77 master loops) from allocating gigabytes.
    let total = this.masterFrames;
    for (const t of this.tracks) {
      if (t.bufL) total = lcm(total, t.bufL.length);
    }
    const cap = sampleRate * MAX_LOOP_SECONDS;
    if (total > cap) total = cap;
    const mixL = new Float32Array(total);
    const mixR = new Float32Array(total);
    for (const t of this.tracks) {
      if (!t.bufL || !t.bufR) continue;
      const len = t.bufL.length;
      const g = t.gain;
      for (let i = 0; i < total; i++) {
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
    if (this.masterFrames === 0) {
      this.masterFrames = l.length;
      this.playhead = 0;
    }
    const t = this.tracks[idx];
    t.bufL = l;
    t.bufR = r;
    t.undoL = null;
    t.undoR = null;
    t.mode = 'stopped';
    // Snap loaded buffer length to a multiple of master.
    const c = Math.max(1, Math.round(l.length / this.masterFrames));
    t.cycles = c;
    t.cycleIndex = 0;
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
    t.cycles = 1;
    t.cycleIndex = 0;
    // Keep growL/growR allocated for reuse — they're managed as a pool.
    t.growIdx = 0;
    // Reset the master only when ALL tracks are now empty.
    if (this.tracks.every(tr => tr.mode === 'empty')) {
      this.masterFrames = 0;
      this.playhead = 0;
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

  // Finalize the growing buffer of a track that just stopped recording.
  // Snaps length: track 1 becomes master; tracks 2-4 snap to nearest integer multiple.
  finalizeGrow(idx: number) {
    const t = this.tracks[idx];
    if (!t.growL || t.growIdx === 0) {
      t.growL = null;
      t.growR = null;
      t.growIdx = 0;
      return;
    }
    if (idx === 0 && this.masterFrames === 0) {
      // Track 1 first record: this defines the master length.
      t.bufL = t.growL.slice(0, t.growIdx);
      t.bufR = t.growR!.slice(0, t.growIdx);
      this.masterFrames = t.growIdx;
      t.cycles = 1;
      t.cycleIndex = 0;
      this.playhead = 0;
    } else {
      // Snap to nearest integer multiple of masterFrames (min 1).
      const ratio = t.growIdx / this.masterFrames;
      const cycles = Math.max(1, Math.round(ratio));
      const finalLen = cycles * this.masterFrames;
      const out_l = new Float32Array(finalLen);
      const out_r = new Float32Array(finalLen);
      const copyLen = Math.min(finalLen, t.growIdx);
      out_l.set(t.growL.subarray(0, copyLen));
      out_r.set(t.growR!.subarray(0, copyLen));
      t.bufL = out_l;
      t.bufR = out_r;
      t.cycles = cycles;
      t.cycleIndex = Math.min(t.cycleIndex, cycles - 1);
    }
    t.growL = null;
    t.growR = null;
    t.growIdx = 0;
  }

  finalizeAllRecordings() {
    for (let i = 0; i < NUM_TRACKS; i++) {
      const t = this.tracks[i];
      if (t.growL && t.growIdx > 0) this.finalizeGrow(i);
    }
  }

  // Compute how many beats to wait before recording starts based on count-in / quantize.
  schedulePendingBeats(): number {
    if (this.countInMeasures > 0) {
      return this.countInMeasures * this.beatsPerMeasure;
    }
    if (this.recQuantize === 'beat') return 1;
    if (this.recQuantize === 'measure') {
      return this.beatsPerMeasure - this.beatInMeasure;
    }
    return 0;
  }

  cancelArm(idx: number) {
    const t = this.tracks[idx];
    // Keep growL/growR allocated; just rewind. bufL/R remain null
    // (autoRec arming doesn't capture any useful audio to preserve).
    t.growIdx = 0;
    t.bufL = null;
    t.bufR = null;
    t.mode = 'empty';
    t.pendingBeats = 0;
  }

  // Enter recording state. Reuses the pre-allocated grow buffer if the
  // main thread has transferred one in (the common path — no audio-thread
  // allocation). Falls back to allocating on the audio thread if the
  // pool hasn't arrived yet or got dropped.
  enterRecording(idx: number) {
    const t = this.tracks[idx];
    if (idx !== 0 && this.masterFrames === 0) {
      // Tracks 2-4 cannot record without a master.
      t.mode = 'empty';
      return;
    }
    if (!t.growL || !t.growR) {
      const maxLen = sampleRate * MAX_LOOP_SECONDS;
      t.growL = new Float32Array(maxLen);
      t.growR = new Float32Array(maxLen);
    }
    t.growIdx = 0;
    if (idx === 0 && this.masterFrames === 0) {
      this.playhead = 0;
    } else {
      // Anchor track 2-4 playback to start at the current master position.
      t.cycleIndex = 0;
    }
    t.mode = 'recording';
    t.pendingBeats = 0;
    // Drop any prior finalized buffer (we'll replace on finalize).
    // Undo buffer is preserved.
    t.bufL = null;
    t.bufR = null;
  }

  // For overdub: existing bufL/R, no grow buffer.
  enterOverdub(idx: number) {
    const t = this.tracks[idx];
    this.snapshot(t);
    t.mode = 'overdub';
  }

  // Apply the post-record transition based on recAction.
  finishRecord(idx: number) {
    const t = this.tracks[idx];
    this.finalizeGrow(idx);
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
        this.cancelArm(idx);
      } else if (t.mode === 'recording') {
        this.finalizeGrow(idx);
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
        this.finalizeGrow(idx);
        t.mode = 'playing';
      } else if (t.mode === 'armed') {
        this.cancelArm(idx);
      }
      this.publishState();
      return;
    }

    // action === 'rec' — main one-button cycle
    if (t.mode === 'empty') {
      if (idx !== 0 && this.masterFrames === 0) {
        // Tracks 2-4 cannot record before master is set.
        this.publishState();
        return;
      }
      const pending = this.schedulePendingBeats();
      if (pending > 0) {
        t.mode = 'armed';
        t.pendingBeats = pending;
      } else if (this.autoRec) {
        // Allocate buffer now so input crossing threshold can start recording immediately.
        this.enterRecording(idx);
        t.mode = 'armed';
      } else {
        this.enterRecording(idx);
      }
    } else if (t.mode === 'armed') {
      this.cancelArm(idx);
    } else if (t.mode === 'recording') {
      this.finishRecord(idx);
    } else if (t.mode === 'playing') {
      this.enterOverdub(idx);
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
      hasAudio: t.bufL !== null || (t.growL !== null && t.growIdx > 0),
      gain: t.gain,
      durationFrames: t.bufL ? t.bufL.length : 0,
      canUndo: t.undoL !== null,
      cycles: t.cycles,
      cycleIndex: t.cycleIndex,
    }));
    this.port.postMessage({
      type: 'state',
      tracks,
      loopFrames: this.masterFrames,
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

    const decay = this.peakDecayPerBlock;
    let inPeak = this.inputPeak * decay;
    for (let ti = 0; ti < NUM_TRACKS; ti++) {
      this.tracks[ti].peak *= decay;
    }

    // Auto-rec audio trigger
    if (hasInput && this.autoRec) {
      let triggered = false;
      for (let i = 0; i < block && !triggered; i++) {
        if (Math.abs(inL[i]) >= this.autoRecThreshold || Math.abs(inR[i]) >= this.autoRecThreshold) {
          triggered = true;
        }
      }
      if (triggered) {
        let changed = false;
        for (let ti = 0; ti < NUM_TRACKS; ti++) {
          const t = this.tracks[ti];
          if (t.mode === 'armed' && t.pendingBeats === 0 && t.growL !== null) {
            t.mode = 'recording';
            changed = true;
          }
        }
        if (changed) this.publishState();
      }
    }

    const haveMaster = this.masterFrames > 0;

    let anyActive = false;
    for (const t of this.tracks) {
      if (t.mode === 'playing' || t.mode === 'overdub' || t.mode === 'recording') {
        anyActive = true;
        break;
      }
    }

    // Beat boundary detection
    const framesUntilBeat = this.framesPerBeat - this.beatFrame;
    const beatHitAt = framesUntilBeat < block ? framesUntilBeat : -1;

    // Fixed-length auto-stop for track 1 first-record only
    const fixedFrames = (this.fixedLoopMeasures > 0 && this.masterFrames === 0)
      ? this.fixedLoopMeasures * this.beatsPerMeasure * this.framesPerBeat
      : 0;

    let fixedAutoFinishPending = false;
    let ph = this.playhead;

    for (let i = 0; i < block; i++) {
      const sL = hasInput ? inL[i] : 0;
      const sR = hasInput ? inR[i] : 0;

      const aL = Math.abs(sL);
      const aR = Math.abs(sR);
      const a = aL > aR ? aL : aR;
      if (a > inPeak) inPeak = a;

      let mixL = monitor * sL;
      let mixR = monitor * sR;

      // Each track: playback + record into either grow-buffer or existing buf.
      for (let ti = 0; ti < NUM_TRACKS; ti++) {
        const t = this.tracks[ti];

        // Recording into grow-buffer
        if (t.mode === 'recording' && t.growL) {
          if (t.growIdx < t.growL.length) {
            t.growL[t.growIdx] = sL;
            t.growR![t.growIdx] = sR;
            t.growIdx++;
            if (ti === 0 && fixedFrames > 0 && this.masterFrames === 0 && t.growIdx >= fixedFrames) {
              fixedAutoFinishPending = true;
            }
          }
        }

        // Playback / overdub uses the existing bufL/R aligned to master
        if (haveMaster && t.bufL && t.bufR) {
          const len = t.bufL.length;
          if (len > 0) {
            const trackPos = (t.cycleIndex * this.masterFrames + ph) % len;
            if (t.mode === 'playing' || t.mode === 'overdub') {
              const playL = t.bufL[trackPos] * t.gain;
              const playR = t.bufR[trackPos] * t.gain;
              mixL += playL;
              mixR += playR;
              const tp = Math.max(Math.abs(playL), Math.abs(playR));
              if (tp > t.peak) t.peak = tp;
            }
            if (t.mode === 'overdub') {
              t.bufL[trackPos] = t.bufL[trackPos] + sL;
              t.bufR[trackPos] = t.bufR[trackPos] + sR;
            }
          }
        }
      }

      // Advance master playhead, then handle wrap & cycle increments.
      if (haveMaster && anyActive) {
        ph++;
        if (ph >= this.masterFrames) {
          ph = 0;
          // Master wrapped — advance each track's cycle counter
          for (let ti = 0; ti < NUM_TRACKS; ti++) {
            const t = this.tracks[ti];
            if (t.cycles > 1) {
              t.cycleIndex = (t.cycleIndex + 1) % t.cycles;
            }
          }
        }
      }

      // Beat fires?
      if (i === beatHitAt) {
        this.beatInMeasure = (this.beatInMeasure + 1) % this.beatsPerMeasure;
        if (this.metronomeOn) {
          this.clickActive = true;
          this.clickPhase = 0;
          this.clickFreq = this.beatInMeasure === 0 ? 880 : 440;
        }
        // Count-in / quantize tick
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

      // Click synth
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
    this.beatFrame = (this.beatFrame + block) % this.framesPerBeat;

    if (fixedAutoFinishPending) {
      this.finishRecord(0);
      this.publishState();
    }

    this.meterCounter += block;
    if (this.meterCounter >= this.meterIntervalFrames) {
      this.meterCounter = 0;
      let countInMs = 0;
      const trackProgress: number[] = new Array(NUM_TRACKS);
      for (let ti = 0; ti < NUM_TRACKS; ti++) {
        const t = this.tracks[ti];
        if (t.mode === 'armed' && t.pendingBeats > 0) {
          const frames = t.pendingBeats * this.framesPerBeat - this.beatFrame;
          const ms = (frames / sampleRate) * 1000;
          if (ms > countInMs) countInMs = ms;
        }
        // Per-track progress 0..1 across its entire buffer.
        if (t.bufL && this.masterFrames > 0) {
          const totalLen = t.bufL.length;
          const trackPos = (t.cycleIndex * this.masterFrames + this.playhead) % totalLen;
          trackProgress[ti] = trackPos / totalLen;
        } else if (t.growL && t.growIdx > 0) {
          // While recording: progress relative to growing length so far.
          trackProgress[ti] = 0;
        } else {
          trackProgress[ti] = 0;
        }
      }
      this.port.postMessage({
        type: 'meters',
        inputPeak: this.inputPeak,
        trackPeaks: this.tracks.map(t => t.peak),
        trackProgress,
        playhead: this.playhead,
        loopFrames: this.masterFrames,
        growFrames: this.tracks[0].growIdx,
        beatInMeasure: this.beatInMeasure,
        beatProgress: this.framesPerBeat > 0 ? this.beatFrame / this.framesPerBeat : 0,
        countInRemainingMs: countInMs,
      });
    }

    return true;
  }
}

function gcd(a: number, b: number): number {
  while (b) { [a, b] = [b, a % b]; }
  return a;
}
function lcm(a: number, b: number): number {
  return Math.floor(a / gcd(a, b)) * b;
}

registerProcessor('looper', LooperProcessor);
