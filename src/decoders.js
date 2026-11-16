// 433 MHz OOK pulse detector, protocol decoders, analyzer and IQ synthesizer.
// Works in the browser (window.Dec433) and in Node (module.exports).
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- detector
  class PulseDetector {
    constructor(sampleRate, onPacket) {
      this.sr = sampleRate;
      this.onPacket = onPacket;
      this.snrDb = 8;
      this.reset();
    }
    reset() {
      this.t = 0; this.env = 0; this.noise = -1; this.dcI = 0; this.dcQ = 0;
      this.inPulse = false; this.pulseStart = 0; this.peak = 0;
      this.pkt = null; this.lastEnd = 0;
      this.blockSnrDb = 0; this.noiseDbfs = -99;
    }
    process(u8) {
      const sr = this.sr;
      const kOn = Math.pow(10, this.snrDb / 20);
      const minPulse = Math.max(2, Math.round(30e-6 * sr));
      const packetGap = Math.round(15e-3 * sr);
      const maxPulseLen = Math.round(0.1 * sr);
      const n = u8.length >> 1;
      let env = this.env, noise = this.noise, dcI = this.dcI, dcQ = this.dcQ;
      if (noise < 0) {
        const m = Math.min(n, 4096); let s = 0;
        for (let i = 0; i < m; i++) { const I = u8[2 * i] - 127.4, Q = u8[2 * i + 1] - 127.4; s += Math.sqrt(I * I + Q * Q); }
        noise = Math.max(0.3, s / m); env = noise;
      }
      let blockMax = 0;
      for (let i = 0; i < n; i++) {
        const I0 = u8[2 * i] - 127.4, Q0 = u8[2 * i + 1] - 127.4;
        dcI += (I0 - dcI) * 1e-5; dcQ += (Q0 - dcQ) * 1e-5;
        const I = I0 - dcI, Q = Q0 - dcQ;
        const mag = Math.sqrt(I * I + Q * Q);
        env += (mag - env) * 0.5;
        const t = this.t + i;
        const r = env / noise; if (r > blockMax) blockMax = r;
        if (!this.inPulse) {
          if (env > noise * kOn) {
            if (this.pkt && this.pkt.w.length && t - this.lastEnd < minPulse) {
              // tiny dropout inside a pulse: merge with the previous pulse
              const w = this.pkt.w.pop(); this.pkt.g.pop();
              this.pulseStart = this.lastEnd - w;
            } else {
              if (!this.pkt) this.pkt = { w: [], g: [], start: t, peakSum: 0, peakN: 0, noise };
              else if (this.pkt.g.length) this.pkt.g[this.pkt.g.length - 1] = t - this.lastEnd;
              this.pulseStart = t;
            }
            this.inPulse = true; this.peak = env;
          } else {
            noise += (mag - noise) * 2e-4;
            if (noise < 0.3) noise = 0.3;
            if (this.pkt && t - this.lastEnd > packetGap) this._finish(t);
          }
        } else {
          if (env > this.peak) this.peak = env;
          if (env < Math.max(noise * kOn * 0.7, this.peak * 0.3)) {
            const w = t - this.pulseStart;
            this.inPulse = false;
            if (w < minPulse) {
              if (this.pkt && this.pkt.w.length === 0) this.pkt = null;
            } else {
              this.pkt.w.push(w); this.pkt.g.push(0);
              this.pkt.peakSum += this.peak; this.pkt.peakN++;
              this.lastEnd = t;
              if (this.pkt.w.length >= 4000) this._finish(t);
            }
          } else if (t - this.pulseStart > maxPulseLen) {
            // continuous carrier: give up on this packet and re-learn the floor
            this.inPulse = false; this.pkt = null; noise = env;
          }
        }
      }
      this.t += n;
      this.env = env; this.noise = noise; this.dcI = dcI; this.dcQ = dcQ;
      this.blockSnrDb = 20 * Math.log10(Math.max(blockMax, 1));
      this.noiseDbfs = 20 * Math.log10(noise / 128);
    }
    _finish(t) {
      const p = this.pkt; this.pkt = null;
      if (!p || p.w.length < 6) return;
      p.g[p.g.length - 1] = t - this.lastEnd;
      const k = 1e6 / this.sr;
      const peak = p.peakSum / p.peakN;
      this.onPacket({
        time: Date.now(),
        w: p.w.map(x => Math.round(x * k)),
        g: p.g.map(x => Math.round(x * k)),
        rssi: 20 * Math.log10(peak / 128),
        snr: 20 * Math.log10(peak / p.noise),
      });
    }
  }

  // ---------------------------------------------------------------- helpers
  function rows(pkt, gapLimit) {
    const out = []; let s = 0;
    for (let i = 0; i < pkt.w.length; i++) {
      if (pkt.g[i] > gapLimit || i === pkt.w.length - 1) { out.push([s, i + 1]); s = i + 1; }
    }
    return out;
  }
  // PPM: bit from the gap after each pulse, except the last pulse in the row.
  function ppmBits(pkt, s, e, short, long, maxPulse) {
    const th = (short + long) / 2, bits = [];
    for (let i = s; i < e - 1; i++) {
      const g = pkt.g[i];
      if (g < short * 0.5 || g > long * 1.6) return null;
      if (maxPulse && pkt.w[i] > maxPulse) return null;
      bits.push(g > th ? 1 : 0);
    }
    return bits;
  }
  function bytesOf(bits) {
    const b = new Array(Math.ceil(bits.length / 8)).fill(0);
    for (let i = 0; i < bits.length; i++) if (bits[i]) b[i >> 3] |= 0x80 >> (i & 7);
    return b;
  }
  function intOf(bits, s, n) { let v = 0; for (let i = s; i < s + n; i++) v = v * 2 + bits[i]; return v; }
  function hexOf(bits) {
    let h = '';
    for (let i = 0; i < bits.length; i += 4) {
      let v = 0; for (let j = 0; j < 4; j++) v = (v << 1) | (bits[i + j] || 0);
      h += v.toString(16);
    }
    return h;
  }
  function crc8(bytes, poly, init) {
    let r = init;
    for (const x of bytes) { r ^= x; for (let i = 0; i < 8; i++) r = (r & 0x80) ? ((r << 1) ^ poly) & 0xff : (r << 1) & 0xff; }
    return r;
  }
  function median(a) { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }
  function countRows(list) {
    const m = new Map();
    for (const bits of list) { const k = bits.join(''); m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].map(([k, c]) => ({ bits: [...k].map(Number), count: c }));
  }
  const s12 = v => (v & 0x800 ? v - 0x1000 : v);

  // ---------------------------------------------------------------- decoders
  // Each returns an array of { model, id, channel?, data: {...}, key }

  // Nexus / Rubicson / many Clas Ohlson & Kjell sensors. PPM 1000/2000 µs, 36 bits.
  function nexus(pkt) {
    const list = [];
    for (const [s, e] of rows(pkt, 3000)) {
      const bits = ppmBits(pkt, s, e, 1000, 2000, 900);
      if (bits && (bits.length === 36 || bits.length === 37)) list.push(bits.slice(0, 36));
    }
    const out = [];
    for (const { bits, count } of countRows(list)) {
      if (count < 2) continue;
      const b = bytesOf(bits);
      if ((b[3] & 0xf0) !== 0xf0) continue;
      const temp = s12(((b[1] & 0x0f) << 8) | b[2]) / 10;
      if (temp < -50 || temp > 80) continue;
      const hum = ((b[3] & 0x0f) << 4) | (b[4] >> 4);
      const ch = ((b[1] >> 4) & 3) + 1;
      const data = { temperature_C: temp, battery: (b[1] & 0x80) ? 'OK' : 'LOW' };
      if (hum <= 100) data.humidity = hum;
      out.push({ model: hum <= 100 ? 'Nexus-TH' : 'Nexus/Rubicson-T', id: b[0], channel: ch, data, repeats: count });
    }
    return out;
  }

  // Prologue / some Clas Ohlson sensors. PPM 2000/4000 µs, 36 bits, first nibble 9 or 5.
  function prologue(pkt) {
    const list = [];
    for (const [s, e] of rows(pkt, 7000)) {
      const bits = ppmBits(pkt, s, e, 2000, 4000, 1200);
      if (bits && (bits.length === 36 || bits.length === 37)) list.push(bits.slice(0, 36));
    }
    const out = [];
    for (const { bits, count } of countRows(list)) {
      if (count < 2) continue;
      const b = bytesOf(bits);
      const type = b[0] >> 4;
      if (type !== 9 && type !== 5) continue;
      const temp = s12((b[2] << 4) | (b[3] >> 4)) / 10;
      if (temp < -50 || temp > 80) continue;
      const hum = ((b[3] & 0x0f) << 4) | (b[4] >> 4);
      const data = { temperature_C: temp, battery: (b[1] & 0x08) ? 'OK' : 'LOW', button: (b[1] & 0x04) ? 1 : 0 };
      if (hum <= 100) data.humidity = hum;
      out.push({ model: 'Prologue-TH', id: ((b[0] & 0x0f) << 4) | (b[1] >> 4), channel: (b[1] & 3) + 1, data, repeats: count });
    }
    return out;
  }

  // Nexa / Proove / Anslut / Telldus self-learning switches & remotes. T≈250 µs.
  function nexa(pkt) {
    const out = [], seen = new Set();
    for (const [s, e] of rows(pkt, 2000)) {
      if (e - s !== 65) continue;
      const phys = ppmBits(pkt, s, e, 250, 1300, 600);
      if (!phys || phys.length !== 64) continue;
      const bits = [];
      let ok = true;
      for (let i = 0; i < 64; i += 2) {
        if (phys[i] === 0 && phys[i + 1] === 1) bits.push(0);
        else if (phys[i] === 1 && phys[i + 1] === 0) bits.push(1);
        else { ok = false; break; }
      }
      if (!ok) continue;
      const k = bits.join(''); if (seen.has(k)) continue; seen.add(k);
      const house = intOf(bits, 0, 26);
      out.push({
        model: 'Nexa/Proove (self-learning)', id: house, channel: intOf(bits, 28, 4) + 1,
        data: { state: bits[27] ? 'ON' : 'OFF', group: bits[26] ? 'yes' : 'no', unit: intOf(bits, 28, 4) + 1 },
      });
    }
    return out;
  }

  // EV1527 / PT2262 style fixed-code remotes, door/PIR sensors, doorbells. PWM, 24 bits.
  function ev1527(pkt) {
    const list = [];
    let T = 0;
    for (const [s, e] of rows(pkt, 3000)) {
      const len = e - s;
      if (len !== 24 && len !== 25) continue;
      const per = [];
      for (let i = s; i < s + 23; i++) per.push(pkt.w[i] + pkt.g[i]);
      const P = median(per);
      if (P < 400 || P > 2800) continue;
      if (per.some(p => Math.abs(p - P) > P * 0.3)) continue;
      const bits = []; let ok = true;
      for (let i = s; i < s + 24; i++) {
        const r = pkt.w[i] / P;
        if (r > 0.1 && r < 0.42) bits.push(0);
        else if (r > 0.58 && r < 0.9) bits.push(1);
        else { ok = false; break; }
      }
      if (!ok) continue;
      if (len === 25 && pkt.w[s + 24] > P * 0.45) continue; // trailing sync pulse should be short
      list.push(bits); T = P / 4;
    }
    const out = [];
    for (const { bits, count } of countRows(list)) {
      if (count < 2) continue;
      const code = intOf(bits, 0, 24);
      if (code === 0 || code === 0xffffff) continue;
      out.push({
        model: 'EV1527/PT2262 remote', id: (code >> 4).toString(16).padStart(5, '0'),
        data: { code: code.toString(16).padStart(6, '0'), buttons: (code & 15).toString(2).padStart(4, '0'), T_us: Math.round(T) },
        repeats: count,
      });
    }
    return out;
  }

  // Fine Offset WH2 / Renkforce / Agimex / Telldus FT007TH-ish. PWM short=1 long=0, 48 bits, CRC-8.
  function wh2(pkt) {
    const out = [], seen = new Set();
    for (const [s, e] of rows(pkt, 3000)) {
      if (e - s < 48 || e - s > 52) continue;
      const bits = [];
      for (let i = s; i < e; i++) {
        const w = pkt.w[i];
        if (w < 250 || w > 2200) { bits.length = 0; break; }
        bits.push(w < 1000 ? 1 : 0);
      }
      for (let k = 0; k + 48 <= bits.length; k++) {
        const b = bytesOf(bits.slice(k, k + 48));
        if (b[0] !== 0xff || crc8(b.slice(1, 5), 0x31, 0) !== b[5]) continue;
        const key = b.join(','); if (seen.has(key)) break; seen.add(key);
        const raw = ((b[2] & 0x07) << 8) | b[3];
        const temp = ((b[2] & 0x08) ? -raw : raw) / 10;
        out.push({ model: 'Fine Offset WH2', id: (b[1] << 4) | (b[2] >> 4), data: { temperature_C: temp, humidity: b[4] } });
        break;
      }
    }
    return out;
  }

  const DECODERS = [nexus, prologue, nexa, ev1527, wh2];

  // ---------------------------------------------------------------- analyzer
  function clusters(vals) {
    const s = [...vals].sort((a, b) => a - b), out = [];
    let cur = null;
    for (const v of s) {
      if (!cur || v > cur.max * 1.45) { cur = { min: v, max: v, sum: 0, n: 0 }; out.push(cur); }
      cur.max = v; cur.sum += v; cur.n++;
    }
    return out.map(c => ({ c: c.sum / c.n, n: c.n, min: c.min, max: c.max }));
  }

  function analyze(pkt) {
    const n = pkt.w.length;
    if (n < 10) return null;
    const minCount = Math.max(2, Math.round(n * 0.04));
    const wc = clusters(pkt.w).filter(c => c.n >= minCount);
    const gAll = clusters(pkt.g.slice(0, n - 1));
    // Separate row-separator gaps (rare and much longer) from data gaps.
    let data = gAll.slice();
    while (data.length > 1) {
      const last = data[data.length - 1], prev = data[data.length - 2];
      if (last.n <= Math.max(2, (n - 1) * 0.2) && last.c > prev.max * 2) data.pop(); else break;
    }
    const dataG = data.filter(c => c.n >= minCount);
    const sepTh = data.length ? data[data.length - 1].max * 1.5 : Infinity;
    let mod = 'unknown', bitFn = null, info = '';
    if (wc.length === 2 && dataG.length <= 2) {
      const th = Math.sqrt(wc[0].c * wc[1].c);
      mod = 'PWM'; info = `short ${Math.round(wc[0].c)} µs / long ${Math.round(wc[1].c)} µs pulses (short=1)`;
      bitFn = (i, last) => (pkt.w[i] < th ? 1 : 0);
    } else if (wc.length === 1 && dataG.length === 2) {
      const th = Math.sqrt(dataG[0].c * dataG[1].c);
      mod = 'PPM'; info = `${Math.round(wc[0].c)} µs pulses, gaps ${Math.round(dataG[0].c)} / ${Math.round(dataG[1].c)} µs (long=1)`;
      bitFn = (i, last) => (last ? null : (pkt.g[i] > th ? 1 : 0));
    } else {
      mod = wc.length <= 2 && dataG.length <= 3 ? 'Manchester/NRZ?' : 'complex';
      info = `pulses ${wc.map(c => Math.round(c.c)).join('/')} µs, gaps ${dataG.map(c => Math.round(c.c)).join('/')} µs`;
    }
    const rowList = [];
    let s = 0;
    for (let i = 0; i < n; i++) {
      if (pkt.g[i] > sepTh || i === n - 1) { rowList.push([s, i + 1]); s = i + 1; }
    }
    let rowBits = [];
    if (bitFn) {
      for (const [a, b] of rowList) {
        const bits = [];
        for (let i = a; i < b; i++) { const v = bitFn(i, i === b - 1); if (v !== null) bits.push(v); }
        if (bits.length) rowBits.push(bits);
      }
    }
    const counted = countRows(rowBits.filter(r => r.length >= 8)).sort((x, y) => y.count - x.count || y.bits.length - x.bits.length);
    const best = counted[0] ? { hex: hexOf(counted[0].bits), len: counted[0].bits.length, count: counted[0].count } : null;
    return {
      modulation: mod, info, pulses: n, rows: rowList.length,
      rowsHex: rowBits.slice(0, 12).map(r => ({ len: r.length, hex: hexOf(r) })), best,
    };
  }

  function decodePacket(pkt) {
    const msgs = [];
    for (const d of DECODERS) {
      try { for (const m of d(pkt)) msgs.push(m); } catch (e) { /* decoder bug: ignore */ }
    }
    return msgs;
  }

  // ---------------------------------------------------------------- synthesizer (for tests / demo)
  const Enc = {
    nexus(id, ch, temp, hum, battOk = true, reps = 8) {
      const t = Math.round(temp * 10) & 0xfff;
      const bits = [...toBits(id, 8), battOk ? 1 : 0, 0, ...toBits(ch - 1, 2), ...toBits(t, 12), 1, 1, 1, 1, ...toBits(hum, 8)];
      const w = [], g = [];
      for (let r = 0; r < reps; r++) {
        for (const b of bits) { w.push(500); g.push(b ? 2000 : 1000); }
        w.push(500); g.push(4000);
      }
      g[g.length - 1] = 40000;
      return { w, g };
    },
    prologue(id, ch, temp, hum, reps = 7) {
      const t = Math.round(temp * 10) & 0xfff;
      const bits = [...toBits(9, 4), ...toBits(id, 8), 1, 0, ...toBits(ch - 1, 2), ...toBits(t, 12), ...toBits(hum, 8)];
      const w = [], g = [];
      for (let r = 0; r < reps; r++) {
        for (const b of bits) { w.push(500); g.push(b ? 4000 : 2000); }
        w.push(500); g.push(9000);
      }
      g[g.length - 1] = 40000;
      return { w, g };
    },
    nexa(house, unit, on, group = false, reps = 5, T = 260) {
      const bits = [...toBits(house, 26), group ? 1 : 0, on ? 1 : 0, ...toBits(unit - 1, 4)];
      const w = [], g = [];
      for (let r = 0; r < reps; r++) {
        w.push(T); g.push(10 * T);
        for (const b of bits) {
          if (b) { w.push(T, T); g.push(5 * T, T); } else { w.push(T, T); g.push(T, 5 * T); }
        }
        w.push(T); g.push(40 * T);
      }
      g[g.length - 1] = 40000;
      return { w, g };
    },
    ev1527(code, T = 350, reps = 8) {
      const bits = toBits(code, 24);
      const w = [], g = [];
      w.push(T); g.push(31 * T);
      for (let r = 0; r < reps; r++) {
        for (const b of bits) { if (b) { w.push(3 * T); g.push(T); } else { w.push(T); g.push(3 * T); } }
        w.push(T); g.push(31 * T);
      }
      g[g.length - 1] = 40000;
      return { w, g };
    },
    wh2(id, temp, hum) {
      const raw = Math.round(Math.abs(temp) * 10) & 0x7ff;
      const b = [0xff, (id >> 4) & 0xff, ((id & 0xf) << 4) | (temp < 0 ? 8 : 0) | (raw >> 8), raw & 0xff, hum];
      b.push(crc8(b.slice(1, 5), 0x31, 0));
      const w = [], g = [];
      for (const x of b) for (const bit of toBits(x, 8)) { w.push(bit ? 500 : 1500); g.push(1000); }
      g[g.length - 1] = 40000;
      return { w, g };
    },
  };
  function toBits(v, n) { const a = []; for (let i = n - 1; i >= 0; i--) a.push((v >> i) & 1); return a; }

  // Turn pulse trains into RTL-SDR style interleaved u8 IQ.
  function synthIQ(sr, trains, { snrDb = 20, noiseRms = 3, freqHz = 30000, lead = 0.05 } = {}) {
    const amp = noiseRms * Math.SQRT2 * Math.pow(10, snrDb / 20);
    const segs = [];
    let total = Math.round(lead * sr);
    for (const tr of trains) for (let i = 0; i < tr.w.length; i++) {
      const w = Math.round(tr.w[i] * 1e-6 * sr), g = Math.round(tr.g[i] * 1e-6 * sr);
      segs.push([total, total + w]); total += w + g;
    }
    total += Math.round(lead * sr);
    const out = new Uint8Array(total * 2);
    let si = 0, ph = 0; const dph = 2 * Math.PI * freqHz / sr;
    for (let t = 0; t < total; t++) {
      while (si < segs.length && segs[si][1] <= t) si++;
      const on = si < segs.length && t >= segs[si][0] && t < segs[si][1];
      ph += dph;
      let I = gauss() * noiseRms, Q = gauss() * noiseRms;
      if (on) { I += amp * Math.cos(ph); Q += amp * Math.sin(ph); }
      out[2 * t] = Math.max(0, Math.min(255, Math.round(127.4 + I)));
      out[2 * t + 1] = Math.max(0, Math.min(255, Math.round(127.4 + Q)));
    }
    return out;
  }
  function gauss() { let u = 0, v = 0; while (u === 0) u = Math.random(); v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  const api = { PulseDetector, decodePacket, analyze, Enc, synthIQ, hexOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Dec433 = api;
})(typeof window !== 'undefined' ? window : globalThis);
