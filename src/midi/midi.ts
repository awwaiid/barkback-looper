import { create } from 'zustand';

export type MidiAction =
  | 'rec-selected'
  | 'stop-selected'
  | 'clear-selected'
  | 'undo-selected'
  | 'select-next'
  | 'select-prev'
  | 'all-stop'
  | 'all-play'
  | 'rec-track-1'
  | 'rec-track-2'
  | 'rec-track-3'
  | 'rec-track-4'
  | 'stop-track-1'
  | 'stop-track-2'
  | 'stop-track-3'
  | 'stop-track-4';

export const MIDI_ACTION_LABELS: Record<MidiAction, string> = {
  'rec-selected': 'REC/cycle selected track',
  'stop-selected': 'Stop selected track',
  'clear-selected': 'Clear selected track',
  'undo-selected': 'Undo selected track',
  'select-next': 'Select next track',
  'select-prev': 'Select previous track',
  'all-stop': 'All stop',
  'all-play': 'Play all',
  'rec-track-1': 'REC/cycle track 1',
  'rec-track-2': 'REC/cycle track 2',
  'rec-track-3': 'REC/cycle track 3',
  'rec-track-4': 'REC/cycle track 4',
  'stop-track-1': 'Stop track 1',
  'stop-track-2': 'Stop track 2',
  'stop-track-3': 'Stop track 3',
  'stop-track-4': 'Stop track 4',
};

export interface MidiBinding {
  kind: 'note' | 'cc';
  channel: number;
  number: number;
  action: MidiAction;
}

export interface MidiInputInfo {
  id: string;
  name: string;
  manufacturer: string;
}

const STORAGE_KEY = 'spindoctor.midi.bindings.v1';
const ENABLED_KEY = 'spindoctor.midi.enabled.v1';

function loadBindings(): MidiBinding[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function saveBindings(bs: MidiBinding[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(bs)); } catch {}
}

function loadEnabled(): Set<string> {
  try {
    const raw = localStorage.getItem(ENABLED_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set();
}

function saveEnabled(ids: Set<string>) {
  try { localStorage.setItem(ENABLED_KEY, JSON.stringify([...ids])); } catch {}
}

export type MidiActionHandlers = Record<MidiAction, () => void>;

interface MidiState {
  supported: boolean;
  inputs: MidiInputInfo[];
  enabled: Set<string>;
  bindings: MidiBinding[];
  learnTarget: MidiAction | null;
  lastEvent: string;
}

export const useMidiStore = create<MidiState>(() => ({
  supported: false,
  inputs: [],
  enabled: loadEnabled(),
  bindings: loadBindings(),
  learnTarget: null,
  lastEvent: '',
}));

let access: MIDIAccess | null = null;
let handlers: Partial<MidiActionHandlers> = {};
const inputListeners = new Map<string, (e: MIDIMessageEvent) => void>();

export function setActionHandlers(h: Partial<MidiActionHandlers>) {
  handlers = h;
}

function refreshInputs() {
  if (!access) return;
  const list: MidiInputInfo[] = [];
  access.inputs.forEach(inp => {
    list.push({
      id: inp.id,
      name: inp.name || '(unnamed)',
      manufacturer: inp.manufacturer || '',
    });
  });
  useMidiStore.setState({ inputs: list });
}

function attachInput(input: MIDIInput) {
  detachInput(input);
  const handler = (ev: MIDIMessageEvent) => onMidiMessage(ev);
  inputListeners.set(input.id, handler);
  input.addEventListener('midimessage', handler);
}

function detachInput(input: MIDIInput) {
  const existing = inputListeners.get(input.id);
  if (existing) {
    input.removeEventListener('midimessage', existing);
    inputListeners.delete(input.id);
  }
}

function applyEnabled() {
  if (!access) return;
  const en = useMidiStore.getState().enabled;
  access.inputs.forEach(inp => {
    if (en.has(inp.id)) attachInput(inp);
    else detachInput(inp);
  });
}

export function toggleInput(id: string, on: boolean) {
  const en = new Set(useMidiStore.getState().enabled);
  if (on) en.add(id); else en.delete(id);
  useMidiStore.setState({ enabled: en });
  saveEnabled(en);
  applyEnabled();
}

export function setLearnTarget(action: MidiAction | null) {
  useMidiStore.setState({ learnTarget: action });
}

export function removeBinding(action: MidiAction) {
  const next = useMidiStore.getState().bindings.filter(b => b.action !== action);
  useMidiStore.setState({ bindings: next });
  saveBindings(next);
}

export function bindingFor(state: MidiState, action: MidiAction): MidiBinding | undefined {
  return state.bindings.find(b => b.action === action);
}

export function describeBinding(b: MidiBinding): string {
  return `${b.kind === 'note' ? 'note' : 'CC'} ${b.number} ch${b.channel + 1}`;
}

function onMidiMessage(ev: MIDIMessageEvent) {
  const data = ev.data;
  if (!data || data.length < 2) return;
  const status = data[0];
  const hi = status & 0xF0;
  const ch = status & 0x0F;
  const d1 = data[1];
  const d2 = data.length > 2 ? data[2] : 0;

  let evt: { kind: 'note' | 'cc'; channel: number; number: number } | null = null;
  if (hi === 0x90 && d2 > 0) {
    evt = { kind: 'note', channel: ch, number: d1 };
  } else if (hi === 0xB0) {
    if (d2 === 0) return;
    evt = { kind: 'cc', channel: ch, number: d1 };
  }
  if (!evt) return;

  useMidiStore.setState({ lastEvent: `${evt.kind === 'note' ? 'note' : 'CC'} ${evt.number} ch${evt.channel + 1}` });

  const state = useMidiStore.getState();
  const learn = state.learnTarget;
  if (learn) {
    const next = state.bindings.filter(b =>
      !(b.kind === evt.kind && b.channel === evt.channel && b.number === evt.number) &&
      b.action !== learn
    );
    next.push({ kind: evt.kind, channel: evt.channel, number: evt.number, action: learn });
    useMidiStore.setState({ bindings: next, learnTarget: null });
    saveBindings(next);
    return;
  }

  for (const b of state.bindings) {
    if (b.kind === evt.kind && b.channel === evt.channel && b.number === evt.number) {
      handlers[b.action]?.();
    }
  }
}

export async function initMidi(): Promise<void> {
  if (!('requestMIDIAccess' in navigator)) {
    useMidiStore.setState({ supported: false });
    return;
  }
  useMidiStore.setState({ supported: true });
  try {
    access = await navigator.requestMIDIAccess({ sysex: false });
    refreshInputs();
    applyEnabled();
    access.addEventListener('statechange', () => {
      refreshInputs();
      applyEnabled();
    });
  } catch {
    useMidiStore.setState({ supported: false });
  }
}
