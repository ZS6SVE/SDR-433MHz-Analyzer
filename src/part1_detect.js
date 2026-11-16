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

