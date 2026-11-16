
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
