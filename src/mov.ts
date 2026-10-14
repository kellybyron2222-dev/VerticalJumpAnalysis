/**
 * Presentation timestamps from a QuickTime/MOV file, in the same seconds the
 * video element uses for `currentTime`. iPhone slo-mo keeps a variable sample
 * table and an edit list that skips the pre-roll. Safari's
 * `requestVideoFrameCallback` mediaTime is not that clock: playback at a
 * changed rate often never starts, and mediaTime can be the pre-edit media
 * PTS, which seeks every frame to the end of the clip.
 */

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts"]);

interface Atom {
  type: string;
  body: number;
  end: number;
}

export interface MovClipClock {
  times: number[];
  /**
   * True when Apple marked the clip as not full-frame-rate playback (slo-mo
   * hold). Null when that tag is missing.
   */
  slowMoPlayback: boolean | null;
}

/** Composition time of each frame that the edit list actually plays. Null when the file has no video sample table. */
export function parseMovFrameTimes(data: Uint8Array): number[] | null {
  return parseMovClip(data)?.times ?? null;
}

/** Frame timestamps plus Apple slo-mo playback intent, when present. */
export function parseMovClip(data: Uint8Array): MovClipClock | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const moov = child(data, view, 0, data.length, "moov");
  if (!moov) return null;
  const movie = movieTiming(data, view, moov);
  if (!movie) return null;

  let times: number[] | null = null;
  for (const trak of children(data, view, moov.body, moov.end)) {
    if (trak.type !== "trak") continue;
    times = videoTrackTimes(data, view, trak, movie.timescale);
    if (times && times.length >= 3) break;
    times = null;
  }
  if (!times) return null;
  return { times, slowMoPlayback: readSlowMoPlayback(data) };
}

/**
 * `com.apple.quicktime.full-frame-rate-playback-intent`: 0 means play slowed
 * (the Photos capture fps is higher than the file's presentation rate).
 */
function readSlowMoPlayback(data: Uint8Array): boolean | null {
  const key = "full-frame-rate-playback-intent";
  const start = indexOfAscii(data, key);
  if (start < 0) return null;
  // ilst stores a data atom after the keys table; scan forward a short window.
  const from = start + key.length;
  const to = Math.min(data.length - 16, from + 400);
  for (let i = from; i < to; i += 1) {
    if (
      data[i] === 0x64 &&
      data[i + 1] === 0x61 &&
      data[i + 2] === 0x74 &&
      data[i + 3] === 0x61
    ) {
      // data atom: size(4) 'data'(4) type(4) locale(4) payload…
      const type = (data[i + 4] << 24) | (data[i + 5] << 16) | (data[i + 6] << 8) | data[i + 7];
      // Integer types used for this flag are small; payload is often 1 byte/4 bytes.
      const payloadAt = i + 12;
      if (payloadAt >= data.length) return null;
      // Prefer an explicit 0 / 1 in the next few bytes.
      for (let p = payloadAt; p < Math.min(data.length, payloadAt + 8); p += 1) {
        if (data[p] === 0) return true;
        if (data[p] === 1) return false;
      }
      void type;
      return null;
    }
  }
  // Tag present but value not decoded — still treat as an iPhone slo-mo file.
  return true;
}

function indexOfAscii(data: Uint8Array, text: string): number {
  const bytes = new TextEncoder().encode(text);
  outer: for (let i = 0; i <= data.length - bytes.length; i += 1) {
    for (let j = 0; j < bytes.length; j += 1) {
      if (data[i + j] !== bytes[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function movieTiming(data: Uint8Array, view: DataView, moov: Atom): { timescale: number } | null {
  const mvhd = child(data, view, moov.body, moov.end, "mvhd");
  if (!mvhd) return null;
  const version = data[mvhd.body] ?? 0;
  const timescale = version === 1 ? view.getUint32(mvhd.body + 20) : view.getUint32(mvhd.body + 12);
  return timescale > 0 ? { timescale } : null;
}

function videoTrackTimes(data: Uint8Array, view: DataView, trak: Atom, movieTimescale: number): number[] | null {
  const mdia = child(data, view, trak.body, trak.end, "mdia");
  if (!mdia) return null;
  const hdlr = child(data, view, mdia.body, mdia.end, "hdlr");
  if (!hdlr || handlerType(data, hdlr) !== "vide") return null;
  const mdhd = child(data, view, mdia.body, mdia.end, "mdhd");
  const minf = child(data, view, mdia.body, mdia.end, "minf");
  if (!mdhd || !minf) return null;
  const mediaTimescale = mediaScale(data, view, mdhd);
  const stbl = child(data, view, minf.body, minf.end, "stbl");
  if (!stbl || !(mediaTimescale > 0)) return null;
  const stts = child(data, view, stbl.body, stbl.end, "stts");
  if (!stts) return null;
  const ctts = child(data, view, stbl.body, stbl.end, "ctts");
  const decode = decodeTimes(view, stts);
  if (!decode) return null;
  const offsets = ctts ? compositionOffsets(view, ctts, decode.length) : new Array<number>(decode.length).fill(0);
  if (!offsets) return null;
  const composition = decode.map((time, index) => time + (offsets[index] ?? 0));
  const order = composition.map((_, index) => index).sort((a, b) => composition[a] - composition[b] || a - b);
  const edits = editList(data, view, trak);
  return mapEdits(order, composition, edits, mediaTimescale, movieTimescale);
}

function handlerType(data: Uint8Array, hdlr: Atom): string {
  if (hdlr.body + 12 > hdlr.end) return "";
  return String.fromCharCode(data[hdlr.body + 8], data[hdlr.body + 9], data[hdlr.body + 10], data[hdlr.body + 11]);
}

function mediaScale(data: Uint8Array, view: DataView, mdhd: Atom): number {
  const version = data[mdhd.body] ?? 0;
  return version === 1 ? view.getUint32(mdhd.body + 20) : view.getUint32(mdhd.body + 12);
}

function decodeTimes(view: DataView, stts: Atom): number[] | null {
  const count = entryCount(view, stts);
  if (count === null) return null;
  const times: number[] = [];
  let time = 0;
  let offset = stts.body + 8;
  for (let i = 0; i < count; i += 1) {
    if (offset + 8 > stts.end) return null;
    const samples = view.getUint32(offset);
    const delta = view.getUint32(offset + 4);
    offset += 8;
    if (samples > 1_000_000 || times.length + samples > 1_000_000) return null;
    for (let n = 0; n < samples; n += 1) {
      times.push(time);
      time += delta;
    }
  }
  return times.length > 0 ? times : null;
}

/**
 * Composition offsets. Version 0 is specified as unsigned, but Apple writes
 * negative offsets in that field (values above 2^31). Frame offsets always
 * fit in a signed 32-bit tick count, so both versions are read as int32.
 */
function compositionOffsets(view: DataView, ctts: Atom, sampleCount: number): number[] | null {
  const count = entryCount(view, ctts);
  if (count === null) return null;
  const offsets: number[] = [];
  let offset = ctts.body + 8;
  for (let i = 0; i < count; i += 1) {
    if (offset + 8 > ctts.end) return null;
    const samples = view.getUint32(offset);
    const delta = view.getInt32(offset + 4);
    offset += 8;
    if (samples > 1_000_000 || offsets.length + samples > 1_000_000) return null;
    for (let n = 0; n < samples; n += 1) offsets.push(delta);
  }
  if (offsets.length < sampleCount) {
    while (offsets.length < sampleCount) offsets.push(0);
  }
  return offsets;
}

interface Edit {
  segmentSeconds: number;
  mediaTime: number;
  rate: number;
}

function editList(data: Uint8Array, view: DataView, trak: Atom): Edit[] | null {
  const edts = child(data, view, trak.body, trak.end, "edts");
  if (!edts) return null;
  const elst = child(data, view, edts.body, edts.end, "elst");
  if (!elst) return null;
  const version = data[elst.body] ?? 0;
  const count = entryCount(view, elst);
  if (count === null) return null;
  const edits: Edit[] = [];
  let offset = elst.body + 8;
  for (let i = 0; i < count; i += 1) {
    let segment = 0;
    let mediaTime = 0;
    if (version === 1) {
      if (offset + 20 > elst.end) return null;
      segment = Number(view.getBigUint64(offset));
      mediaTime = Number(view.getBigInt64(offset + 8));
      offset += 16;
    } else {
      if (offset + 12 > elst.end) return null;
      segment = view.getUint32(offset);
      mediaTime = view.getInt32(offset + 4);
      offset += 8;
    }
    const rate = view.getInt32(offset) / 65536;
    offset += 4;
    edits.push({ segmentSeconds: segment, mediaTime, rate });
  }
  return edits;
}

function mapEdits(
  order: readonly number[],
  composition: readonly number[],
  edits: readonly Edit[] | null,
  mediaTimescale: number,
  movieTimescale: number,
): number[] | null {
  const played: number[] = [];
  if (!edits || edits.length === 0) {
    for (const index of order) played.push(round6(composition[index] / mediaTimescale));
    return strictlyIncreasing(played);
  }
  let movieCursor = 0;
  for (const edit of edits) {
    const segmentSeconds = edit.segmentSeconds / movieTimescale;
    if (edit.mediaTime >= 0 && edit.rate > 0) {
      for (const index of order) {
        const local = (composition[index] - edit.mediaTime) / mediaTimescale / edit.rate;
        if (local >= -1e-6 && local < segmentSeconds - 1e-6) played.push(round6(movieCursor + local));
      }
    }
    movieCursor += segmentSeconds;
  }
  return strictlyIncreasing(played);
}

function strictlyIncreasing(times: readonly number[]): number[] | null {
  const out: number[] = [];
  for (const time of times) {
    if (!Number.isFinite(time) || time < -0.001) continue;
    const prev = out.length > 0 ? out[out.length - 1] : -1;
    if (time > prev + 0.0004) out.push(Math.max(0, time));
  }
  return out.length >= 3 ? out : null;
}

function entryCount(view: DataView, atom: Atom): number | null {
  if (atom.body + 8 > atom.end) return null;
  const count = view.getUint32(atom.body + 4);
  return count > 1_000_000 ? null : count;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function child(data: Uint8Array, view: DataView, start: number, end: number, type: string): Atom | null {
  for (const atom of children(data, view, start, end)) {
    if (atom.type === type) return atom;
  }
  return null;
}

function children(data: Uint8Array, view: DataView, start: number, end: number): Atom[] {
  const atoms: Atom[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    let header = 8;
    if (size === 1 && offset + 16 <= end) {
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) break;
    const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
    const body = offset + header;
    const atomEnd = offset + size;
    if (CONTAINERS.has(type)) atoms.push(...children(data, view, body, atomEnd));
    atoms.push({ type, body, end: atomEnd });
    offset = atomEnd;
  }
  return atoms;
}
