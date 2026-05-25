import { useRef } from 'react';
import {
  useAudioStore,
  trackAction,
  clearTrack,
  undoTrack,
  setTrackGain,
  setSelectedTrack,
  selectLoopProgress,
} from '../audio/store.ts';
import { exportTrackWav } from '../audio/storage.ts';

interface Props {
  index: number;
}

const MODE_LABEL: Record<string, string> = {
  empty: 'empty',
  recording: 'REC',
  playing: 'PLAY',
  overdub: 'OVERDUB',
  stopped: 'stopped',
};

const MODE_CLASS: Record<string, string> = {
  empty: 'mode-empty',
  recording: 'mode-rec',
  playing: 'mode-play',
  overdub: 'mode-overdub',
  stopped: 'mode-stop',
};

const recordLabel = (mode: string): string => {
  switch (mode) {
    case 'empty': return 'REC';
    case 'recording': return 'OVERDUB';
    case 'playing': return 'OVERDUB';
    case 'overdub': return 'PLAY';
    case 'stopped': return 'PLAY';
    default: return 'REC';
  }
};

const peakToPct = (peak: number): number => {
  if (peak < 0.0001) return 0;
  const db = Math.max(-60, 20 * Math.log10(peak));
  return Math.max(0, Math.min(100, (db + 60) / 60 * 100));
};

export function TrackStrip({ index }: Props) {
  const track = useAudioStore(s => s.tracks[index]);
  const peak = useAudioStore(s => s.trackPeaks[index] ?? 0);
  const selected = useAudioStore(s => s.selectedTrack === index);
  const loopFrames = useAudioStore(s => s.loopFrames);
  const progress = useAudioStore(selectLoopProgress);

  const lastTapRef = useRef(0);
  const showProgress = track.hasAudio && !(track.mode === 'recording' && loopFrames === 0);

  const onSelectClick = () => setSelectedTrack(index);

  const onModeDoubleClick = () => {
    const now = performance.now();
    if (now - lastTapRef.current < 400 && track.hasAudio) {
      if (confirm(`Clear track ${index + 1}?`)) clearTrack(index);
    }
    lastTapRef.current = now;
  };

  return (
    <div
      className={`track-strip ${selected ? 'selected' : ''} ${MODE_CLASS[track.mode] ?? ''}`}
      onClick={onSelectClick}
    >
      <div className="track-head" onDoubleClick={onModeDoubleClick}>
        <span className="track-num">{index + 1}</span>
        <span className={`track-mode ${MODE_CLASS[track.mode]}`}>{MODE_LABEL[track.mode]}</span>
      </div>

      <div className="waveform" aria-label="loop progress">
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

      <div className="fader-row">
        <span className="fader-label">vol</span>
        <input
          type="range"
          min="0"
          max="1.5"
          step="0.01"
          value={track.gain}
          onChange={(e) => setTrackGain(index, parseFloat(e.currentTarget.value))}
        />
        <span className="fader-val">{(track.gain * 100).toFixed(0)}</span>
      </div>

      <div className="track-buttons">
        <button
          className="btn btn-rec"
          onClick={(e) => { e.stopPropagation(); trackAction(index, 'rec'); }}
        >
          {recordLabel(track.mode)}
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
