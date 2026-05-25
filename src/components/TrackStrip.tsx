import { useEffect, useRef } from 'react';
import {
  useAudioStore,
  trackAction,
  clearTrack,
  undoTrack,
  setTrackGain,
  setSelectedTrack,
} from '../audio/store.ts';
import { exportTrackWav } from '../audio/storage.ts';
import { useSettingsStore } from '../settings/settings.ts';
import { peakToPct } from '../audio/meter.ts';
import { Fader } from './Fader.tsx';

interface Props {
  index: number;
}

const MODE_LABEL: Record<string, string> = {
  empty: 'empty',
  armed: 'ARMED',
  recording: 'REC',
  playing: 'PLAY',
  overdub: 'OVERDUB',
  stopped: 'stopped',
};

const MODE_CLASS: Record<string, string> = {
  empty: 'mode-empty',
  armed: 'mode-armed',
  recording: 'mode-rec',
  playing: 'mode-play',
  overdub: 'mode-overdub',
  stopped: 'mode-stop',
};

const recordLabel = (mode: string, recAction: 'rec-play' | 'rec-overdub'): string => {
  switch (mode) {
    case 'empty': return 'REC';
    case 'armed': return 'cancel';
    case 'recording': return recAction === 'rec-overdub' ? 'OVERDUB' : 'PLAY';
    case 'playing': return 'OVERDUB';
    case 'overdub': return 'PLAY';
    case 'stopped': return 'PLAY';
    default: return 'REC';
  }
};

export function TrackStrip({ index }: Props) {
  const track = useAudioStore(s => s.tracks[index]);
  const peak = useAudioStore(s => s.trackPeaks[index] ?? 0);
  const selected = useAudioStore(s => s.selectedTrack === index);
  const loopFrames = useAudioStore(s => s.loopFrames);
  const progress = useAudioStore(s => s.trackProgress[index] ?? 0);
  const waveform = useAudioStore(s => s.trackWaveforms[index]);
  const recAction = useSettingsStore(s => s.recAction);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const showProgress = track.hasAudio && !(track.mode === 'recording' && loopFrames === 0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!waveform || waveform.length === 0) return;
    const mid = canvas.height / 2;
    const w = canvas.width;
    const colWidth = w / waveform.length;
    // Use track color hint based on mode
    let color = 'rgba(108, 140, 255, 0.55)';
    if (track.mode === 'recording' || track.mode === 'overdub') color = 'rgba(255, 71, 87, 0.65)';
    else if (track.mode === 'playing') color = 'rgba(45, 212, 126, 0.6)';
    else if (track.mode === 'stopped') color = 'rgba(180, 188, 210, 0.45)';
    ctx.fillStyle = color;
    for (let i = 0; i < waveform.length; i++) {
      const h = Math.max(1, waveform[i] * canvas.height);
      const x = Math.floor(i * colWidth);
      const cw = Math.max(1, Math.floor(colWidth) - 1);
      ctx.fillRect(x, mid - h / 2, cw, h);
    }
  }, [waveform, track.mode]);

  const onSelectClick = () => setSelectedTrack(index);

  // Double-tap the strip header to clear.
  const onHeaderDoubleClick = () => {
    if (track.hasAudio && confirm(`Clear track ${index + 1}?`)) clearTrack(index);
  };

  return (
    <div
      className={`track-strip ${selected ? 'selected' : ''} ${MODE_CLASS[track.mode] ?? ''}`}
      onClick={onSelectClick}
    >
      <div className="track-head" onDoubleClick={onHeaderDoubleClick}>
        <span className="track-num">{index + 1}</span>
        {track.cycles > 1 && (
          <span className="track-cycles" title={`${track.cycles}× master loop`}>
            ×{track.cycles}
          </span>
        )}
        <span className={`track-mode ${MODE_CLASS[track.mode]}`}>{MODE_LABEL[track.mode]}</span>
      </div>

      <div className="waveform" aria-label="loop waveform">
        <canvas ref={canvasRef} className="waveform-canvas" />
        {showProgress && (
          <div className="waveform-playhead" style={{ left: `${progress * 100}%` }} />
        )}
        {showProgress && (
          <div className="waveform-fill" style={{ width: `${progress * 100}%` }} />
        )}
        {track.mode === 'recording' && loopFrames === 0 && (
          <div className="waveform-rec-pulse" />
        )}
      </div>

      <div className="meter">
        <div className="meter-fill" style={{ width: `${peakToPct(peak)}%` }} />
      </div>

      <Fader
        value={track.gain}
        max={1.5}
        unity={1.0}
        onChange={(v) => setTrackGain(index, v)}
        label={`track ${index + 1} volume`}
      />

      <div className="track-buttons">
        <button
          className="btn btn-rec"
          onClick={(e) => { e.stopPropagation(); trackAction(index, 'rec'); }}
        >
          {recordLabel(track.mode, recAction)}
        </button>
        <button
          className="btn btn-stop"
          disabled={track.mode === 'empty'}
          onClick={(e) => { e.stopPropagation(); trackAction(index, 'stop'); }}
        >
          STOP
        </button>
        <button
          className="btn btn-undo"
          disabled={!track.canUndo}
          onClick={(e) => { e.stopPropagation(); undoTrack(index); }}
        >
          UNDO
        </button>
        <button
          className="btn btn-clear"
          disabled={!track.hasAudio}
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`Clear track ${index + 1}?`)) clearTrack(index);
          }}
        >
          CLR
        </button>
      </div>

      <button
        className="btn btn-sm track-export"
        disabled={!track.hasAudio}
        title="Download as WAV"
        onClick={(e) => { e.stopPropagation(); exportTrackWav(index); }}
      >
        ↓ .wav
      </button>
    </div>
  );
}
