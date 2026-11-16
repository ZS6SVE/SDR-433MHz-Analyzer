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
