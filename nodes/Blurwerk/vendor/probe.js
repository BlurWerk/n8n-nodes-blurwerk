/* Container header parsing, in the browser.

   The browser can only tell us a video's dimensions if it can DECODE it, and
   it refuses most of what people actually have: Matroska in any form, HEVC,
   AVI, ProRes. Those files were being rejected at the door with "is it a
   video?" while the FAQ promised we accept them.

   Reading the header ourselves fixes that without breaking the promise that
   nothing is uploaded to price a job — we parse the same fields ffprobe would,
   from a slice of the file, on the customer's own machine.

   Every parser returns null rather than a guess. A wrong duration is a wrong
   price, and a wrong price is money. */
"use strict";

const CONTAINER = (() => {

  const buf = (file, start, end) =>
    file.slice(start, Math.min(end, file.size)).arrayBuffer().then(b => new DataView(b));
  const ascii = (v, off, n) => {
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint8(off + i));
    return s;
  };
  // Plausibility, applied to every parser's output. Nonsense is worse than a
  // failure: a failure asks the customer, nonsense quietly misprices the job.
  const sane = m =>
    m && m.width > 15 && m.height > 15 && m.width < 33000 && m.height < 33000
      && m.duration > 0.04 && m.duration < 86400 * 2
      && m.fps > 0.5 && m.fps < 1000 ? m : null;

  /* --- Matroska / WebM (EBML) --------------------------------------------- */
  // Elements are id + size + payload, both written as variable-length ints.
  // Ids keep their marker bits (that is how the spec writes them); sizes have
  // theirs stripped.

  const HEAD_BYTES = 4 << 20;   // Info and Tracks precede the first Cluster

  function vint(v, off, keepMarker) {
    const first = v.getUint8(off);
    if (first === 0) return null;                     // reserved / corrupt
    let len = 1;
    for (let mask = 0x80; !(first & mask); mask >>= 1) len++;
    let value = keepMarker ? first : first & (0xff >> len);
    for (let i = 1; i < len; i++) value = value * 256 + v.getUint8(off + i);
    return { value, len };
  }

  const uint = (v, off, n) => {
    let x = 0;
    for (let i = 0; i < n; i++) x = x * 256 + v.getUint8(off + i);
    return x;
  };

  // Walk one level of children, calling visit(id, payloadOffset, size). Return
  // true from visit to descend into that element instead of skipping it.
  //
  // Depth is capped because a file can nest as deeply as it likes: Segment
  // inside Segment inside Segment costs nothing to write and would recurse
  // until the tab's stack gave out. Real files nest four levels.
  const MAX_DEPTH = 8;

  function ebmlWalk(v, off, end, visit, depth) {
    if ((depth || 0) > MAX_DEPTH) return;
    while (off < end) {
      const id = vint(v, off, true);
      if (!id) return;
      const sz = vint(v, off + id.len, false);
      if (!sz) return;
      const start = off + id.len + sz.len;
      // A size of all ones means "unknown" — descend rather than skip.
      const unknown = sz.value >= Math.pow(2, 7 * sz.len) - 1;
      const stop = unknown ? end : Math.min(end, start + sz.value);
      if (visit(id.value, start, stop) === true)
        ebmlWalk(v, start, stop, visit, (depth || 0) + 1);
      if (unknown) return;
      off = stop;
      if (stop <= start && sz.value !== 0) return;    // no forward progress
    }
  }

  const text = (v, off, n) => {
    let s = "";
    for (let i = 0; i < n; i++) {
      const c = v.getUint8(off + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };

  function parseEBML(v, raw) {
    let scale = 1e6, ticks = 0, w = 0, h = 0, frameNs = 0, codec = "";
    let type = 0, trackW = 0, trackH = 0, trackNs = 0, trackCodec = "";
    ebmlWalk(v, 0, v.byteLength, (id, at, to) => {
      const n = to - at;
      switch (id) {
        case 0x18538067: case 0x1549A966: case 0x1654AE6B: return true;  // Segment/Info/Tracks
        case 0x2AD7B1: scale = uint(v, at, n) || scale; return;          // TimestampScale
        case 0x4489:                                                      // Duration (float)
          ticks = n === 4 ? v.getFloat32(at) : n === 8 ? v.getFloat64(at) : ticks; return;
        case 0xAE:                                                        // TrackEntry
          type = trackW = trackH = trackNs = 0; trackCodec = "";
          ebmlWalk(v, at, to, (tid, tat, tto) => {
            const tn = tto - tat;
            if (tid === 0x83) type = uint(v, tat, tn);                    // TrackType
            else if (tid === 0x86) trackCodec = text(v, tat, tn);          // CodecID
            else if (tid === 0x23E383) trackNs = uint(v, tat, tn);        // DefaultDuration
            else if (tid === 0xE0) return true;                           // Video
            else if (tid === 0xB0) trackW = uint(v, tat, tn);             // PixelWidth
            else if (tid === 0xBA) trackH = uint(v, tat, tn);             // PixelHeight
          });
          if (type === 1 && !w) {
            w = trackW; h = trackH; frameNs = trackNs; codec = trackCodec;
          }
          return;
      }
    });
    const out = { width: w, height: h, duration: ticks * scale / 1e9,
                  fps: frameNs ? 1e9 / frameNs : 0,
                  container: "Matroska/WebM", codec };
    return raw ? out : sane(out);
  }

  /* --- MP4 / MOV (ISO base media) ----------------------------------------- */
  // moov sits at either end of the file, so top-level boxes are walked by
  // reading 16-byte headers and seeking — never by reading the whole file.

  async function findMoov(file) {
    let off = 0;
    while (off + 8 <= file.size) {
      const v = await buf(file, off, off + 16);
      if (v.byteLength < 8) return null;
      let size = v.getUint32(0), head = 8;
      const type = ascii(v, 4, 4);
      if (size === 1) {
        if (v.byteLength < 16) return null;
        size = v.getUint32(8) * 4294967296 + v.getUint32(12);
        head = 16;
      } else if (size === 0) size = file.size - off;
      if (type === "moov") return { start: off + head, end: off + size };
      if (size < 8) return null;
      off += size;
    }
    return null;
  }

  // Children of one box, as {type, at, to} — boxes here are small enough that
  // the whole moov is already in memory.
  function boxes(v, off, end) {
    const out = [];
    while (off + 8 <= end) {
      let size = v.getUint32(off), head = 8;
      const type = ascii(v, off + 4, 4);
      if (size === 1) { size = v.getUint32(off + 8) * 4294967296 + v.getUint32(off + 12); head = 16; }
      else if (size === 0) size = end - off;
      if (size < head) return out;
      out.push({ type, at: off + head, to: Math.min(end, off + size) });
      off += size;
    }
    return out;
  }

  const find = (v, list, type) => list.find(b => b.type === type);

  function parseMoov(v, end, raw) {
    const moov = boxes(v, 0, end);
    for (const trak of moov.filter(b => b.type === "trak")) {
      const t = boxes(v, trak.at, trak.to);
      const mdia = find(v, t, "mdia");
      if (!mdia) continue;
      const md = boxes(v, mdia.at, mdia.to);
      const hdlr = find(v, md, "hdlr");
      if (!hdlr || ascii(v, hdlr.at + 8, 4) !== "vide") continue;

      const mdhd = find(v, md, "mdhd");
      if (!mdhd) continue;
      const v1 = v.getUint8(mdhd.at) === 1;
      const timescale = v1 ? v.getUint32(mdhd.at + 20) : v.getUint32(mdhd.at + 12);
      const dur = v1 ? v.getUint32(mdhd.at + 24) * 4294967296 + v.getUint32(mdhd.at + 28)
                     : v.getUint32(mdhd.at + 16);
      const duration = timescale ? dur / timescale : 0;

      const minf = find(v, md, "minf");
      const stbl = minf && find(v, boxes(v, minf.at, minf.to), "stbl");
      if (!stbl) continue;
      const st = boxes(v, stbl.at, stbl.to);

      // Coded size from the sample description, not tkhd: tkhd carries the
      // DISPLAY size, which differs on anamorphic footage.
      let width = 0, height = 0, codec = "";
      const stsd = find(v, st, "stsd");
      if (stsd && v.getUint32(stsd.at + 4) > 0) {
        const entry = stsd.at + 8;
        // The sample entry's own four-character type IS the codec: avc1, hvc1,
        // hev1, av01, vp09, ap4h for ProRes.
        codec = ascii(v, entry + 4, 4);
        width = v.getUint16(entry + 24);
        height = v.getUint16(entry + 26);
      }
      if (!width) {
        const tkhd = find(v, t, "tkhd");
        if (tkhd) {
          const off = v.getUint8(tkhd.at) === 1 ? 88 : 76;
          width = v.getUint32(tkhd.at + off) / 65536;
          height = v.getUint32(tkhd.at + off + 4) / 65536;
        }
      }

      const stsz = find(v, st, "stsz");
      const samples = stsz ? v.getUint32(stsz.at + 8) : 0;
      const out = { width, height, duration,
                    fps: duration ? samples / duration : 0,
                    container: "MP4/MOV", codec };
      return raw ? out : sane(out);
    }
    return null;
  }

  /* --- AVI (RIFF) ---------------------------------------------------------- */

  function parseAVI(v, raw) {
    // hdrl/avih sits immediately after the 12-byte RIFF header in every file
    // ffmpeg or a camera writes; anything else falls through to null.
    const list = boxes4cc(v, 12, v.byteLength, "avih");
    if (!list) return null;
    const usPerFrame = v.getUint32(list, true);
    const frames = v.getUint32(list + 16, true);
    const fps = usPerFrame ? 1e6 / usPerFrame : 0;
    const out = { width: v.getUint32(list + 32, true),
                  height: v.getUint32(list + 36, true),
                  duration: fps ? frames / fps : 0, fps,
                  container: "AVI", codec: "" };
    return raw ? out : sane(out);
  }

  // RIFF chunks are little-endian and LIST chunks nest; find one payload.
  // Depth-capped for the same reason as ebmlWalk: nesting is free to write.
  function boxes4cc(v, off, end, want, depth) {
    if ((depth || 0) > MAX_DEPTH) return null;
    while (off + 8 <= end) {
      const id = ascii(v, off, 4);
      const size = v.getUint32(off + 4, true);
      if (id === want) return off + 8;
      if (id === "LIST") {
        const hit = boxes4cc(v, off + 12, Math.min(end, off + 8 + size), want,
                             (depth || 0) + 1);
        if (hit) return hit;
      }
      off += 8 + size + (size & 1);
    }
    return null;
  }

  /* --- dispatch ------------------------------------------------------------ */

  async function moovMeta(file, raw) {
    const moov = await findMoov(file);
    if (!moov) return null;
    return parseMoov(await buf(file, moov.start, moov.end),
                     moov.end - moov.start, raw);
  }

  // Streams (TS, M2TS, MPEG-PS, FLV) live in probe-stream.js, loaded before
  // this file in the page and required under the test runner.
  const stream = () => typeof STREAM !== "undefined" ? STREAM
    : (typeof require !== "undefined" ? require("./probe-stream.js") : null);

  async function read(file) {
    const head = await buf(file, 0, 16);
    if (head.byteLength < 12) return null;
    if (head.getUint32(0) === 0x1A45DFA3)
      return parseEBML(await buf(file, 0, HEAD_BYTES));
    if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "AVI ")
      return parseAVI(await buf(file, 0, HEAD_BYTES));
    const s = stream() && await stream().read(file);
    return s || await moovMeta(file, false);
  }

  return { read, moovMeta, buf, ascii, parseEBML, parseMoov, parseAVI,
           boxes, findMoov };
})();

if (typeof module !== "undefined") module.exports = CONTAINER;   // tests
