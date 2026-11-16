// 433 MHz signal pipeline: pulse detectors (wideband + narrowband channel bank),
// protocol decoders, generic analyzer and an IQ synthesizer for testing.
// Works in a browser / worker (globalThis.Dec433) and in Node (module.exports).
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- FFT
  function makeFFT(N) {
    const lev = Math.round(Math.log2(N)), rev = new Uint32Array(N);
    for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < lev; b++) r |= ((i >> b) & 1) << (lev - 1 - b); rev[i] = r; }
    const wr = new Float64Array(N / 2), wi = new Float64Array(N / 2);
    for (let k = 0; k < N / 2; k++) { wr[k] = Math.cos(2 * Math.PI * k / N); wi[k] = -Math.sin(2 * Math.PI * k / N); }
    return function fft(re, im) {
      for (let i = 0; i < N; i++) {
        const j = rev[i];
        if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      for (let size = 2; size <= N; size <<= 1) {
        const half = size >> 1, step = N / size;
        for (let i = 0; i < N; i += size) {
          for (let j = 0, k = 0; j < half; j++, k += step) {
            const a = i + j, b = a + half;
            const tr = re[b] * wr[k] - im[b] * wi[k], ti = re[b] * wi[k] + im[b] * wr[k];
            re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          }
        }
      }
    };
  }
  function hann(N) { const w = new Float64Array(N); for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / N); return w; }

  // ---------------------------------------------------------------- envelope pulse detector
  // Feed one envelope (magnitude) sample at a time. Finds on/off pulses against an
  // adaptive noise floor and groups them into packets separated by > 15 ms of silence.
  class EnvDetector {
    constructor(rate, onPacket, o = {}) {
      this.rate = rate; this.onPacket = onPacket;
      this.alpha = o.alpha ?? 0.5;
      this.minPulse = Math.max(2, Math.round((o.minPulseUs ?? 30) * 1e-6 * rate));
      this.packetGap = Math.round(15e-3 * rate);
      this.maxPulse = Math.round(0.1 * rate);
      this.na = 1 / ((o.noiseTau ?? 0.02) * rate);
      this.noiseMin = o.noiseMin ?? 1e-9;
      this.ref = o.ref ?? 1;
      this.warm = Math.round(0.05 * rate);
      this.setSnr(8);
      this.t = 0; this.env = 0; this.noise = -1;
      this.inPulse = false; this.peak = 0;
      this.pre = new Float32Array(16); // recent envelope, to find the true rising edge
      this.rise = new Float32Array(64); this.riseN = 0; this.riseT0 = 0;
      this.pkt = null; this.lastEnd = -1e9; this.blockMax = 1; this.hold = 0;
    }
    setSnr(db) { this.snrDb = db; this.kOn = Math.pow(10, db / 20); }
    step(mag) {
      const t = this.t++;
      if (this.noise < 0) { this.noise = Math.max(mag, this.noiseMin); this.env = mag; }
      const env = (this.env += (mag - this.env) * this.alpha);
      if (t < this.warm) { this.noise += (mag - this.noise) * 0.02; this.pre[t & 15] = env; return; }
      const r = env / this.noise; if (r > this.blockMax) this.blockMax = r;
      if (!this.inPulse) {
        this.hold *= 0.8; // after a pulse, ignore its decaying tail
        if (env > this.noise * this.kOn && env > this.hold) {
          this.inPulse = true; this.peak = env;
          for (let i = 0; i < 16; i++) this.rise[i] = this.pre[(t - 16 + i) & 15];
          this.rise[16] = env; this.riseN = 17; this.riseT0 = t - 16;
        } else {
          this.noise += (mag - this.noise) * this.na;
          if (this.noise < this.noiseMin) this.noise = this.noiseMin;
          if (this.pkt && t - this.lastEnd > this.packetGap) this._finish(t);
        }
      } else {
        if (env > this.peak) this.peak = env;
        if (this.riseN < 64) this.rise[this.riseN++] = env;
        if (env < Math.max(this.noise * this.kOn * 0.7, this.peak * 0.5)) {
          this.inPulse = false; this.hold = this.peak * 0.5;
          // measure edges at half of the peak level, so window/filter smear cancels out
          const half = this.peak * 0.5;
          let st = t;
          for (let i = 0; i < this.riseN; i++) if (this.rise[i] >= half && this.riseT0 + i > this.lastEnd) { st = this.riseT0 + i; break; }
          if (t - st < this.minPulse) { /* glitch */ }
          else {
            let p = this.pkt;
            if (!p) p = this.pkt = { st: [], en: [], peakSum: 0, peakN: 0, noise: this.noise };
            if (p.en.length && st - p.en[p.en.length - 1] < this.minPulse) { p.en.pop(); st = p.st.pop(); } // bridge a dropout
            p.st.push(st); p.en.push(t);
            p.peakSum += this.peak; p.peakN++;
            this.lastEnd = t;
            if (p.st.length >= 4000) this._finish(t);
          }
        } else if (env > this.noise * this.kOn * 0.7) {
          // still on
        }
        if (this.inPulse && t - this.riseT0 > this.maxPulse) {
          this.inPulse = false; this.pkt = null; this.noise = env; // steady carrier: becomes the floor
        }
      }
      this.pre[t & 15] = env;
    }
    _finish(t) {
      const p = this.pkt; this.pkt = null;
      if (!p || p.st.length < 6) return;
      const k = 1e6 / this.rate, n = p.st.length, w = [], g = [];
      for (let i = 0; i < n; i++) {
        w.push(Math.round((p.en[i] - p.st[i]) * k));
        g.push(Math.round(((i < n - 1 ? p.st[i + 1] : t) - p.en[i]) * k));
      }
      const peak = p.peakSum / p.peakN;
      this.onPacket({
        w, g, rssi: 20 * Math.log10(peak / this.ref), snr: 20 * Math.log10(peak / p.noise),
        tStart: p.st[0], tEnd: p.en[n - 1],
      });
    }
    takeBlockMax() { const v = this.blockMax; this.blockMax = 1; return v; }
  }

  // Classic rtl_433-style detector: envelope of the whole sampled band.
  class WideDetector {
    constructor(sr, onPacket) {
      this.sr = sr; this.dcI = 0; this.dcQ = 0;
      this.det = new EnvDetector(sr, p => {
        p.freqOff = 0; p.tStartRaw = p.tStart; p.tEndRaw = p.tEnd; onPacket(p);
      }, { alpha: 0.5, minPulseUs: 30, noiseMin: 0.3, ref: 128 });
    }
    setSnr(db) { this.det.setSnr(db); }
    process(u8) {
      const n = u8.length >> 1, d = this.det;
      let dcI = this.dcI, dcQ = this.dcQ;
      for (let i = 0; i < n; i++) {
        const I0 = u8[2 * i] - 127.4, Q0 = u8[2 * i + 1] - 127.4;
        dcI += (I0 - dcI) * 1e-5; dcQ += (Q0 - dcQ) * 1e-5;
        const I = I0 - dcI, Q = Q0 - dcQ;
        d.step(Math.sqrt(I * I + Q * Q));
      }
      this.dcI = dcI; this.dcQ = dcQ;
    }
    stats() {
      return { peakSnrDb: 20 * Math.log10(this.det.takeBlockMax()), noiseDb: 20 * Math.log10(this.det.noise / 128) };
    }
  }

  // Narrowband detector: a sliding FFT splits the band into channels (two adjacent
  // bins each, overlapping), and every channel gets its own pulse detector. A weak
  // signal only competes with the noise in its own channel, not the whole band.
  class ChannelBank {
    constructor(sr, onPacket, o = {}) {
      const N = (this.N = o.N || 64);
      this.hop = o.hop || 16; this.sr = sr; this.onPacket = onPacket;
      this.chRate = sr / this.hop; this.binHz = sr / N;
      this.fft = makeFFT(N); this.win = hann(N);
      let sw = 0; for (const x of this.win) sw += x;
      this.ref = 127 * sw;
      this.re = new Float64Array(N); this.im = new Float64Array(N); this.P = new Float64Array(N);
      this.bI = new Float32Array(N); this.bQ = new Float32Array(N); this.pos = 0; this.cnt = 0;
      this.dcI = 0; this.dcQ = 0; this.frames = 0;
      this.pending = [];
      this.chans = [];
      const edge = (o.edge ?? 0.44) * sr;
      for (let c = 0; c < N - 1; c++) {
        const f = (c - N / 2 + 0.5) * this.binHz;
        if (Math.abs(f) > edge) continue;
        const ch = { c, f };
        ch.det = new EnvDetector(this.chRate, p => this._got(ch, p), { alpha: 0.4, minPulseUs: o.minPulseUs ?? 40, noiseMin: 1e-3, ref: this.ref, noiseTau: 0.05 });
        this.chans.push(ch);
      }
    }
    setSnr(db) { for (const ch of this.chans) ch.det.setSnr(db); }
    process(u8) {
      const n = u8.length >> 1, N = this.N, mask = N - 1, hop = this.hop;
      const { bI, bQ, re, im, P, win, chans } = this;
      let dcI = this.dcI, dcQ = this.dcQ, pos = this.pos, cnt = this.cnt;
      for (let i = 0; i < n; i++) {
        const I0 = u8[2 * i] - 127.4, Q0 = u8[2 * i + 1] - 127.4;
        dcI += (I0 - dcI) * 1e-5; dcQ += (Q0 - dcQ) * 1e-5;
        bI[pos] = I0 - dcI; bQ[pos] = Q0 - dcQ; pos = (pos + 1) & mask;
        if (++cnt === hop) {
          cnt = 0;
          for (let j = 0; j < N; j++) { const k = (pos + j) & mask; re[j] = bI[k] * win[j]; im[j] = bQ[k] * win[j]; }
          this.fft(re, im);
          for (let s = 0; s < N; s++) { const k = (s + N / 2) & mask; P[s] = re[k] * re[k] + im[k] * im[k]; }
          for (let c = 0; c < chans.length; c++) { const ch = chans[c]; ch.det.step(Math.sqrt(P[ch.c] + P[ch.c + 1])); }
          this.frames++;
        }
      }
      this.dcI = dcI; this.dcQ = dcQ; this.pos = pos; this.cnt = cnt;
      this._flush(false);
    }
    _got(ch, p) {
      p.ch = ch.c; p.freqOff = ch.f;
      p.tStartRaw = p.tStart * this.hop; p.tEndRaw = p.tEnd * this.hop + this.N;
      p.t0us = p.tStart / this.chRate * 1e6;
      this.pending.push(p);
    }
    // The same transmission shows up in several neighbouring channels. Keep the strongest
    // copy; a copy a few channels away whose pulses fill the gaps of the strongest one
    // is the other tone of an FSK signal.
    _flush(all) {
      if (!this.pending.length) return;
      const cutoff = this.frames - this.chRate * 0.03;
      // A packet that finished while a neighbouring channel is still receiving is
      // probably a weak copy of that transmission: wait for it so they get grouped.
      const busy = p => this.chans.some(ch => {
        const o = ch.det.pkt;
        return o && o.st.length && Math.abs(ch.c - p.ch) <= 10 && o.st[0] <= p.tEnd;
      });
      const ready = all ? this.pending : this.pending.filter(p => p.tEnd < cutoff && (p.tEnd < this.frames - this.chRate * 3 || !busy(p)));
      if (!ready.length) return;
      this.pending = all ? [] : this.pending.filter(p => p.tEnd >= cutoff);
      ready.sort((a, b) => b.snr - a.snr);
      const used = new Set(), out = [];
      for (const p of ready) {
        if (used.has(p)) continue;
        used.add(p);
        for (const q of ready) {
          if (used.has(q) || Math.abs(q.ch - p.ch) > 10 || overlap(p, q) < 0.3) continue;
          used.add(q);
          if (!p.fsk && Math.abs(q.ch - p.ch) >= 2 && q.snr > p.snr - 10 && q.w.length >= 5 && onOverlap(q, p) < 0.35) {
            p.fsk = { devHz: Math.abs(q.freqOff - p.freqOff) / 2, center: (q.freqOff + p.freqOff) / 2 };
          }
        }
        out.push(p);
      }
      out.sort((a, b) => a.tStart - b.tStart);
      // Weak copies of a transmission in neighbouring channels can break into several
      // fragments that finish after the strong copy was already reported: drop those.
      const keep = this.chRate * 5;
      this.recent = (this.recent || []).filter(q => q.tEnd > this.frames - keep);
      for (const p of out) {
        if (this.recent.some(q => Math.abs(q.ch - p.ch) <= 10 && q.snr >= p.snr && overlap(p, q) > 0.3)) continue;
        this.recent.push(p);
        this.onPacket(p);
      }
    }
    stats() {
      let mx = 1; const ns = [];
      for (const ch of this.chans) { const v = ch.det.takeBlockMax(); if (v > mx) mx = v; ns.push(ch.det.noise); }
      ns.sort((a, b) => a - b);
      return { peakSnrDb: 20 * Math.log10(mx), noiseDb: 20 * Math.log10(ns[ns.length >> 1] / this.ref) };
    }
  }
  // Two channel banks side by side: a fine one (64-point, best for slow signals) and a
  // fast one (32-point, keeps short pulses of fast remotes / FSK sensors sharp). The same
  // transmission usually shows up in both; rank() decides which copy to keep.
  class DualBank {
    constructor(sr, onPacket, rank) {
      this.sr = sr; this.onPacket = onPacket; this.rank = rank || (p => p.snr);
      this.total = 0; this.pending = [];
      this.banks = [
        new ChannelBank(sr, p => this.pending.push(p), { N: 64, hop: 32, minPulseUs: 40 }),
        new ChannelBank(sr, p => this.pending.push(p), { N: 32, hop: 8, minPulseUs: 25 }),
      ];
    }
    setSnr(db) { for (const b of this.banks) b.setSnr(db); }
    process(u8) {
      for (const b of this.banks) b.process(u8);
      this.total += u8.length >> 1;
      this._flush(false);
    }
    _flush(all) {
      if (all) for (const b of this.banks) b._flush(true);
      const cut = this.total - this.sr * 0.25;
      const ready = all ? this.pending : this.pending.filter(p => p.tEndRaw < cut);
      if (!ready.length) return;
      this.pending = all ? [] : this.pending.filter(p => p.tEndRaw >= cut);
      for (const p of ready) p._rank = this.rank(p);
      ready.sort((a, b) => b._rank - a._rank);
      const used = new Set(), out = [];
      const offOf = x => (x.fsk ? x.fsk.center : x.freqOff);
      for (const p0 of ready) {
        if (used.has(p0)) continue;
        used.add(p0);
        const group = [p0];
        for (const q of ready) {
          if (used.has(q) || Math.abs(offOf(q) - offOf(p0)) > 150000) continue;
          const s = Math.max(p0.tStartRaw, q.tStartRaw), e = Math.min(p0.tEndRaw, q.tEndRaw);
          if (Math.max(0, e - s) / Math.max(1, Math.min(p0.tEndRaw - p0.tStartRaw, q.tEndRaw - q.tStartRaw)) >= 0.3) { used.add(q); group.push(q); }
        }
        // A strong signal makes a weaker second-harmonic copy at twice its offset from the
        // centre (tuner/ADC distortion). If the kept copy has a clearly stronger partner at
        // about half its offset, report that one: it is the real carrier.
        let p = p0;
        for (const q of group) {
          if (q === p || Math.abs(offOf(p)) < 40000) continue;
          if (Math.abs(2 * offOf(q) - offOf(p)) < 40000 && Math.sign(offOf(q)) === Math.sign(offOf(p)) && q.snr > p.snr + 3 && q !== p) p = q;
        }
        if (p !== p0) p.harmonicOffHz = offOf(p0);
        out.push(p);
      }
      out.sort((a, b) => a.tStartRaw - b.tStartRaw);
      for (const p of out) this.onPacket(p);
    }
    stats() {
      const a = this.banks[0].stats(), b = this.banks[1].stats();
      return { peakSnrDb: Math.max(a.peakSnrDb, b.peakSnrDb), noiseDb: a.noiseDb };
    }
  }
  function overlap(a, b) {
    const s = Math.max(a.tStart, b.tStart), e = Math.min(a.tEnd, b.tEnd);
    return Math.max(0, e - s) / Math.max(1, Math.min(a.tEnd - a.tStart, b.tEnd - b.tStart));
  }
  function intervals(p) {
    const out = []; let t = p.t0us;
    for (let i = 0; i < p.w.length; i++) { out.push([t, t + p.w[i]]); t += p.w[i] + p.g[i]; }
    return out;
  }
  // fraction of a's "on" time that coincides with b's "on" time
  function onOverlap(a, b) {
    const A = intervals(a), B = intervals(b);
    let tot = 0, ov = 0, j = 0;
    for (const [s, e] of A) {
      tot += e - s;
      while (j < B.length && B[j][1] < s) j++;
      for (let k = j; k < B.length && B[k][0] < e; k++) ov += Math.max(0, Math.min(e, B[k][1]) - Math.max(s, B[k][0]));
    }
    return tot ? ov / tot : 0;
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

  // User's 3-button Up/Stop/Down remote (reverse engineered in URH). PPM with very short
  // timing (unit ~70 µs): 17 pulses, 16 bits per message, short gap = 1, long gap = 0.
  // Byte 0 = remote ID, byte 1 = button nibble sent twice: 4 = Up, 2 = Stop, 1 = Down.
  function upStopDown(pkt) {
    const list = []; let tim = null;
    for (const [s, e] of rows(pkt, 600)) {
      if (e - s !== 17) continue;
      const gaps = pkt.g.slice(s, s + 16), ws = pkt.w.slice(s, s + 17);
      if (ws.some(w => w > 200)) continue;
      const lo = Math.min(...gaps), hi = Math.max(...gaps);
      if (lo < 20 || hi > 500 || hi / lo < 2.2) continue;
      const th = Math.sqrt(lo * hi);
      list.push(gaps.map(g => (g < th ? 1 : 0)));
      tim = { p: median(ws), s: median(gaps.filter(g => g < th)), l: median(gaps.filter(g => g >= th)) };
    }
    const out = [];
    for (const { bits, count } of countRows(list)) {
      if (count < 2) continue;
      const id = intOf(bits, 0, 8), hiN = intOf(bits, 8, 4), loN = intOf(bits, 12, 4);
      if (hiN !== loN) continue;
      const btn = { 4: 'Up', 2: 'Stop', 1: 'Down' }[loN];
      if (!btn) continue;
      out.push({
        model: '3-button Up/Stop/Down remote', id: id.toString(16).padStart(2, '0'),
        data: { button: btn, code: hexOf(bits), timing: `${Math.round(tim.p)}/${Math.round(tim.s)}/${Math.round(tim.l)} µs` },
        repeats: count,
      });
    }
    return out;
  }

  const DECODERS = [nexus, prologue, nexa, ev1527, wh2, upStopDown];

  // ---------------------------------------------------------------- generic analyzer
  // Group values by ratio. Isolated values (glitches) are left out first, so they
  // can't bridge two real clusters.
  function clusters(vals) {
    const s = [...vals].sort((a, b) => a - b), out = [];
    const need = Math.max(2, Math.round(s.length * 0.02));
    const keep = [];
    let lo = 0, hi = 0;
    for (let i = 0; i < s.length; i++) {
      while (s[lo] < s[i] * 0.87) lo++;
      while (hi < s.length && s[hi] <= s[i] * 1.15) hi++;
      if (hi - lo >= need) keep.push(s[i]);
    }
    const src = keep.length ? keep : s;
    let cur = null;
    for (const v of src) {
      if (!cur || v > cur.max * 1.35) { cur = { min: v, max: v, sum: 0, n: 0 }; out.push(cur); }
      cur.max = v; cur.sum += v; cur.n++;
    }
    return out.map(c => ({ c: c.sum / c.n, n: c.n, min: c.min, max: c.max }));
  }
  // fraction of values within ±tol of one of the cluster centres
  function fit(vals, cs, tol) {
    if (!vals.length) return 1;
    let ok = 0;
    for (const v of vals) if (cs.some(c => Math.abs(v - c.c) <= c.c * tol)) ok++;
    return ok / vals.length;
  }
  function longestManchester(levels) {
    let best = [];
    for (let off = 0; off < 2; off++) {
      let cur = [];
      for (let i = off; i + 1 < levels.length; i += 2) {
        const a = levels[i], b = levels[i + 1];
        if (a !== b) { cur.push(a); } else { if (cur.length > best.length) best = cur; cur = []; }
      }
      if (cur.length > best.length) best = cur;
    }
    return best;
  }

  function analyze(pkt) {
    const n = pkt.w.length;
    if (n < 8) return null;
    const minCount = Math.max(2, Math.round(n * 0.04));
    const gInner = pkt.g.slice(0, n - 1);
    // Row separators: rare gaps much longer than the data gaps.
    let gc = clusters(gInner);
    while (gc.length > 1) {
      const last = gc[gc.length - 1], prev = gc[gc.length - 2];
      if (last.n <= Math.max(2, (n - 1) * 0.2) && last.c > prev.max * 1.6) gc.pop(); else break;
    }
    const sepTh = gc.length ? gc[gc.length - 1].max * 1.5 : Infinity;
    const dataGaps = gInner.filter(g => g <= sepTh);
    const wc = clusters(pkt.w).filter(c => c.n >= minCount);
    const dataG = gc.filter(c => c.n >= minCount);
    // How "clean" is the timing? Random noise blips have scattered widths.
    let score = Math.min(fit(pkt.w, wc.slice(0, 4), 0.3), fit(dataGaps, dataG.slice(0, 4), 0.3));

    const rowList = []; let s = 0;
    for (let i = 0; i < n; i++) if (pkt.g[i] > sepTh || i === n - 1) { rowList.push([s, i + 1]); s = i + 1; }

    let mod = 'complex', info = '', kind = 'bits', timing = null;
    const rowsOut = [];
    const per = []; for (let i = 0; i < n - 1; i++) if (pkt.g[i] <= sepTh) per.push(pkt.w[i] + pkt.g[i]);
    const pm = per.length ? median(per) : 0;
    const periodConst = per.length > 4 && per.filter(p => Math.abs(p - pm) < pm * 0.2).length / per.length > 0.85;
    // NRZ test: are (almost) all pulse and gap lengths whole multiples of one unit T?
    // Detectors tend to stretch pulses and shrink gaps by a fixed amount (or the reverse),
    // so try a range of edge-bias corrections and keep the best fit.
    let T = NaN, nrzFit = false, nrzBias = 0; const mults = new Set();
    const base = Math.min(wc.length ? wc[0].c : Infinity, dataG.length ? dataG[0].c : Infinity);
    if (isFinite(base) && base > 0) {
      let bestFit = 0;
      for (let k = -7; k <= 7; k++) {
        const b = k * 0.05 * base;
        const T0 = Math.min(wc.length ? wc[0].c - b : Infinity, dataG.length ? dataG[0].c + b : Infinity);
        if (!(T0 > 0)) continue;
        const vals = pkt.w.map(v => v - b).concat(gInner.filter(g => g <= 12.5 * T0).map(v => v + b));
        let num = 0, den = 0, okN = 0; const mc = new Map();
        for (const v of vals) {
          const m = Math.round(v / T0);
          if (m >= 1 && m <= 12 && Math.abs(v - m * T0) <= 0.25 * T0) { okN++; num += v; den += m; mc.set(m, (mc.get(m) || 0) + 1); }
        }
        const f = okN / vals.length;
        if (f > bestFit + 1e-9 || (Math.abs(f - bestFit) < 1e-9 && Math.abs(b) < Math.abs(nrzBias))) {
          bestFit = f; nrzBias = b; T = den ? num / den : T0;
          mults.clear(); for (const [m, c] of mc) if (c >= 2) mults.add(m);
        }
      }
      nrzFit = bestFit >= 0.9;
      if (nrzFit) score = Math.max(score, bestFit);
    }
    const minW = wc.length ? wc[0].c : 0, minG = dataG.length ? dataG[0].c : 0;
    const nrzFirst = nrzFit && wc.length >= 2 && Math.abs((minW - nrzBias) - (minG + nrzBias)) < T * 0.3 && (!periodConst || mults.size >= 3);
    if (nrzFirst) {
      // fall through to the NRZ branch below
    } else if (wc.length === 2 && dataG.length <= 2 && (periodConst || dataG.length === 1)) {
      const th = Math.sqrt(wc[0].c * wc[1].c);
      timing = { coding: 'PWM', short: wc[0].c, long: wc[1].c };
      mod = 'PWM'; info = `pulses ${r(wc[0].c)} / ${r(wc[1].c)} µs (short=1), period ${r(pm)} µs ≈ ${r(1e6 / pm)} bps`;
      for (const [a, b] of rowList) { const bits = []; for (let i = a; i < b; i++) bits.push(pkt.w[i] < th ? 1 : 0); rowsOut.push(bits); }
    } else if (wc.length === 1 && dataG.length === 2) {
      const th = Math.sqrt(dataG[0].c * dataG[1].c);
      timing = { coding: 'PPM', short: dataG[0].c, long: dataG[1].c };
      mod = 'PPM'; info = `pulse ${r(wc[0].c)} µs, gaps ${r(dataG[0].c)} / ${r(dataG[1].c)} µs (long=1)`;
      for (const [a, b] of rowList) { const bits = []; for (let i = a; i < b - 1; i++) bits.push(pkt.g[i] > th ? 1 : 0); if (bits.length) rowsOut.push(bits); }
    }
    if (!rowsOut.length && mod === 'complex' && nrzFit) {
      mod = 'NRZ/Manchester'; kind = 'nrz'; timing = { coding: 'NRZ', unit: T };
      info = `unit ${r(T)} µs ≈ ${r(1e6 / T)} baud`;
      // In NRZ data long zero runs are normal, so only split rows at really long gaps.
      const nrzSep = Math.max(sepTh, 12 * T);
      rowList.length = 0; let s2 = 0;
      for (let i = 0; i < n; i++) if (pkt.g[i] > nrzSep || i === n - 1) { rowList.push([s2, i + 1]); s2 = i + 1; }
      for (const [a, b] of rowList) {
        const lv = [];
        for (let i = a; i < b; i++) {
          for (let k = Math.max(1, Math.round((pkt.w[i] - nrzBias) / T)); k > 0; k--) lv.push(1);
          if (i < b - 1) for (let k = Math.max(1, Math.round((pkt.g[i] + nrzBias) / T)); k > 0; k--) lv.push(0);
        }
        rowsOut.push(lv);
      }
    }
    if (!rowsOut.length && mod === 'complex') {
      info = `pulses ${wc.map(c => r(c.c)).join('/')} µs, gaps ${dataG.map(c => r(c.c)).join('/')} µs`;
    }

    const rowsHex = [];
    for (const bits of rowsOut.slice(0, 10)) {
      rowsHex.push({ kind: kind === 'nrz' ? 'NRZ' : mod, len: bits.length, hex: hexOf(bits) });
      if (kind === 'nrz') {
        const mc = longestManchester(bits);
        if (mc.length >= 12) rowsHex.push({ kind: 'MC', len: mc.length, hex: hexOf(mc) });
      }
    }
    const counted = countRows(rowsOut.filter(x => x.length >= 8)).sort((x, y) => y.count - x.count || y.bits.length - x.bits.length);
    const best = counted[0] ? { hex: hexOf(counted[0].bits), len: counted[0].bits.length, count: counted[0].count } : null;
    if (timing) timing.rowLens = [...new Set(rowsHex.map(x => x.len))];
    return { modulation: mod, info, pulses: n, rows: rowList.length, rowsHex, best, score, timing };
  }

  // Rank known devices (e.g. the rtl_433 database) by how well their modulation,
  // timing and message length match an analysed packet.
  function candidates(a, isFsk, db, max = 5) {
    const t = a && a.timing;
    if (!t || !db) return [];
    const rel = (x, y) => Math.abs(x - y) / y;
    const out = [];
    for (const d of db) {
      if (d.carrier === 'LORA' || d.disabled) continue;
      let errs;
      if (d.coding === 'PPM' || d.coding === 'PWM') {
        if (t.coding !== d.coding || !d.long || d.long === d.short) continue;
        errs = [rel(t.short, d.short), rel(t.long, d.long)];
      } else {
        if (t.coding !== 'NRZ') continue;
        errs = [rel(t.unit, d.short)];
      }
      const e = Math.max(...errs);
      if (e > 0.35) continue;
      let score = 1 - e / 0.35 * 0.6; // timing alone: 0.4 .. 1
      const why = [`${d.coding} ${d.coding === 'PPM' || d.coding === 'PWM' ? Math.round(d.short) + '/' + Math.round(d.long) : Math.round(d.short)} µs`];
      const lens = t.rowLens || [];
      if (d.bits && d.bits.length) {
        if (lens.some(l => d.bits.some(b => Math.abs(b - l) <= 1))) { score += 0.3; why.push(`${d.bits.join('/')} bits ✓`); }
        else score -= 0.15;
      } else if (d.minBits || d.maxBits) {
        if (lens.some(l => l >= (d.minBits || 0) - 1 && l <= (d.maxBits || 1e9) + 1)) { score += 0.15; why.push('bit count ✓'); }
        else score -= 0.1;
      }
      const carrierOk = isFsk ? d.carrier === 'FSK' : d.carrier === 'OOK';
      if (!carrierOk) score *= isFsk ? 0.5 : 0.75; // FSK can go undetected, so only a mild penalty
      else if (isFsk) why.push('FSK ✓');
      out.push({ name: d.name, src: d.src, score: Math.max(0, Math.min(1, score / 1.3)), why: why.join(', ') });
    }
    out.sort((x, y) => y.score - x.score);
    // collapse identical names (several variants in one file)
    const seen = new Set();
    return out.filter(c => (seen.has(c.name) ? false : seen.add(c.name))).slice(0, max);
  }
  const r = x => Math.round(x);

  function decodePacket(pkt) {
    const msgs = [];
    for (const d of DECODERS) {
      try { for (const m of d(pkt)) msgs.push(m); } catch (e) { /* ignore decoder errors */ }
    }
    return msgs;
  }

  // ---------------------------------------------------------------- synthesizer (tests / demo)
  function toBits(v, n) { const a = []; for (let i = n - 1; i >= 0; i--) a.push(Math.floor(v / 2 ** i) & 1); return a; }
  function fromLevels(levels, T, endGap = 40000) {
    // NRZ levels (1 = carrier/mark) -> pulse/gap lists
    const w = [], g = [];
    let i = 0;
    while (i < levels.length && !levels[i]) i++;
    while (i < levels.length) {
      let a = 0; while (i < levels.length && levels[i]) { a++; i++; }
      let z = 0; while (i < levels.length && !levels[i]) { z++; i++; }
      w.push(a * T); g.push(z * T);
    }
    g[g.length - 1] = endGap;
    return { w, g };
  }
  const Enc = {
    nexus(id, ch, temp, hum, battOk = true, reps = 8) {
      const t = Math.round(temp * 10) & 0xfff;
      const bits = [...toBits(id, 8), battOk ? 1 : 0, 0, ...toBits(ch - 1, 2), ...toBits(t, 12), 1, 1, 1, 1, ...toBits(hum, 8)];
      const w = [], g = [];
      for (let k = 0; k < reps; k++) { for (const b of bits) { w.push(500); g.push(b ? 2000 : 1000); } w.push(500); g.push(4000); }
      g[g.length - 1] = 40000; return { w, g };
    },
    prologue(id, ch, temp, hum, reps = 7) {
      const t = Math.round(temp * 10) & 0xfff;
      const bits = [...toBits(9, 4), ...toBits(id, 8), 1, 0, ...toBits(ch - 1, 2), ...toBits(t, 12), ...toBits(hum, 8)];
      const w = [], g = [];
      for (let k = 0; k < reps; k++) { for (const b of bits) { w.push(500); g.push(b ? 4000 : 2000); } w.push(500); g.push(9000); }
      g[g.length - 1] = 40000; return { w, g };
    },
    nexa(house, unit, on, group = false, reps = 5, T = 260) {
      const bits = [...toBits(house, 26), group ? 1 : 0, on ? 1 : 0, ...toBits(unit - 1, 4)];
      const w = [], g = [];
      for (let k = 0; k < reps; k++) {
        w.push(T); g.push(10 * T);
        for (const b of bits) { w.push(T, T); if (b) g.push(5 * T, T); else g.push(T, 5 * T); }
        w.push(T); g.push(40 * T);
      }
      g[g.length - 1] = 40000; return { w, g };
    },
    ev1527(code, T = 350, reps = 8) {
      const bits = toBits(code, 24), w = [T], g = [31 * T];
      for (let k = 0; k < reps; k++) {
        for (const b of bits) { if (b) { w.push(3 * T); g.push(T); } else { w.push(T); g.push(3 * T); } }
        w.push(T); g.push(31 * T);
      }
      g[g.length - 1] = 40000; return { w, g };
    },
    wh2(id, temp, hum) {
      const raw = Math.round(Math.abs(temp) * 10) & 0x7ff;
      const b = [0xff, (id >> 4) & 0xff, ((id & 0xf) << 4) | (temp < 0 ? 8 : 0) | (raw >> 8), raw & 0xff, hum];
      b.push(crc8(b.slice(1, 5), 0x31, 0));
      const w = [], g = [];
      for (const x of b) for (const bit of toBits(x, 8)) { w.push(bit ? 500 : 1500); g.push(1000); }
      g[g.length - 1] = 40000; return { w, g };
    },
    // NRZ frame (e.g. FSK sensors): preamble 0xAAAA.. + sync + payload, unit T µs
    nrz(bytes, T = 100) {
      const lv = []; for (const x of bytes) lv.push(...toBits(x, 8));
      return fromLevels(lv, T);
    },
    // Manchester (10 = 1, 01 = 0), half-bit T µs, repeated
    manchester(bytes, T = 488, reps = 2) {
      const lv = [];
      for (let k = 0; k < reps; k++) {
        for (const x of bytes) for (const bit of toBits(x, 8)) lv.push(...(bit ? [1, 0] : [0, 1]));
        for (let z = 0; z < 20; z++) lv.push(0);
      }
      return fromLevels(lv, T);
    },
  };

  // Pulse trains -> RTL-SDR style interleaved u8 IQ. OOK by default; with fskDevHz the
  // carrier stays on for the whole train and pulses/gaps become mark/space tones.
  function synthIQ(sr, trains, { snrDb = 20, noiseRms = 3, freqHz = 30000, fskDevHz = 0, lead = 0.05 } = {}) {
    const amp = noiseRms * Math.SQRT2 * Math.pow(10, snrDb / 20);
    const segs = [], spans = [];
    let total = Math.round(lead * sr);
    for (const tr of trains) {
      const s0 = total;
      for (let i = 0; i < tr.w.length; i++) {
        const w = Math.round(tr.w[i] * 1e-6 * sr), g = Math.round(tr.g[i] * 1e-6 * sr);
        segs.push([total, total + w]); total += w + g;
        if (i === tr.w.length - 1) spans.push([s0, total - g]);
      }
    }
    total += Math.round(lead * sr);
    const out = new Uint8Array(total * 2);
    let si = 0, pi = 0, ph = 0;
    for (let t = 0; t < total; t++) {
      while (si < segs.length && segs[si][1] <= t) si++;
      while (pi < spans.length && spans[pi][1] <= t) pi++;
      const on = si < segs.length && t >= segs[si][0];
      let I = gauss() * noiseRms, Q = gauss() * noiseRms;
      if (fskDevHz) {
        if (pi < spans.length && t >= spans[pi][0]) {
          ph += 2 * Math.PI * (freqHz + (on ? fskDevHz : -fskDevHz)) / sr;
          I += amp * Math.cos(ph); Q += amp * Math.sin(ph);
        }
      } else {
        ph += 2 * Math.PI * freqHz / sr;
        if (on) { I += amp * Math.cos(ph); Q += amp * Math.sin(ph); }
      }
      out[2 * t] = Math.max(0, Math.min(255, Math.round(127.4 + I)));
      out[2 * t + 1] = Math.max(0, Math.min(255, Math.round(127.4 + Q)));
    }
    return out;
  }
  function gauss() { let u = 0; while (u === 0) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); }

  const api = { candidates, DualBank, EnvDetector, WideDetector, ChannelBank, makeFFT, hann, decodePacket, analyze, Enc, synthIQ, hexOf, crc8 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Dec433 = api;
})(typeof self !== 'undefined' ? self : globalThis);
