// DSP worker: runs detection/decoding off the UI thread.
(function () {
  'use strict';
  const D = self.Dec433;
  const SPEC_N = 1024;
  const specFFT = D.makeFFT(SPEC_N), specWin = D.hann(SPEC_N);
  let cfg = { mode: 'bank', sr: 1024000, centerHz: 434140000, snrDb: 7 };
  let real = null, sim = null;

  // Which copy of a transmission to keep: one that decodes, else the cleanest timing.
  function rank(p) {
    p._msgs = D.decodePacket(p);
    if (p._msgs.length) return 1000 + p.snr;
    p._a = D.analyze(p);
    return p._a ? p._a.score * 100 + p.snr : p.snr - 100;
  }

  class Pipeline {
    constructor(c, isSim) {
      this.sr = c.sr; this.mode = c.mode; this.centerHz = c.centerHz; this.sim = isSim;
      this.det = c.mode === 'bank' ? new D.DualBank(c.sr, p => this.onPkt(p), rank) : new D.WideDetector(c.sr, p => this.onPkt(p));
      this.det.setSnr(c.snrDb);
      this.ringLen = c.sr * 2; this.ring = new Uint8Array(this.ringLen * 2); this.total = 0;
      this.specEvery = Math.round(c.sr / 125); this.nextSpec = 0;
      this.acc = new Float64Array(SPEC_N); this.accN = 0;
      this.re = new Float64Array(SPEC_N); this.im = new Float64Array(SPEC_N);
      this.rejected = 0; this.lastStats = 0;
    }
    feed(u8) {
      const t0 = performance.now();
      const n = u8.length >> 1;
      // keep the last 2 s of raw IQ so packets can be exported
      let w = (this.total % this.ringLen) * 2, i = 0;
      while (i < u8.length) {
        const k = Math.min(u8.length - i, this.ring.length - w);
        this.ring.set(u8.subarray(i, i + k), w); i += k; w = (w + k) % this.ring.length;
      }
      this.spectrum(u8, n);
      this.total += n;
      this.det.process(u8);
      const dt = performance.now() - t0;
      const st = this.det.stats();
      postMessage({ type: 'stats', sim: this.sim, noiseDb: st.noiseDb, peakSnrDb: st.peakSnrDb, load: dt / (n / this.sr * 1000), rejected: this.rejected });
    }
    spectrum(u8, n) {
      let s = this.nextSpec - this.total;
      if (s < 0) s = 0;
      for (; s + SPEC_N <= n; s += this.specEvery) {
        const { re, im } = this;
        for (let j = 0; j < SPEC_N; j++) { re[j] = (u8[2 * (s + j)] - 127.4) * specWin[j]; im[j] = (u8[2 * (s + j) + 1] - 127.4) * specWin[j]; }
        specFFT(re, im);
        for (let j = 0; j < SPEC_N; j++) { const k = (j + SPEC_N / 2) & (SPEC_N - 1); this.acc[j] += re[k] * re[k] + im[k] * im[k]; }
        if (++this.accN === 4) {
          const row = new Float32Array(SPEC_N);
          for (let j = 0; j < SPEC_N; j++) row[j] = 10 * Math.log10(this.acc[j] / 4 + 1e-3);
          this.acc.fill(0); this.accN = 0;
          postMessage({ type: 'spec', sim: this.sim, row, centerHz: this.centerHz, sr: this.sr }, [row.buffer]);
        }
      }
      this.nextSpec = this.total + s;
    }
    extract(a, b) {
      a = Math.max(a, this.total - this.ringLen, 0);
      b = Math.min(b, this.total);
      const len = Math.max(0, Math.min(b - a, this.sr * 1.5)) | 0;
      this.lastA = a;
      const out = new Uint8Array(len * 2);
      for (let i = 0; i < len; i++) {
        const k = ((a + i) % this.ringLen) * 2;
        out[2 * i] = this.ring[k]; out[2 * i + 1] = this.ring[k + 1];
      }
      return out;
    }
    onPkt(p) {
      const msgs = p._msgs || D.decodePacket(p);
      // analyse every packet (decoded ones too) so the detail view can show its bits
      const analysis = p._a !== undefined ? p._a : D.analyze(p);
      if (!msgs.length) {
        if (!analysis || analysis.score < 0.8) { this.rejected++; return; }
        const db = self.RTL433_DB && self.RTL433_DB.devices;
        analysis.candidates = D.candidates(analysis, !!p.fsk, db, 12).filter(c => c.score >= 0.3);
      }
      const margin = Math.round(this.sr * 0.1); // wide window so a timing slip still keeps the packet inside
      // packets are reported up to ~45 ms after they end; the ring holds 2 s
      const iq = this.extract(p.tStartRaw - margin, p.tEndRaw + margin);
      const off = p.fsk ? p.fsk.center : p.freqOff;
      const pktStartMs = Math.round((p.tStartRaw - this.lastA) / this.sr * 1000), pktEndMs = Math.round((p.tEndRaw - this.lastA) / this.sr * 1000);
      postMessage({
        pktStartMs, pktEndMs, freqOffHz: Math.round(off),
        type: 'pkt', sim: this.sim, time: Date.now(), freqHz: this.centerHz + off,
        fskDevHz: p.fsk ? Math.round(p.fsk.devHz) : 0, rssi: p.rssi, snr: p.snr,
        w: p.w.slice(0, 800), g: p.g.slice(0, 800), n: p.w.length,
        msgs, analysis, iq, sr: this.sr, centerHz: this.centerHz, harmonicHz: p.harmonicOffHz !== undefined ? this.centerHz + p.harmonicOffHz : 0,
      }, [iq.buffer]);
    }
  }

  function simScene(c) {
    const E = D.Enc, R = Math.random;
    const bank = c.mode === 'bank';
    // Simulated sensors sit around the listening frequency. In sensitive mode they are
    // made weak on purpose (near the noise floor of a 250 kHz receiver).
    const listen = c.listenHz;
    const scenes = [
      { tr: () => E.nexus(0xa7, 1, 21 + R(), 41 + Math.round(R() * 3)), f: 433.920e6 },
      { tr: () => E.ev1527(0x5c3a12, 340), f: 433.880e6 },
      { tr: () => E.prologue(0x3c, 2, -4 + R(), 78), f: 433.951e6 },
      { tr: () => E.nexa(9876543, 2, R() < 0.5), f: 433.930e6 },
      { tr: () => E.wh2(0x2b1, 6.8 + R(), 66), f: 433.905e6 },
      { tr: () => E.manchester([0xff, 0xff, 0xa5, 0x1c, 0x37, 0x42, 0x9e], 488), f: 433.972e6 },
      { tr: () => { const pat = ['LLLLSSLLLSLLLSLL', 'LLLLSSLLLLSLLLSL', 'LLLLSSLLLLLSLLLS'][Math.floor(R() * 3)], w = [], g = [];
          for (let k = 0; k < 10; k++) { for (const ch of pat) { w.push(70); g.push(ch === 'S' ? 70 : 280); } w.push(70); g.push(1470); }
          g[g.length - 1] = 40000; return { w, g }; }, f: 433.890e6 },
      { tr: () => E.nrz([0xaa, 0xaa, 0xaa, 0xaa, 0x2d, 0xd4, 0x41, 0x7e, 0x09, 0xc3, 0x55, 0xf0], 100), f: 434.000e6, fsk: 40000 },
    ];
    sim.step = (sim.step || 0) + 1;
    const sc = scenes[sim.step % scenes.length];
    const off = (sc.f - listen) + (R() - 0.5) * 6000;
    const snr250 = bank ? 3 + R() * 4 : 12 + R() * 6;
    const snr = bank ? snr250 - 6 : snr250;
    return D.synthIQ(c.sr, [sc.tr()], { snrDb: snr, freqHz: off + (listen - c.centerHz), fskDevHz: sc.fsk || 0, lead: 0.06 });
  }

  if (self.RTL433_DB) postMessage({ type: 'dbinfo', n: self.RTL433_DB.devices.length, commit: self.RTL433_DB.meta.commit || '' });

  self.onmessage = e => {
    const m = e.data;
    if (m.cmd === 'config') {
      cfg = { ...cfg, ...m.cfg };
      real = new Pipeline(cfg, false);
      sim = null;
    } else if (m.cmd === 'snr') {
      cfg.snrDb = m.snrDb;
      if (real) real.det.setSnr(m.snrDb);
      if (sim) sim.det.setSnr(m.snrDb);
    } else if (m.cmd === 'samples') {
      if (real) real.feed(new Uint8Array(m.buf));
    } else if (m.cmd === 'sim') {
      if (!sim) sim = new Pipeline(cfg, true);
      const iq = simScene(cfg);
      const step = cfg.sr >> 3;
      for (let i = 0; i < iq.length; i += step * 2) sim.feed(iq.subarray(i, i + step * 2));
    }
  };
})();
