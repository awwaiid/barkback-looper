// Convert a linear peak [0..1+] to a 0..100% meter width.
// -60 dBFS maps to 0%, 0 dBFS maps to 100%.
export function peakToPct(peak: number): number {
  if (peak < 0.0001) return 0;
  const db = Math.max(-60, 20 * Math.log10(peak));
  return Math.max(0, Math.min(100, (db + 60) / 60 * 100));
}
