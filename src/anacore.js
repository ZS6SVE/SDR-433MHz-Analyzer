  // ===== Analyzer core: pure functions (decoding, matching, checksums, similarity) =====
  const AC = (() => {
    const med = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
    // split values into two clusters; returns threshold (geometric middle) or 0 when there is one cluster
    function twoMeans(vals) {
      const v = vals.filter(x => x > 0).sort((a, b) => a - b);
      if (v.length < 2) return 0;
      let lo = v[0], hi = v[v.length - 1];
      if (hi < lo * 1.4) return 0;
      for (let it = 0; it < 25; it++) {
        const t = Math.sqrt(lo * hi); let a = 0, na = 0, b = 0, nb = 0;
        for (const x of v) { if (x < t) { a += x; na++; } else { b += x; nb++; } }
        if (!na || !nb) break; lo = a / na; hi = b / nb;
      }
      return hi > lo * 1.4 ? Math.sqrt(lo * hi) : 0;
    }
    // gaps much longer than the rest separate rows (repeats of a message)
    function autoRowGap(e, unit) {
      const g = e.g.slice(0, -1).filter(x => x > 0).sort((a, b) => a - b);
      if (g.length < 3) return Infinity;
      const m = med(g), top = g[g.length - 1];
      // the cluster of longest gaps (within 20 % of the longest)
      let i = g.length - 1; while (i > 0 && g[i - 1] >= top / 1.2) i--;
      const nTop = g.length - i, below = i > 0 ? g[i - 1] : 0;
      if (!below || top / 1.2 < below * 1.5) return Infinity;   // no clear jump
      if (top < m * 1.8 || (unit && top < unit * 8)) return Infinity;
      if (nTop > Math.max(1, g.length / 4)) return Infinity;    // separators are rare
      return Math.sqrt(below * g[i]);
    }
    function autoUnit(e) {
      const t = e.analysis && e.analysis.timing;
      if (t && t.unit) return t.unit;
      const v = [...e.w, ...e.g.slice(0, -1)].filter(x => x > 0).sort((a, b) => a - b);
      return v[Math.floor(v.length * 0.1)] || 100;
    }
    function autoMethod(e) {
      const c = e.analysis && e.analysis.timing && e.analysis.timing.coding;
      return c === 'PWM' ? 'pwm' : c === 'PPM' ? 'ppm' : 'nrz';
    }
    const hexBits = (hex, len) => [...hex].map(c => parseInt(c, 16).toString(2).padStart(4, '0')).join('').slice(0, len);

    // waveform sampled at the unit: pulse → 1s, gap → 0s. t = start time (µs) of every bit.
    function levelRows(e, unit, rowGap) {
      const rows = []; let bits = '', t = [], now = 0; const n = e.w.length;
      for (let i = 0; i < n; i++) {
        const w = e.w[i], k = Math.max(1, Math.round(w / unit));
        for (let j = 0; j < k; j++) { bits += '1'; t.push(now + j * w / k); }
        now += w;
        if (i < n - 1) {
          const g = e.g[i];
          if (g > rowGap) { if (bits) rows.push({ bits, t }); bits = ''; t = []; }
          else { const k2 = Math.max(1, Math.round(g / unit)); for (let j = 0; j < k2; j++) { bits += '0'; t.push(now + j * g / k2); } }
          now += g;
        }
      }
      if (bits) rows.push({ bits, t });
      return rows;
    }
    function bestPhase(s) {
      let e0 = 0, e1 = 0;
      for (let i = 0; i + 1 < s.length; i += 2) if (s[i] === s[i + 1]) e0++;
      for (let i = 1; i + 1 < s.length; i += 2) if (s[i] === s[i + 1]) e1++;
      return e1 < e0 ? 1 : 0;
    }
    // Manchester on the level stream: 10 → 1, 01 → 0 (invert for the other convention).
    // Differential: a level change at the start of a bit → 0, none → 1.
    function manchesterRows(rows, diff) {
      const out = [];
      for (const r of rows) {
        const s = r.bits; let cur = '', ct = [], prev = null, i = bestPhase(s);
        const flush = () => { if (cur.length) out.push({ bits: cur, t: ct }); cur = ''; ct = []; prev = null; };
        while (i + 1 < s.length) {
          const a = s[i], b = s[i + 1];
          if (a === b) { flush(); i += 1; continue; }
          if (diff) { if (prev !== null) { cur += a === prev ? '1' : '0'; ct.push(r.t[i]); } prev = b; }
          else { cur += a === '1' ? '1' : '0'; ct.push(r.t[i]); }
          i += 2;
        }
        flush();
      }
      return out;
    }
    // PWM: one bit per pulse, short pulse = 1. PPM: one bit per gap, long gap = 1.
    function pwmRows(e, rowGap) {
      const thr = twoMeans(e.w) || med(e.w), rows = []; let bits = '', t = [], now = 0;
      for (let i = 0; i < e.w.length; i++) {
        bits += e.w[i] < thr ? '1' : '0'; t.push(now);
        now += e.w[i] + (i < e.w.length - 1 ? e.g[i] : 0);
        if (i < e.w.length - 1 && e.g[i] > rowGap) { rows.push({ bits, t }); bits = ''; t = []; }
      }
      if (bits) rows.push({ bits, t });
      return rows;
    }
    function ppmRows(e, rowGap) {
      const gs = e.g.slice(0, -1).filter(x => x <= rowGap);
      const thr = twoMeans(gs) || med(gs), rows = []; let bits = '', t = [], now = 0;
      for (let i = 0; i < e.w.length - 1; i++) {
        now += e.w[i];
        if (e.g[i] > rowGap) { if (bits) rows.push({ bits, t }); bits = ''; t = []; }
        else { bits += e.g[i] < thr ? '0' : '1'; t.push(now); }
        now += e.g[i];
      }
      if (bits) rows.push({ bits, t });
      return rows;
    }
    // opt: { method: auto|app|levels|nrz|manchester|diffman|pwm|ppm, unit, rowGap, invert, lsb, skip }
    function decode(e, opt) {
      if (!e || !e.w || !e.w.length) return [];
      let method = opt.method || 'auto';
      if (method === 'app') {
        const a = e.analysis;
        let rows = a && a.rowsHex ? a.rowsHex.map(r => ({ bits: hexBits(r.hex, r.len), t: null, kind: r.kind })) : [];
        return post(rows, opt);
      }
      if (method === 'auto') method = autoMethod(e);
      const unit = +opt.unit > 0 ? +opt.unit : autoUnit(e);
      const rowGap = +opt.rowGap > 0 ? +opt.rowGap : autoRowGap(e, method === 'pwm' || method === 'ppm' ? 0 : unit);
      let rows;
      if (method === 'pwm') rows = pwmRows(e, rowGap);
      else if (method === 'ppm') rows = ppmRows(e, rowGap);
      else {
        rows = levelRows(e, unit, rowGap);
        if (method === 'manchester') rows = manchesterRows(rows, false);
        else if (method === 'diffman') rows = manchesterRows(rows, true);
        // 'nrz' and 'levels' keep the level stream; 'nrz' trims leading/trailing zeros
        if (method === 'nrz') rows = rows.map(r => { const a = r.bits.indexOf('1'), b = r.bits.lastIndexOf('1'); return a < 0 ? null : { bits: r.bits.slice(a, b + 1), t: r.t.slice(a, b + 1) }; }).filter(Boolean);
      }
      return post(rows, opt);
    }
    function post(rows, opt) {
      const skip = Math.max(0, +opt.skip || 0);
      return rows.map(r => {
        let bits = r.bits, t = r.t;
        if (skip) { bits = bits.slice(skip); t = t && t.slice(skip); }
        if (opt.invert) bits = bits.replace(/[01]/g, c => (c === '0' ? '1' : '0'));
        if (opt.lsb) bits = bits.replace(/[01]{1,8}/g, g => g.length === 8 ? [...g].reverse().join('') : g);
        return { bits, t, kind: r.kind };
      }).filter(r => r.bits.length >= 4);
    }
    // the row that best represents a packet: most repeated, else longest
    function mainRow(rows) {
      if (!rows.length) return null;
      const cnt = new Map(); for (const r of rows) cnt.set(r.bits, (cnt.get(r.bits) || 0) + 1);
      let best = rows[0];
      for (const r of rows) {
        const c = cnt.get(r.bits), cb = cnt.get(best.bits);
        if ((c >= 2 && r.bits.length >= 8) > (cb >= 2 && best.bits.length >= 8) || ((c >= 2) === (cb >= 2) && r.bits.length > best.bits.length)) best = r;
      }
      return best;
    }
    // position of p in s allowing up to maxErr wrong bits (best match), -1 if none
    function findApprox(s, p, maxErr) {
      if (!p) return -1;
      const exact = s.indexOf(p);
      if (exact >= 0 || !maxErr) return exact;
      let best = -1, be = maxErr + 1;
      for (let i = 0; i + p.length <= s.length; i++) {
        let e = 0;
        for (let j = 0; j < p.length && e < be; j++) if (s.charCodeAt(i + j) !== p.charCodeAt(j)) e++;
        if (e < be) { be = e; best = i; }
      }
      return best;
    }
    // repetitive filler (preamble 1010…, runs of 0/1): matches almost anything of that kind
    function lowComplexity(s) {
      for (const per of [1, 2, 3, 4]) {
        let ok = 0; for (let i = per; i < s.length; i++) if (s[i] === s[i - per]) ok++;
        if (ok >= (s.length - per) * 0.9) return per;
      }
      return 0;
    }
    // Maximal bit sections that appear in at least one string of every group.
    function commonSections(groups, minLen, maxOut) {
      groups = groups.filter(g => g.length);
      if (groups.length < 1) return [];
      const has = (g, s) => { for (const r of g) if (r.includes(s)) return true; return false; };
      const all = s => groups.every(g => has(g, s));
      const found = new Set();
      for (const r of [...new Set(groups[0])]) {
        let prev = 0;
        for (let i = 0; i + minLen <= r.length; i++) {
          let lo = Math.max(minLen, prev - 1);
          if (i + lo > r.length) break;
          if (lo === minLen && !all(r.substr(i, minLen))) { prev = 0; continue; }
          let hi = r.length - i;
          while (lo < hi) { const m = (lo + hi + 1) >> 1; if (all(r.substr(i, m))) lo = m; else hi = m - 1; }
          if (lo > prev - 1) found.add(r.substr(i, lo));
          prev = lo;
        }
      }
      const out = [];
      for (const s of [...found].sort((a, b) => b.length - a.length)) {
        if (out.some(o => o.includes(s))) continue;
        out.push(s); if (out.length >= (maxOut || 30)) break;
      }
      return out;
    }
    // longest common substring between two sets of strings
    function lcs(A, B) {
      if (!A.length || !B.length) return '';
      let lo = 0, hi = Math.min(Math.max(...A.map(s => s.length)), Math.max(...B.map(s => s.length))), best = '';
      while (lo < hi) {
        const m = (lo + hi + 1) >> 1, set = new Set();
        for (const a of A) for (let i = 0; i + m <= a.length; i++) set.add(a.substr(i, m));
        let hit = '';
        for (const b of B) { for (let i = 0; i + m <= b.length; i++) { const s = b.substr(i, m); if (set.has(s)) { hit = s; break; } } if (hit) break; }
        if (hit) { lo = m; best = hit; } else hi = m - 1;
      }
      return best;
    }
    // timing fingerprint: log-spaced histogram 10 µs … 100 ms
    function hist(vals) {
      const h = new Float64Array(60); let n = 0;
      for (const v of vals) {
        if (!(v > 0)) continue;
        const b = Math.max(0, Math.min(59, Math.floor((Math.log10(v) - 1) * 15)));
        h[b] += 1; if (b > 0) h[b - 1] += 0.5; if (b < 59) h[b + 1] += 0.5; n += 2;
      }
      if (n) for (let i = 0; i < 60; i++) h[i] /= n;
      return h;
    }
    const overlap = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.min(a[i], b[i]); return s; };

    // ---- checksum / CRC search
    const reflect8 = x => { let r = 0; for (let i = 0; i < 8; i++) if (x & (1 << i)) r |= 1 << (7 - i); return r; };
    const crc8 = (d, poly, init) => { let c = init; for (const b of d) { c ^= b; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ poly) & 255 : (c << 1) & 255; } return c; };
    const crc8r = (d, poly, init) => { const p = reflect8(poly); let c = init; for (const b of d) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >> 1) ^ p : c >> 1; } return c; };
    const crc16 = (d, poly, init) => { let c = init; for (const b of d) { c ^= b << 8; for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ poly) & 0xffff : (c << 1) & 0xffff; } return c; };
    const crc16r = (d, polyR, init) => { let c = init; for (const b of d) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >> 1) ^ polyR : c >> 1; } return c; };
    const ALG8 = [
      ['XOR of bytes', d => d.reduce((a, b) => a ^ b, 0)],
      ['sum of bytes mod 256', d => d.reduce((a, b) => a + b, 0) & 255],
      ['two\'s-complement sum (sum incl. checksum = 0)', d => (-d.reduce((a, b) => a + b, 0)) & 255],
    ];
    for (const p of [0x07, 0x31, 0x1d, 0x2f, 0x9b, 0xd5, 0x39, 0x49, 0x8d, 0x2b, 0xa7]) for (const init of [0, 0xff]) {
      ALG8.push([`CRC-8 poly 0x${p.toString(16).padStart(2, '0')} init 0x${init.toString(16)}`, d => crc8(d, p, init)]);
      ALG8.push([`CRC-8 poly 0x${p.toString(16).padStart(2, '0')} init 0x${init.toString(16)} (reflected, LSB first)`, d => crc8r(d, p, init)]);
    }
    const ALG16 = [];
    for (const [nm, p] of [['CCITT 0x1021', 0x1021], ['0x8005', 0x8005], ['0x8bb7', 0x8bb7], ['0x3d65', 0x3d65]]) for (const init of [0, 0xffff]) ALG16.push([`CRC-16 ${nm} init 0x${init.toString(16)}`, d => crc16(d, p, init)]);
    for (const [nm, p] of [['IBM/Modbus 0xA001', 0xa001], ['Kermit 0x8408', 0x8408]]) for (const init of [0, 0xffff]) ALG16.push([`CRC-16 ${nm} init 0x${init.toString(16)} (reflected)`, d => crc16r(d, p, init)]);
    const toBytes = (bits, sh) => { const out = []; for (let i = sh; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.substr(i, 8), 2)); return out; };
    // msgs: bit strings (one per packet). Returns rules that hold for (almost) all of them.
    function findChecksums(msgs, maxOut) {
      msgs = [...new Set(msgs.filter(s => s.length >= 24))];
      if (msgs.length < 2) return { tested: msgs.length, hits: [] };
      if (msgs.length > 40) msgs = msgs.slice(0, 40);
      const hits = [];
      for (let sh = 0; sh < 8; sh++) {
        const B = msgs.map(m => toBytes(m, sh)), n = Math.min(...B.map(b => b.length));
        if (n < 3) continue;
        const need = B.length >= 6 ? Math.ceil(B.length * 0.85) : B.length;
        const tryAlg = (name, fn, cpos, start, width, xorOut) => {
          const vals = new Set(); let ok = 0;
          for (const b of B) {
            let want = width === 2 ? (b[cpos] << 8 | b[cpos + 1]) : b[cpos], want2 = width === 2 ? (b[cpos + 1] << 8 | b[cpos]) : want;
            let got = fn(b.slice(start, cpos)); if (xorOut) got ^= width === 2 ? 0xffff : 0xff;
            vals.add(want);
            if (got === want || (width === 2 && got === want2)) ok++;
          }
          if (ok >= need && vals.size >= 2) hits.push({ name: name + (xorOut ? ', result inverted' : ''), shift: sh, start, cpos, width, ok, n: B.length, dataBytes: cpos - start });
        };
        for (let cpos = 2; cpos < n; cpos++) for (let start = 0; start <= cpos - 2; start++) {
          for (const [name, fn] of ALG8) for (const x of [false, true]) tryAlg(name, fn, cpos, start, 1, x);
          if (cpos + 1 < n) for (const [name, fn] of ALG16) tryAlg(name, fn, cpos, start, 2, false);
        }
        // nibble sum / xor into the last nibble of the message
        for (const [name, f] of [['sum of nibbles mod 16', (a, b) => (a + b) & 15], ['XOR of nibbles', (a, b) => a ^ b]]) {
          const L = Math.min(...msgs.map(m => Math.floor((m.length - sh) / 4)));
          if (L < 4) continue;
          for (let start = 0; start < L - 2; start++) {
            let ok = 0; const vals = new Set();
            for (const m of msgs) {
              const nib = []; for (let i = sh; i + 4 <= m.length && nib.length < L; i += 4) nib.push(parseInt(m.substr(i, 4), 2));
              let acc = 0; for (let i = start; i < L - 1; i++) acc = f(acc, nib[i]);
              vals.add(nib[L - 1]); if (acc === nib[L - 1]) ok++;
            }
            if (ok >= need && vals.size >= 2) hits.push({ name, shift: sh, start: start / 2, cpos: (L - 1) / 2, width: 0.5, ok, n: msgs.length, dataBytes: (L - 1 - start) / 2, nibble: true });
          }
        }
      }
      hits.sort((a, b) => b.ok / b.n - a.ok / a.n || b.dataBytes - a.dataBytes);
      return { tested: msgs.length, hits: hits.slice(0, maxOut || 25) };
    }
    return { decode, mainRow, findApprox, lowComplexity, commonSections, lcs, hist, overlap, findChecksums, autoUnit, autoRowGap, autoMethod, toBytes, hexBits, med };
  })();
