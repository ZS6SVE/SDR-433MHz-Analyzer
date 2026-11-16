const D = require('../src/dsp.js');
const rank = p => { p._m = D.decodePacket(p); if (p._m.length) return 1000 + p.snr; const a = D.analyze(p); return a ? a.score * 100 + p.snr : p.snr - 100; };
const remote = (pattern, unit) => { const w = [], g = []; for (let r = 0; r < 10; r++) { for (const c of pattern) { w.push(unit); g.push(c === 'S' ? unit : 4 * unit); } w.push(unit); g.push(1470); } g[g.length - 1] = 40000; return { w, g }; };
const cases = { remote60: () => remote('LLLLSSLLLSLLLSLL', 60), nexus: () => D.Enc.nexus(0xa7, 2, -3.4, 56), nexa: () => D.Enc.nexa(1234567, 3, true), ev1527: () => D.Enc.ev1527(0xabcde4, 380), wh2: () => D.Enc.wh2(0x5a1, 7.3, 81), mc: () => D.Enc.manchester([0xff, 0xff, 0xa5, 0x1c, 0x37, 0x42, 0x9e], 488) };
for (const [k, mk] of Object.entries(cases)) {
  const r = [];
  for (const snr250 of [12, 8, 4, 2, 0]) {
    let ok = 0, n = 0;
    for (let t = 0; t < 3; t++) {
      const pk = []; const b = new D.DualBank(1024000, p => pk.push(p), rank); b.setSnr(7);
      b.process(D.synthIQ(1024000, [mk()], { snrDb: snr250 - 6, freqHz: -150000 + Math.random() * 250000, lead: 0.08 })); b._flush(true);
      n += pk.length;
      if (pk.some(p => (p._m && p._m.length) || (k === 'mc' && (D.analyze(p) || { rowsHex: [] }).rowsHex.some(x => x.hex.includes('a51c3742'))))) ok++;
    }
    r.push(`${snr250}:${ok}(${n}p)`);
  }
  console.log(k.padEnd(9), r.join(' '));
}
{ const pk = []; const b = new D.DualBank(1024000, p => pk.push(p), rank); b.setSnr(7);
  const t0 = Date.now(); const iq = D.synthIQ(1024000, [{ w: [100], g: [10e6] }], { snrDb: -40 }); const t1 = Date.now();
  b.process(iq); b._flush(true);
  console.log('noise 10s:', pk.length, 'packets; dual bank speed', ((Date.now() - t1) / 10000 * 100).toFixed(0) + '% of real time'); }
