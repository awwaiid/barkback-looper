// Encode interleaved stereo Float32 PCM as a 16-bit WAV blob.
// l, r must be the same length.
export function encodeWav16(l: Float32Array, r: Float32Array, sampleRate: number): Blob {
  const numFrames = Math.min(l.length, r.length);
  const numChannels = 2;
  const bytesPerSample = 2;
  const dataBytes = numFrames * numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);          // PCM format chunk size
  view.setUint16(20, 1, true);            // format: PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, 16, true);           // bits/sample
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  let off = 44;
  for (let i = 0; i < numFrames; i++) {
    const sl = Math.max(-1, Math.min(1, l[i]));
    const sr = Math.max(-1, Math.min(1, r[i]));
    view.setInt16(off, sl < 0 ? sl * 0x8000 : sl * 0x7FFF, true);
    off += 2;
    view.setInt16(off, sr < 0 ? sr * 0x8000 : sr * 0x7FFF, true);
    off += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

// Parse a 16-bit or 32-bit float WAV file back into stereo Float32 arrays.
// Returns null on unsupported format.
export function decodeWav(buf: ArrayBuffer): { l: Float32Array; r: Float32Array; sampleRate: number } | null {
  const view = new DataView(buf);
  const tag = (off: number) =>
    String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;

  let off = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let dataOff = 0;
  let dataLen = 0;
  while (off + 8 <= view.byteLength) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    if (id === 'fmt ') {
      fmt = {
        format: view.getUint16(off + 8, true),
        channels: view.getUint16(off + 10, true),
        sampleRate: view.getUint32(off + 12, true),
        bits: view.getUint16(off + 22, true),
      };
    } else if (id === 'data') {
      dataOff = off + 8;
      dataLen = size;
      break;
    }
    off += 8 + size + (size & 1);
  }
  if (!fmt || !dataOff) return null;

  const { format, channels, sampleRate, bits } = fmt;
  const bytesPerSample = bits / 8;
  const frames = dataLen / (bytesPerSample * channels);
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);

  if (format === 1 && bits === 16) {
    for (let i = 0; i < frames; i++) {
      const base = dataOff + i * channels * 2;
      const sL = view.getInt16(base, true);
      l[i] = sL < 0 ? sL / 0x8000 : sL / 0x7FFF;
      if (channels >= 2) {
        const sR = view.getInt16(base + 2, true);
        r[i] = sR < 0 ? sR / 0x8000 : sR / 0x7FFF;
      } else {
        r[i] = l[i];
      }
    }
  } else if (format === 3 && bits === 32) {
    for (let i = 0; i < frames; i++) {
      const base = dataOff + i * channels * 4;
      l[i] = view.getFloat32(base, true);
      r[i] = channels >= 2 ? view.getFloat32(base + 4, true) : l[i];
    }
  } else {
    return null;
  }
  return { l, r, sampleRate };
}
