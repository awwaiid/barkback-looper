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
  // Master playhead position at REC tap (minus latency compensation), so
  // playback can align the recorded audio with what the user was hearing
  // when they tapped REC. Always 0 for track 1's first record and for any
  // track recorded before the master is established.
  anchor: number;
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
  anchor: 0,
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

  // Round-trip latency compensation: shift recordings backwards in time by
  // this many frames. Applied via the track anchor (for first records of
  // tracks 2-4, so playback aligns with what the user was hearing) and via
  // the overdub write offset (so overlaid notes land where their cue was).
  latencyCompFrames = 0;

  // Acoustic loopback latency test state
  testPhase: 'idle' | 'running' = 'idle';
  testBuffer: Float32Array | null = null;
  testSampleIdx = 0;
  testImpulseLen = 0;
  testCaptureLen = 0;
  testReqId = 0;
  testMonitorBackup = 0;

  clickActive = false;
  clickPhase = 0;
  clickLength = 0;
  clickFreq = 440;

  meterCounter = 0;
  meterIntervalFrames = 0;
  peakDecayPerBlock = 1;

  // CPU usage instrumentation
  cpuSumMs = 0;       // sum of process() times since last meter
  cpuCount = 0;       // # process() calls since last meter
  cpuMaxMs = 0;       // worst process() time since last meter
  cpuBudgetMs = 0;    // budget = block / sampleRate (most recent)
  cpuOverruns = 0;    // lifetime overrun count

  constructor() {
    super();
    this.meterIntervalFrames = Math.floor(sampleRate / 30);
    this.clickLength = Math.floor(sampleRate * 0.06);
    const blockMs = (128 / sampleRate) * 1000;
    this.peakDecayPerBlock = Math.pow(0.5, blockMs / 150);
    this.recomputeTempo();
    this.port.onmessage = (e: MessageEvent) => this.onMessage(e.data);
  }

  beginLatencyTest(reqId: number) {
    if (this.testPhase === 'running') return;
    this.testImpulseLen = Math.floor(sampleRate * 0.005); // 5 ms tone burst
    this.testCaptureLen = Math.floor(sampleRate * 0.15);  // 150 ms total capture
    // 150 ms is enough for any realistic round trip (USB interfaces top out
    // around 30-40 ms; consumer onboard is 60-100 ms). Shorter capture =
    // faster turnaround when the user clicks Measure.
    this.testBuffer = new Float32Array(this.testCaptureLen);
    this.testSampleIdx = 0;
    this.testReqId = reqId;
    this.testMonitorBackup = this.monitor;
    this.monitor = 0; // avoid feeding live input back during the test
    this.testPhase = 'running';
  }

  endLatencyTest() {
    if (!this.testBuffer) {
      this.testPhase = 'idle';
      return;
    }
    const buf = this.testBuffer.buffer;
    this.testBuffer = null;
    this.testPhase = 'idle';
    this.monitor = this.testMonitorBackup;
    this.port.postMessage(
      {
        type: 'latencyTestResult',
        reqId: this.testReqId,
        buffer: buf,
        sampleRate,
        impulseStartFrame: 0,
      },
      [buf],
    );
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
      case 'setLatencyCompensation': {
        const frames = Math.floor((msg.ms / 1000) * sampleRate);
        // Cap compensation at 1 s; anything larger doesn't represent a sane
        // audio interface round-trip and would just confuse the alignment.
        this.latencyCompFrames = Math.max(0, Math.min(sampleRate, frames));
        break;
      }
      case 'startLatencyTest':
        this.beginLatencyTest(msg.reqId);
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
    t.anchor = 0;
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
      // Two-state swap: toggle between the most recent overdub layer and
      // the version just before it.
      const prevL = t.bufL;
      const prevR = t.bufR;
      t.bufL = t.undoL;
      t.bufR = t.undoR;
      t.undoL = prevL;
      t.undoR = prevR;
    } else if (t.bufL) {
      // Initial recording has no prior version to swap back to, so undo is
      // equivalent to clearing the track.
      this.clearTrack(idx);
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
      t.anchor = 0;
    } else {
      // Anchor track 2-4 playback to the current master position less the
      // round-trip latency. On playback, buffer[0] will play at this anchor,
      // which corresponds to the moment in the master loop the user was
      // hearing when they tapped REC — so the recording aligns with what
      // they played along with.
      t.cycleIndex = 0;
      t.anchor = ((this.playhead - this.latencyCompFrames) % this.masterFrames + this.masterFrames) % this.masterFrames;
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
      // Undo is available whenever there's a swap snapshot (post-overdub)
      // OR a finalized recording (the initial take, which undo will clear).
      canUndo: t.undoL !== null || t.bufL !== null,
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
    // performance.now() is not guaranteed in AudioWorkletGlobalScope; feature-detect
    // and silently skip CPU measurement if it's not there.
    const perf = (globalThis as any).performance;
    const hasPerf = perf && typeof perf.now === 'function';
    const cpuT0 = hasPerf ? perf.now() : 0;
    const result = this.doProcess(inputs, outputs);
    if (hasPerf) {
      const dtMs = perf.now() - cpuT0;
      const block = (outputs[0]?.[0]?.length) ?? 128;
      const budget = (block / sampleRate) * 1000;
      this.cpuBudgetMs = budget;
      this.cpuSumMs += dtMs;
      this.cpuCount++;
      if (dtMs > this.cpuMaxMs) this.cpuMaxMs = dtMs;
      if (dtMs > budget) this.cpuOverruns++;
    }
    return result;
  }

  doProcess(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0] ?? [];
    const output = outputs[0];
    const outL = output[0];
    const outR = output[1] ?? output[0];
    const block = outL.length;

    const inL = input[0];
    const inR = input[1] ?? input[0];

    const hasInput = !!inL;
    const monitor = this.monitor;

    // ---- Acoustic latency test fast path ----
    // Emits a short 1 kHz tone burst on output, records 150 ms of input,
    // then ships the captured buffer back to the main thread for analysis.
    if (this.testPhase === 'running' && this.testBuffer) {
      for (let i = 0; i < block; i++) {
        if (this.testSampleIdx >= this.testCaptureLen) {
          outL[i] = 0;
          if (outR !== outL) outR[i] = 0;
          continue;
        }
        const inSample = hasInput ? inL[i] : 0;
        this.testBuffer[this.testSampleIdx] = inSample;
        if (this.testSampleIdx < this.testImpulseLen) {
          const n = this.testSampleIdx;
          const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / this.testImpulseLen);
          const tone = Math.sin((2 * Math.PI * 1000 * n) / sampleRate);
          const v = 0.5 * win * tone;
          outL[i] = v;
          if (outR !== outL) outR[i] = v;
        } else {
          outL[i] = 0;
          if (outR !== outL) outR[i] = 0;
        }
        this.testSampleIdx++;
        if (this.testSampleIdx >= this.testCaptureLen) {
          this.endLatencyTest();
        }
      }
      return true;
    }

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

    const compFrames = this.latencyCompFrames;

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

        // Playback / overdub uses the existing bufL/R aligned to master.
        // The anchor rotates the buffer so buffer[0] plays at the master
        // position the user was hearing when they tapped REC.
        if (haveMaster && t.bufL && t.bufR) {
          const len = t.bufL.length;
          if (len > 0) {
            const M = this.masterFrames;
            const a = t.anchor;
            const virtualPos = a === 0 ? ph : (ph - a + M) % M;
            // cycleIndex increments at master pos 0, but for anchored tracks
            // the effective "track cycle" turns over at master pos = anchor.
            // When ph is still below anchor, we're one effective cycle behind.
            const cyc = t.cycles;
            const effCycle = (a !== 0 && ph < a)
              ? ((t.cycleIndex - 1) % cyc + cyc) % cyc
              : t.cycleIndex;
            const trackPos = (effCycle * M + virtualPos) % len;
            if (t.mode === 'playing' || t.mode === 'overdub') {
              const playL = t.bufL[trackPos] * t.gain;
              const playR = t.bufR[trackPos] * t.gain;
              mixL += playL;
              mixR += playR;
              const tp = Math.max(Math.abs(playL), Math.abs(playR));
              if (tp > t.peak) t.peak = tp;
            }
            if (t.mode === 'overdub') {
              // Shift the write back by compFrames so the user's input
              // lands at the same buffer position as the playback they
              // were reacting to was emitted from.
              const odPos = compFrames > 0
                ? (trackPos - compFrames + len) % len
                : trackPos;
              t.bufL[odPos] = t.bufL[odPos] + sL;
              t.bufR[odPos] = t.bufR[odPos] + sR;
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
        // Per-track progress 0..1 across its entire buffer (anchor-aware).
        if (t.bufL && this.masterFrames > 0) {
          const totalLen = t.bufL.length;
          const M = this.masterFrames;
          const a = t.anchor;
          const ph2 = this.playhead;
          const virtualPos = a === 0 ? ph2 : (ph2 - a + M) % M;
          const cyc = t.cycles;
          const effCycle = (a !== 0 && ph2 < a)
            ? ((t.cycleIndex - 1) % cyc + cyc) % cyc
            : t.cycleIndex;
          const trackPos = (effCycle * M + virtualPos) % totalLen;
          trackProgress[ti] = trackPos / totalLen;
        } else if (t.growL && t.growIdx > 0) {
          // While recording: progress relative to growing length so far.
          trackProgress[ti] = 0;
        } else {
          trackProgress[ti] = 0;
        }
      }
      const cpuBudget = this.cpuBudgetMs > 0 ? this.cpuBudgetMs : (128 / sampleRate) * 1000;
      const cpuAvg = this.cpuCount > 0 ? (this.cpuSumMs / this.cpuCount) / cpuBudget : 0;
      const cpuMax = this.cpuMaxMs / cpuBudget;
      this.cpuSumMs = 0;
      this.cpuCount = 0;
      this.cpuMaxMs = 0;

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
        cpuAvgPct: cpuAvg * 100,
        cpuMaxPct: cpuMax * 100,
        cpuOverruns: this.cpuOverruns,
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
