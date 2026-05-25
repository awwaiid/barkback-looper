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

const listeners: Array<(s: Settings) => void> = [];

export function onSettingsChange(fn: (s: Settings) => void): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function updateSettings(patch: Partial<Settings>) {
  const next = { ...useSettingsStore.getState(), ...patch };
  useSettingsStore.setState(next, true);
  persist(next);
  for (const fn of listeners) fn(next);
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
