const D = require('../src/dsp.js');
const db = require('../build/devices.json').devices;
const sr = 1024000;
const cases = {
  nexus: D.Enc.nexus(0xa7, 2, -3.4, 56), prologue: D.Enc.prologue(1, 1, 20, 50), nexa: D.Enc.nexa(1234567, 3, true),
  ev1527: D.Enc.ev1527(0xabcde4, 380), wh2: D.Enc.wh2(0x5a1, 7.3, 81),
  // the user's remote: PPM, unit ~70 us: pulse 70, short gap 70, long gap 280, 16 bits, 10 repeats every 6 ms
  user_remote: (() => { const w = [], g = []; const gaps = 'LLLLSSLLLSLLLSLL'; for (let r = 0; r < 10; r++) { for (const c of gaps) { w.push(70); g.push(c === 'S' ? 70 : 280); } w.push(70); g.push(1470); } g[g.length - 1] = 40000; return { w, g }; })(),
};
for (const [k, tr] of Object.entries(cases)) {
  const pk = []; const b = new D.ChannelBank(sr, p => pk.push(p)); b.setSnr(7);
  b.process(D.synthIQ(sr, [tr], { snrDb: 6, freqHz: 40000 })); b._flush(true);
  for (const p of pk) {
    const a = D.analyze(p);
    console.log(`\n${k}: ${a && a.modulation} ${a && a.info} rows ${a && a.timing && a.timing.rowLens}`);
    for (const c of D.candidates(a, !!p.fsk, db)) console.log(`   ${(c.score * 100).toFixed(0)}%  ${c.name}  [${c.why}]  ${c.src}`);
  }
}
