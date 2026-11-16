const D = require('../src/dsp.js');
const remote = (pattern, unit = 70, pause = 1470) => { const w = [], g = []; for (let r = 0; r < 10; r++) { for (const c of pattern) { w.push(unit); g.push(c === 'S' ? unit : 4 * unit); } w.push(unit); g.push(pause); } g[g.length - 1] = 40000; return { w, g }; };
const pats = { Up: 'LLLLSSLLLSLLLSLL', Stop: 'LLLLSSLLLLSLLLSL', Down: 'LLLLSSLLLLLSLLLS' };
for (const mode of ['bank', 'classic']) for (const unit of [60, 75]) for (const snr250 of [12, 6, 2]) {
  const res = [];
  for (const [name, pat] of Object.entries(pats)) {
    const sr = mode === 'bank' ? 1024000 : 250000;
    const pk = []; const b = mode === 'bank' ? new D.ChannelBank(sr, p => pk.push(p)) : new D.WideDetector(sr, p => pk.push(p));
    b.setSnr(mode === 'bank' ? 7 : 8);
    b.process(D.synthIQ(sr, [remote(pat, unit)], { snrDb: mode === 'bank' ? snr250 - 6 : snr250, freqHz: 30000 })); if (b._flush) b._flush(true);
    const m = pk.flatMap(p => D.decodePacket(p));
    res.push(name + ':' + (m.map(x => `${x.model.split(' ')[0]} id${x.id} ${x.data.button || ''} ${x.data.timing || ''}`).join(',') || '-'));
  }
  console.log(mode, 'unit', unit, 'snr250', snr250, '|', res.join(' | '));
}
// false positives: other protocols must not decode as the remote and vice versa
const others = [D.Enc.nexus(1, 1, 20, 50), D.Enc.nexa(123, 1, true), D.Enc.ev1527(0x123456), D.Enc.wh2(1, 20, 50), D.Enc.prologue(1, 1, 20, 50)];
for (const tr of others) {
  const pk = []; const b = new D.ChannelBank(1024000, p => pk.push(p)); b.setSnr(7);
  b.process(D.synthIQ(1024000, [tr], { snrDb: 6, freqHz: 30000 })); b._flush(true);
  console.log('other:', pk.flatMap(p => D.decodePacket(p)).map(m => m.model).join(', '));
}
