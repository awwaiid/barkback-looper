import { create } from 'zustand';
import { NUM_TRACKS } from '../audio/types.ts';

export type RecAction = 'rec-play' | 'rec-overdub';
export type TrackPlayMode = 'multi' | 'single';
export type RecQuantize = 'off' | 'beat' | 'measure';

export interface Settings {
  recAction: RecAction;
  trackPlayMode: TrackPlayMode;
  allStopTargets: boolean[];
  allPlayTargets: boolean[];
  autoRec: boolean;
  autoRecThreshold: number;
  bpm: number;
  beatsPerMeasure: number;
  metronomeOn: boolean;
  metronomeLevel: number;       // 0..1
  countInMeasures: number;      // 0, 1, or 2
  recQuantize: RecQuantize;
  fixedLoopMeasures: number;    // 0 = auto, else fixed
}

const DEFAULTS: Settings = {
  recAction: 'rec-play',
  trackPlayMode: 'multi',
  allStopTargets: Array.from({ length: NUM_TRACKS }, () => true),
  allPlayTargets: Array.from({ length: NUM_TRACKS }, () => true),
  autoRec: false,
  autoRecThreshold: 0.05,
  bpm: 120,
  beatsPerMeasure: 4,
  metronomeOn: false,
  metronomeLevel: 0.4,
  countInMeasures: 0,
  recQuantize: 'off',
  fixedLoopMeasures: 0,
};

const KEY = 'spindoctor.settings.v1';

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const merged: Settings = { ...DEFAULTS, ...parsed };
      // Defend against shape drift
      if (!Array.isArray(merged.allStopTargets) || merged.allStopTargets.length !== NUM_TRACKS) {
        merged.allStopTargets = DEFAULTS.allStopTargets.slice();
      }
      if (!Array.isArray(merged.allPlayTargets) || merged.allPlayTargets.length !== NUM_TRACKS) {
        merged.allPlayTargets = DEFAULTS.allPlayTargets.slice();
      }
      return merged;
    }
  } catch {}
  return { ...DEFAULTS, allStopTargets: DEFAULTS.allStopTargets.slice(), allPlayTargets: DEFAULTS.allPlayTargets.slice() };
}

function persist(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}

export const useSettingsStore = create<Settings>(() => load());

// Persist on every change. Subscribers (e.g. the audio store pushing
// settings to the worklet) attach via useSettingsStore.subscribe.
useSettingsStore.subscribe((s) => persist(s));

export function updateSettings(patch: Partial<Settings>) {
  useSettingsStore.setState(patch, false);
}

export function resetSettings() {
  updateSettings({
    ...DEFAULTS,
    allStopTargets: DEFAULTS.allStopTargets.slice(),
    allPlayTargets: DEFAULTS.allPlayTargets.slice(),
  });
}

export function currentSettings(): Settings {
  return useSettingsStore.getState();
}
