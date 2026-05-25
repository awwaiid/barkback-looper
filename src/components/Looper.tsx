import { useEffect, useState } from 'react';
import { TrackStrip } from './TrackStrip.tsx';
import { TransportBar } from './TransportBar.tsx';
import { TempoBar } from './TempoBar.tsx';
import { AudioSetup } from './AudioSetup.tsx';
import { SettingsPanel } from './SettingsPanel.tsx';
import {
  useAudioStore,
  trackAction,
  clearTrack,
  undoTrack,
  stopAll,
  playAll,
  setSelectedTrack,
  getSelectedTrack,
} from '../audio/store.ts';
import { NUM_TRACKS } from '../audio/types.ts';
import { initMidi, setActionHandlers, type MidiActionHandlers } from '../midi/midi.ts';

export function Looper() {
  const [showSettings, setShowSettings] = useState(false);
  const ready = useAudioStore(s => s.ready);
  const loopFrames = useAudioStore(s => s.loopFrames);
  const track1Mode = useAudioStore(s => s.tracks[0]?.mode);

  useEffect(() => {
    const handlers: Partial<MidiActionHandlers> = {
      'rec-selected': () => trackAction(getSelectedTrack(), 'rec'),
      'stop-selected': () => trackAction(getSelectedTrack(), 'stop'),
      'clear-selected': () => clearTrack(getSelectedTrack()),
      'undo-selected': () => undoTrack(getSelectedTrack()),
      'select-next': () => setSelectedTrack((getSelectedTrack() + 1) % NUM_TRACKS),
      'select-prev': () => setSelectedTrack((getSelectedTrack() - 1 + NUM_TRACKS) % NUM_TRACKS),
      'all-stop': () => stopAll(),
      'all-play': () => playAll(),
      'rec-track-1': () => trackAction(0, 'rec'),
      'rec-track-2': () => trackAction(1, 'rec'),
      'rec-track-3': () => trackAction(2, 'rec'),
      'rec-track-4': () => trackAction(3, 'rec'),
      'stop-track-1': () => trackAction(0, 'stop'),
      'stop-track-2': () => trackAction(1, 'stop'),
      'stop-track-3': () => trackAction(2, 'stop'),
      'stop-track-4': () => trackAction(3, 'stop'),
    };
    setActionHandlers(handlers);
    initMidi();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const key = e.key.toLowerCase();
      if (key >= '1' && key <= '4') {
        const idx = parseInt(key, 10) - 1;
        if (e.shiftKey) {
          if (confirm(`Clear track ${idx + 1}?`)) clearTrack(idx);
        } else {
          setSelectedTrack(idx);
          trackAction(idx, 'rec');
        }
        e.preventDefault();
      } else if (key === 'q' || key === 'w' || key === 'e' || key === 'r') {
        const map: Record<string, number> = { q: 0, w: 1, e: 2, r: 3 };
        trackAction(map[key], 'stop');
        e.preventDefault();
      } else if (key === ' ') {
        stopAll();
        e.preventDefault();
      } else if (key === 'u') {
        undoTrack(getSelectedTrack());
        e.preventDefault();
      } else if (key === 'arrowright') {
        setSelectedTrack((getSelectedTrack() + 1) % NUM_TRACKS);
      } else if (key === 'arrowleft') {
        setSelectedTrack((getSelectedTrack() - 1 + NUM_TRACKS) % NUM_TRACKS);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="looper">
      <header className="app-header">
        <h1>
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" className="app-logo" />
          <span>barkback&nbsp;looper</span>
        </h1>
        <AudioSetup />
        <button className="btn" onClick={() => setShowSettings(s => !s)}>
          {showSettings ? 'Hide Settings' : 'Settings'}
        </button>
      </header>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}

      <TempoBar />
      <TransportBar />

      <div className="tracks">
        {Array.from({ length: NUM_TRACKS }, (_, i) => (
          <TrackStrip key={i} index={i} />
        ))}
      </div>

      <footer className="hints">
        <span><kbd>1</kbd>–<kbd>4</kbd> rec/cycle track</span>
        <span><kbd>Q</kbd>–<kbd>R</kbd> stop track</span>
        <span><kbd>Shift</kbd>+<kbd>1</kbd>–<kbd>4</kbd> clear track</span>
        <span><kbd>U</kbd> undo selected</span>
        <span><kbd>Space</kbd> all stop</span>
        <span><kbd>←</kbd>/<kbd>→</kbd> select track</span>
        {ready && loopFrames === 0 && track1Mode !== 'recording' && (
          <span className="hint-prompt">Hit REC on Track 1 to set the master loop length.</span>
        )}
      </footer>
    </div>
  );
}
