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
  const [showTempo, setShowTempo] = useState(false);
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
    // Number row triggers rec/play/overdub. Match both the digits and their
    // shifted symbols so it works regardless of keyboard layout (some layouts
    // require Shift to type a number, yielding the symbol instead).
    const numMap: Record<string, number> = {
      '1': 0, '2': 1, '3': 2, '4': 3,
      '!': 0, '@': 1, '#': 2, '$': 3,
    };
    const qwerMap: Record<string, number> = { q: 0, w: 1, e: 2, r: 3 };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const key = e.key;
      const lower = key.toLowerCase();
      if (key in numMap) {
        const idx = numMap[key];
        setSelectedTrack(idx);
        trackAction(idx, 'rec');
        e.preventDefault();
      } else if (lower in qwerMap) {
        const idx = qwerMap[lower];
        if (e.shiftKey) {
          if (confirm(`Clear track ${idx + 1}?`)) clearTrack(idx);
        } else {
          trackAction(idx, 'stop');
        }
        e.preventDefault();
      } else if (key === ' ') {
        stopAll();
        e.preventDefault();
      } else if (lower === 'u') {
        undoTrack(getSelectedTrack());
        e.preventDefault();
      } else if (lower === 'arrowright') {
        setSelectedTrack((getSelectedTrack() + 1) % NUM_TRACKS);
      } else if (lower === 'arrowleft') {
        setSelectedTrack((getSelectedTrack() - 1 + NUM_TRACKS) % NUM_TRACKS);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div
      className="looper"
      // Suppress the long-press / right-click context menu so a held
      // touch on a fader or button doesn't pop up "save image", etc.
      onContextMenu={(e) => e.preventDefault()}
    >
      <header className="app-header">
        <h1>
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" className="app-logo" />
          <span>barkback&nbsp;looper</span>
        </h1>
        <AudioSetup />
        <button
          className={`btn btn-metronome-toggle ${showTempo ? 'on' : ''}`}
          onClick={() => setShowTempo(s => !s)}
          aria-pressed={showTempo}
          aria-label="Toggle metronome bar"
          title="Metronome"
        >
          <svg className="metronome-icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6 1.5h4l3 13H3z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            <line x1="8" y1="13" x2="11" y2="4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <circle cx="10.4" cy="6" r="1.1" fill="currentColor" />
          </svg>
          <span>Metronome</span>
        </button>
        <button className="btn" onClick={() => setShowSettings(s => !s)}>
          {showSettings ? 'Hide Settings' : 'Settings'}
        </button>
      </header>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}

      {showTempo && <TempoBar />}
      <TransportBar />

      <div className="tracks">
        {Array.from({ length: NUM_TRACKS }, (_, i) => (
          <TrackStrip key={i} index={i} />
        ))}
      </div>

      <footer className="hints">
        <span><kbd>1</kbd>–<kbd>4</kbd> rec/cycle track</span>
        <span><kbd>Q</kbd>–<kbd>R</kbd> stop track</span>
        <span><kbd>Shift</kbd>+<kbd>Q</kbd>–<kbd>R</kbd> clear track</span>
        <span><kbd>U</kbd> undo selected</span>
        <span><kbd>Space</kbd> all stop</span>
        <span><kbd>←</kbd>/<kbd>→</kbd> select track</span>
        {ready && loopFrames === 0 && track1Mode !== 'recording' && (
          <span className="hint-prompt">Hit REC on Track 1 to set the master loop length.</span>
        )}
        <a
          className="repo-link"
          href="https://github.com/awwaiid/barkback-looper"
          target="_blank"
          rel="noreferrer"
          aria-label="View project on GitHub"
          title="View project on GitHub"
        >
          <svg className="repo-icon" viewBox="0 0 16 16" aria-hidden="true">
            <path
              fill="currentColor"
              d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
            />
          </svg>
        </a>
      </footer>
    </div>
  );
}
