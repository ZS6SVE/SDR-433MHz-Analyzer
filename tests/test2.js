const D = require('../src/dsp.js');

function runMode(mode, trains, synthOpts, trig) {
  const sr = mode === 'bank' ? 1024000 : 250000;
  const pkts = [];
  const det = mode === 'bank' ? new D.ChannelBank(sr, p => pkts.push(p)) : new D.WideDetector(sr, p => pkts.push(p));
  det.setSnr(trig);
  const iq = D.synthIQ(sr, trains, synthOpts);
  const step = mode === 'bank' ? 262144 : 65536;
  for (let i = 0; i < iq.length; i += step) det.process(iq.subarray(i, i + step));
  if (det._flush) det._flush(true);
  return pkts;
}
const pass = p => { const m = D.decodePacket(p); if (m.length) return { m }; const a = D.analyze(p); return a && a.score >= 0.8 ? { a } : null; };

// SNR given as SNR in a 250 kHz band (what classic mode / rtl_433 sees).
function sens(name, mk, check, extra = {}) {
  const line = [];
  for (const mode of ['classic', 'bank']) {
    const res = [];
    for (let snr250 = 12; snr250 >= -6; snr250 -= 2) {
      const snr = mode === 'bank' ? snr250 - 6.1 : snr250; // 1.024 MHz has 6 dB more noise per sample
      let ok = 0;
      for (let k = 0; k < 3; k++) {
        const pk = runMode(mode, [mk()], { snrDb: snr, freqHz: mode === 'bank' ? -180000 + Math.random() * 300000 : 20000 + Math.random() * 40000, ...extra }, mode === "bank" ? 7 : 8);
        if (pk.some(p => check(p))) ok++;
      }
      res.push(`${snr250}:${ok}`);
    }
    line.push(`${mode.padEnd(7)} ${res.join(' ')}`);
  }
  console.log(`\n${name} (SNR in 250 kHz : successes/3)\n  ` + line.join('\n  '));
}
const decodes = model => p => D.decodePacket(p).some(m => m.model.startsWith(model));
sens('Nexus', () => D.Enc.nexus(0xa7, 2, -3.4, 56), decodes('Nexus'));
sens('Nexa', () => D.Enc.nexa(1234567, 3, true), decodes('Nexa'));
sens('EV1527', () => D.Enc.ev1527(0xabcde4, 380), decodes('EV1527'));
sens('WH2', () => D.Enc.wh2(0x5a1, 7.3, 81), decodes('Fine'));
const mcBytes = [0xff, 0xff, 0xa5, 0x1c, 0x37, 0x42, 0x9e];
sens('OOK Manchester (unknown)', () => D.Enc.manchester(mcBytes, 488), p => { const a = D.analyze(p); return a && a.score >= 0.8 && a.rowsHex.some(r => r.kind === 'MC' && r.hex.includes('a51c3742')); });
const fskBytes = [0xaa, 0xaa, 0xaa, 0xaa, 0x2d, 0xd4, 0x41, 0x7e, 0x09, 0xc3, 0x55, 0xf0];
sens('FSK NRZ 10 kbps (unknown)', () => D.Enc.nrz(fskBytes, 100), p => { const a = D.analyze(p); return a && a.score >= 0.8 && a.rowsHex.some(r => r.hex.includes('2dd4417e09c3') || r.hex.includes('d22bbe81f63c')); }, { fskDevHz: 40000 });

// FSK labelling
{
  const pk = runMode('bank', [D.Enc.nrz(fskBytes, 100)], { snrDb: 0, freqHz: 50000, fskDevHz: 40000 }, 7);
  for (const p of pk) { const a = D.analyze(p); console.log('\nFSK packet:', p.fsk, 'freqOff', p.freqOff, a && a.modulation, a && a.info, a && a.rowsHex.map(r => r.kind + '{' + r.len + '}' + r.hex).join(' ')); }
}

// False alarms on pure noise
for (const mode of ['classic', 'bank']) for (const trig of mode === 'bank' ? [6, 7, 8] : [6, 8]) {
  const sec = 20;
  const sr = mode === 'bank' ? 1024000 : 250000;
  const pk = runMode(mode, [{ w: [100], g: [sec * 1e6] }], { snrDb: -40 }, trig);
  const passed = pk.filter(pass);
  console.log(`noise ${mode} trig ${trig}: ${pk.length} raw packets / ${sec}s, ${passed.length} shown`, passed.slice(0, 3).map(p => p.w.length + 'p ' + JSON.stringify(D.analyze(p) && D.analyze(p).info)));
}

// Speed
{
  const iq = D.synthIQ(1024000, [D.Enc.nexus(1, 1, 20, 50)], { snrDb: 0 });
  const bank = new D.ChannelBank(1024000, () => {});
  const t0 = Date.now(); for (let k = 0; k < 3; k++) bank.process(iq);
  const secs = 3 * iq.length / 2 / 1024000;
  console.log(`\nbank speed: ${((Date.now() - t0) / 1000 / secs * 100).toFixed(0)}% of real time (${bank.chans.length} channels)`);
}
