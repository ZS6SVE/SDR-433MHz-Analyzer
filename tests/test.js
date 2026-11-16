const D = require('../src/decoders.js');
const SR = 250000;
function run(name, trains, opts) {
  const pkts = [];
  const det = new D.PulseDetector(SR, p => pkts.push(p));
  const iq = D.synthIQ(SR, trains, opts);
  for (let i = 0; i < iq.length; i += 65536) det.process(iq.subarray(i, i + 65536));
  const msgs = pkts.flatMap(p => D.decodePacket(p));
  const an = pkts.map(p => D.analyze(p));
  console.log(`\n== ${name} (snr ${opts?.snrDb ?? 20}): ${pkts.length} packet(s), pulses ${pkts.map(p => p.w.length)}`);
  for (const m of msgs) console.log('  ', m.model, 'id', m.id, 'ch', m.channel, JSON.stringify(m.data), 'rep', m.repeats);
  if (!msgs.length) for (const a of an) console.log('   analyze:', a && a.modulation, a && a.info, a && JSON.stringify(a.best));
  return msgs;
}
for (const snr of [20, 10]) {
  run('nexus', [D.Enc.nexus(0xa7, 2, -3.4, 56)], { snrDb: snr });
  run('nexus temp-only', [D.Enc.nexus(0x12, 1, 22.5, 0xff)], { snrDb: snr });
  run('prologue', [D.Enc.prologue(0x3c, 3, 18.7, 44)], { snrDb: snr });
  run('nexa', [D.Enc.nexa(12345678, 3, true)], { snrDb: snr });
  run('ev1527', [D.Enc.ev1527(0xabcde4, 380)], { snrDb: snr });
  run('wh2', [D.Enc.wh2(0x5a1, -7.3, 81)], { snrDb: snr });
}
run('unknown PPM', [{ w: Array(30).fill(400).concat(Array(30).fill(400)), g: Array.from({ length: 60 }, (_, i) => (i % 30 === 29 ? 6000 : (i * 7) % 3 ? 900 : 1900)) }], {});
run('noise only', [], {});
