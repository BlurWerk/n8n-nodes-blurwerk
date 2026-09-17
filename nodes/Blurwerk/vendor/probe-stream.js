/* Reading camcorder and broadcast streams in the browser: MPEG-TS (.ts, .m2ts,
   .mts), MPEG program streams (.mpg, .vob) and FLV.

   These used to be named and refused, and priced by hand through a form. They
   are what AVCHD camcorders, dashcams and broadcast recorders write, so the
   customers most likely to need faces removed were the ones typing numbers.

   None of them keeps a tidy header with the three figures a price needs, so
   they are measured the way ffprobe does: the length from the first and last
   presentation timestamps, the framerate from the spacing between frames, and
   the picture size from the codec's own sequence header (H.264 SPS, MPEG-2
   sequence header). Nothing is uploaded; the head and tail of the file are
   read here. Anything not understood returns null, and the page falls back to
   asking — the server measures the real file on arrival either way.
*/
"use strict";

const STREAM = (() => {
  const EDGE = 2 << 20;                       // bytes read at each end
  const TS_VIDEO = { 0x1B: "h264", 0x02: "mpeg2video", 0x01: "mpeg1video" };
  const FPS_CODES = [0, 24000 / 1001, 24, 25, 30000 / 1001, 30, 50, 60000 / 1001, 60];

  const slice = (file, a, b) => file.slice(Math.max(0, a), Math.min(b, file.size))
    .arrayBuffer().then(x => new Uint8Array(x));

  /* --- bit reading for codec headers -------------------------------------- */
  function bits(bytes) {
    const rbsp = [];                          // drop emulation-prevention 0x03
    for (let i = 0; i < bytes.length; i++) {
      if (i > 1 && bytes[i] === 3 && bytes[i - 1] === 0 && bytes[i - 2] === 0) continue;
      rbsp.push(bytes[i]);
    }
    let pos = 0;
    const u = n => { let v = 0; for (let i = 0; i < n; i++, pos++)
      v = v * 2 + ((rbsp[pos >> 3] >> (7 - (pos & 7))) & 1); return v; };
    const ue = () => { let z = 0; while (u(1) === 0) { if (++z > 31) throw 0; }
      return (2 ** z) - 1 + u(z); };
    const se = () => { const k = ue(); return k & 1 ? (k + 1) / 2 : -k / 2; };
    return { u, ue, se };
  }

  function h264Size(nal) {                    // nal starts after the 1-byte header
    const b = bits(nal);
    const profile = b.u(8); b.u(16); b.ue();
    let chroma = 1, separate = 0;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = b.ue(); if (chroma === 3) separate = b.u(1);
      b.ue(); b.ue(); b.u(1);
      if (b.u(1)) for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) if (b.u(1)) {
        let last = 8, next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
          if (next !== 0) next = (last + b.se() + 256) % 256;
          last = next === 0 ? last : next;
        }
      }
    }
    b.ue();
    const poc = b.ue();
    if (poc === 0) b.ue();
    else if (poc === 1) { b.u(1); b.se(); b.se(); const n = b.ue(); for (let i = 0; i < n; i++) b.se(); }
    b.ue(); b.u(1);
    const wMbs = b.ue() + 1, hMaps = b.ue() + 1, frameOnly = b.u(1);
    if (!frameOnly) b.u(1);
    b.u(1);
    let cl = 0, cr = 0, ct = 0, cb = 0;
    if (b.u(1)) { cl = b.ue(); cr = b.ue(); ct = b.ue(); cb = b.ue(); }
    const cx = separate || chroma === 0 ? 1 : (chroma === 3 ? 1 : 2);
    const cy = (separate || chroma === 0 ? 1 : (chroma === 1 ? 2 : 1)) * (2 - frameOnly);
    return { width: wMbs * 16 - cx * (cl + cr),
             height: (2 - frameOnly) * hMaps * 16 - cy * (ct + cb) };
  }

  // The first sequence header in a run of elementary-stream bytes.
  function esSize(es, codec) {
    for (let i = 0; i + 8 < es.length; i++) {
      if (es[i] !== 0 || es[i + 1] !== 0 || es[i + 2] !== 1) continue;
      if (codec === "h264" && (es[i + 3] & 0x1F) === 7) {
        try { return h264Size(es.subarray(i + 4, i + 4 + 256)); } catch (e) { return null; }
      }
      if (codec !== "h264" && es[i + 3] === 0xB3) {
        return { width: (es[i + 4] << 4) | (es[i + 5] >> 4),
                 height: ((es[i + 5] & 0x0F) << 8) | es[i + 6],
                 fps: FPS_CODES[es[i + 7] & 0x0F] || 0 };
      }
    }
    return null;
  }

  function pts(p, off) {                      // PES header at off; 33-bit PTS or null
    if (p[off] !== 0 || p[off + 1] !== 0 || p[off + 2] !== 1 || !(p[off + 7] & 0x80)) return null;
    const q = off + 9;
    return ((p[q] & 0x0E) * 2 ** 29) + (p[q + 1] << 22) + ((p[q + 2] & 0xFE) << 14)
         + (p[q + 3] << 7) + (p[q + 4] >> 1);
  }

  // Frame spacing from a set of timestamps, which arrive in DECODE order, so
  // sort them first. The smallest step is one frame.
  function fpsFrom(stamps) {
    const s = [...new Set(stamps)].sort((a, b) => a - b);
    let step = Infinity;
    for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] > 0) step = Math.min(step, s[i] - s[i - 1]);
    return isFinite(step) ? 90000 / step : 0;
  }

  const finish = (m, container) => m && m.width > 15 && m.height > 15 && m.duration > 0.04
    && m.fps > 0.5 && m.fps < 1000 ? Object.assign(m, { container }) : null;

  /* --- MPEG transport stream ------------------------------------------------ */
  function tsPackets(bytes, size) {
    let start = 0;
    while (start < size * 2 && !(bytes[start] === 0x47 && bytes[start + size] === 0x47)) start++;
    const out = [];
    // `start` is the sync byte itself; in M2TS it sits 4 bytes into each unit.
    for (let i = start; i + 188 <= bytes.length; i += size) {
      const p = bytes.subarray(i, i + 188);
      if (p[0] !== 0x47) continue;
      const pid = ((p[1] & 0x1F) << 8) | p[2], unit = !!(p[1] & 0x40), afc = (p[3] >> 4) & 3;
      let off = 4; if (afc & 2) off += 1 + p[4];
      if (afc & 1 && off < 188) out.push({ pid, unit, data: p.subarray(off) });
    }
    return out;
  }

  function tsVideo(packets) {                 // PAT -> PMT -> first video stream
    const pat = packets.find(k => k.pid === 0 && k.unit);
    if (!pat) return null;
    const d = pat.data.subarray(1 + pat.data[0]);
    const pmtPid = ((d[10] & 0x1F) << 8) | d[11];
    const pmt = packets.find(k => k.pid === pmtPid && k.unit);
    if (!pmt) return null;
    const m = pmt.data.subarray(1 + pmt.data[0]);
    const end = 3 + (((m[1] & 0x0F) << 8) | m[2]) - 4;
    for (let i = 12 + (((m[10] & 0x0F) << 8) | m[11]); i + 5 <= end;) {
      const type = m[i], pid = ((m[i + 1] & 0x1F) << 8) | m[i + 2];
      if (TS_VIDEO[type]) return { pid, codec: TS_VIDEO[type] };
      i += 5 + (((m[i + 3] & 0x0F) << 8) | m[i + 4]);
    }
    return null;
  }

  async function readTS(file, size) {
    const head = tsPackets(await slice(file, 0, EDGE), size);
    const video = tsVideo(head);
    if (!video) return null;
    const mine = head.filter(k => k.pid === video.pid);
    const stamps = mine.filter(k => k.unit).map(k => pts(k.data, 0)).filter(x => x !== null);
    const tail = tsPackets(await slice(file, file.size - EDGE, file.size), size)
      .filter(k => k.pid === video.pid && k.unit).map(k => pts(k.data, 0)).filter(x => x !== null);
    if (!stamps.length || !tail.length) return null;
    const shape = esSize(Uint8Array.from(mine.flatMap(k => [...k.data])), video.codec);
    if (!shape) return null;
    const fps = fpsFrom(stamps) || shape.fps;
    let span = Math.max(...tail) - Math.min(...stamps);
    if (span < 0) span += 2 ** 33;            // the 33-bit clock wrapped
    return finish({ width: shape.width, height: shape.height, fps, codec: video.codec,
                    duration: span / 90000 + (fps ? 1 / fps : 0) },
                  size === 192 ? "MPEG-TS (M2TS)" : "MPEG-TS");
  }

  /* --- MPEG program stream (.mpg, .vob) ------------------------------------ */
  function psStamps(b) {
    const out = [];
    for (let i = 0; i + 14 < b.length; i++)
      if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1 && (b[i + 3] & 0xF0) === 0xE0) {
        const t = pts(b, i); if (t !== null) out.push(t);
      }
    return out;
  }

  async function readPS(file) {
    const head = await slice(file, 0, EDGE), tail = await slice(file, file.size - EDGE, file.size);
    const shape = esSize(head, "mpeg2video");
    const a = psStamps(head), z = psStamps(tail);
    if (!shape || !a.length || !z.length) return null;
    const fps = shape.fps || fpsFrom(a);
    return finish({ width: shape.width, height: shape.height, fps, codec: "mpeg2video",
                    duration: (Math.max(...z) - Math.min(...a)) / 90000 + 1 / fps },
                  "MPEG program stream");
  }

  /* --- FLV ---------------------------------------------------------------------- */
  const FLV_CODEC = { 2: "flv1", 3: "screen", 4: "vp6", 5: "vp6a", 7: "h264", 12: "hevc" };

  function amf(v, o) {                        // one AMF0 value at o -> [value, next]
    const t = v[o++], dv = new DataView(v.buffer, v.byteOffset);
    const str = (at, n) => [new TextDecoder().decode(v.subarray(at, at + n)), at + n];
    if (t === 0) return [dv.getFloat64(o), o + 8];
    if (t === 1) return [!!v[o], o + 1];
    if (t === 2) return str(o + 2, dv.getUint16(o));
    if (t === 3 || t === 8) {
      const out = {}; if (t === 8) o += 4;
      for (let guard = 0; guard < 512; guard++) {
        const n = dv.getUint16(o); if (n === 0 && v[o + 2] === 9) return [out, o + 3];
        const [k, at] = str(o + 2, n); const [val, next] = amf(v, at); out[k] = val; o = next;
      }
      return [out, o];
    }
    if (t === 5 || t === 6) return [null, o];
    if (t === 10) { const n = dv.getUint32(o); o += 4; const a = [];
      for (let i = 0; i < n && i < 4096; i++) { const [x, next] = amf(v, o); a.push(x); o = next; }
      return [a, o]; }
    if (t === 11) return [dv.getFloat64(o), o + 10];
    throw new Error("amf");
  }

  async function readFLV(file) {
    const v = await slice(file, 0, EDGE), dv = new DataView(v.buffer);
    let o = dv.getUint32(5) + 4, meta = {}, stamps = [], codec = "";
    while (o + 11 < v.length && stamps.length < 60) {
      const type = v[o], size = (v[o + 1] << 16) | (v[o + 2] << 8) | v[o + 3];
      const ts = ((v[o + 7] << 24) | (v[o + 4] << 16) | (v[o + 5] << 8) | v[o + 6]) >>> 0;
      if (type === 18) {
        try { const [name, at] = amf(v, o + 11); if (name === "onMetaData") meta = amf(v, at)[0] || {}; }
        catch (e) { /* metadata is optional */ }
      } else if (type === 9) { stamps.push(ts * 90); codec = codec || FLV_CODEC[v[o + 11] & 0x0F] || ""; }
      o += 11 + size + 4;
    }
    let duration = meta.duration;
    if (!(duration > 0)) {                    // streamed: no duration written
      const t = await slice(file, file.size - 4, file.size);
      const last = new DataView(t.buffer).getUint32(0);
      const tag = await slice(file, file.size - 4 - last, file.size - 4 - last + 8);
      duration = (((tag[7] << 24) | (tag[4] << 16) | (tag[5] << 8) | tag[6]) >>> 0) / 1000;
    }
    const fps = meta.framerate || fpsFrom(stamps);
    return finish({ width: meta.width, height: meta.height, fps, duration,
                    codec: codec || String(meta.videocodecid || "") }, "FLV");
  }

  /* --- dispatch ------------------------------------------------------------------ */
  async function read(file) {
    const h = await slice(file, 0, 400);
    if (h.length < 16) return null;
    try {
      if (h[0] === 0x46 && h[1] === 0x4C && h[2] === 0x56) return await readFLV(file);
      if (h[0] === 0x47 && h[188] === 0x47) return await readTS(file, 188);
      if (h[4] === 0x47 && h[196] === 0x47) return await readTS(file, 192);
      if (h[0] === 0 && h[1] === 0 && h[2] === 1 && h[3] === 0xBA) return await readPS(file);
    } catch (e) { return null; }
    return null;
  }

  return { read, h264Size, fpsFrom };
})();

if (typeof module !== "undefined") module.exports = STREAM;   // tests
