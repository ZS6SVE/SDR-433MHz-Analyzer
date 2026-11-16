  // ===== Export a packet / device / comparison as a prompt for any AI =====
  const AI = Object.assign({ per: 5, timings: true, cands: true, analysis: true, allrows: false, extra: '' }, store.get('ai.opt', {}));
  let aiScope = null;
  document.head.insertAdjacentHTML('beforeend', `<style>
  #aiDlg { position: fixed; inset: 0; background: #000c; z-index: 40; display: flex; justify-content: center; padding: 14px 12px; }
  #aiDlg[hidden] { display: none; }
  #aiDlg .ap { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; width: min(1100px, 100%); height: 100%; box-sizing: border-box; padding: 14px 18px; display: flex; flex-direction: column; gap: 10px; min-height: 0; }
  #aiDlg h3 { margin: 0; font-size: 18px; display: flex; gap: 12px; align-items: center; }
  #aiDlg h3 button { margin-left: auto; }
  #aiDlg .opts { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; background: var(--panel2); border-radius: 8px; padding: 8px 12px; font-size: 12px; }
  #aiDlg .opts label { flex-direction: row; align-items: center; gap: 5px; text-transform: none; letter-spacing: 0; font-size: 12px; color: var(--text); }
  #aiDlg textarea { width: 100%; background: var(--panel2); color: var(--text); border: 1px solid var(--line); border-radius: 8px; font: 12px/1.45 var(--mono); padding: 10px; box-sizing: border-box; resize: none; }
  #aiDlg #aiOut { flex: 1 1 auto; min-height: 0; }
  #aiDlg #aiExtra { height: 54px; flex: none; }
  #aiDlg .foot { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 12px; color: var(--dim); }
  </style>`);
  document.body.insertAdjacentHTML('beforeend', `<div id="aiDlg" hidden><div class="ap">
    <h3>Prompt for an AI <span id="aiTitle" style="font-size:13px;color:var(--dim);font-weight:400"></span><button id="aiClose">Close</button></h3>
    <div class="opts">
      <label>packets per device <select id="aiPer">${[1, 3, 5, 10, 20].map(n => `<option>${n}</option>`).join('')}</select></label>
      <label><input type="checkbox" id="aiTim"> raw pulse timings</label>
      <label><input type="checkbox" id="aiAll"> every repeated row</label>
      <label><input type="checkbox" id="aiCand"> rtl_433 database matches</label>
      <label><input type="checkbox" id="aiAna"> my analysis (varying bits, checksum search, comparison)</label>
    </div>
    <textarea id="aiExtra" placeholder="Optional: what you know about the device (where it is, what it does, what you did when it transmitted) and what you want to know. It is added to the end of the prompt."></textarea>
    <textarea id="aiOut" spellcheck="false"></textarea>
    <div class="foot"><button class="primary" id="aiCopy">Copy prompt</button><button id="aiDl">Download .md</button><span id="aiSize"></span>
      <span>Paste it into any AI chat. You can edit the text above first. Nothing is sent anywhere from this page.</span></div></div></div>`);

  const hx = bits => { let s = ''; for (let i = 0; i < bits.length; i += 4) s += parseInt(bits.substr(i, 4).padEnd(4, '0'), 2).toString(16); return s; };
  const fmtT = t => new Date(t).toLocaleString([], { hour12: false });
  const durMs = e => { let t = 0; for (let i = 0; i < e.w.length; i++) t += e.w[i] + (i < e.w.length - 1 ? e.g[i] : 0); return t / 1000; };
  const cut = (s, n) => (s.length > n ? s.slice(0, n) + `… (${s.length} bits total)` : s);

  function aiRows(e) {
    const rows = AC.decode(e, AN.opt), cnt = new Map();
    for (const r of rows) cnt.set(r.bits, (cnt.get(r.bits) || 0) + 1);
    return { rows, distinct: [...cnt.entries()].map(([bits, n]) => ({ bits, n })), main: AC.mainRow(rows) };
  }
  function packetBlock(e, full) {
    const { rows, distinct, main } = aiRows(e), a = e.analysis;
    let s = `- **Packet #${e.seq}** ${fmtT(e.time)}, ${mhz(e.freqHz)}, SNR ${e.snr.toFixed(1)} dB, ${e.n || e.w.length} pulses, ${durMs(e).toFixed(1)} ms` +
      (e.fskDevHz ? `, FSK ±${Math.round(e.fskDevHz / 1000)} kHz` : '') + (a ? `. Tool's analysis: ${a.modulation}, ${a.info}, timing regularity ${Math.round(a.score * 100)}%` : '') + '\n';
    if (!e.unknown) s += `  - Decoded by a built-in decoder as **${e.model}**: \`${JSON.stringify(e.data)}\`${e.id !== undefined ? `, id ${e.id}` : ''}${e.channel !== undefined ? `, channel ${e.channel}` : ''}\n`;
    if (!rows.length) s += '  - no bit rows could be formed from the timing\n';
    else {
      const show = AI.allrows || full ? distinct : distinct.slice(0, 3);
      s += `  - ${rows.length} row(s) (message repeats), ${distinct.length} distinct:\n`;
      for (const d of show) s += `    - ${d.n}× ${d.bits.length} bits: \`${cut(d.bits, 400)}\` hex \`${hx(d.bits).slice(0, 100)}\`${d.bits.length > 400 ? '…' : ''}\n`;
      if (show.length < distinct.length) s += `    - …and ${distinct.length - show.length} more distinct rows\n`;
    }
    if (AI.timings) {
      const n = full ? Math.min(e.w.length, 500) : Math.min(e.w.length, 80);
      s += `  - raw timings, µs as pulse/gap pairs${n < e.w.length ? ` (first ${n} of ${e.w.length})` : ''}: \`${e.w.slice(0, n).map((w, i) => w + '/' + e.g[i]).join(' ')}\`\n`;
    }
    return s;
  }
  // varying/fixed bit map across the distinct main rows of equal length
  function bitMap(msgs) {
    const L = new Map(); for (const m of msgs) L.set(m.length, (L.get(m.length) || 0) + 1);
    const len = [...L.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    const set = [...new Set(msgs.filter(m => m.length === len))];
    if (set.length < 2) return null;
    let map = '', ranges = [], start = -1;
    for (let c = 0; c < len; c++) {
      const v = new Set(set.map(m => m[c]));
      map += v.size === 1 ? [...v][0] : 'x';
      if (v.size > 1 && start < 0) start = c;
      if ((v.size === 1 || c === len - 1) && start >= 0) { ranges.push(start === (v.size === 1 ? c - 1 : c) ? `${start}` : `${start}-${v.size === 1 ? c - 1 : c}`); start = -1; }
    }
    return { len, n: set.length, map, ranges };
  }
  function devBlock(d, opt) {
    const pk = log.filter(x => x.key === d.key && x.w && x.w.length);
    const use = [...(opt.focus ? pk.filter(x => x.seq === opt.focus) : []), ...pk.filter(x => x.seq !== opt.focus)].slice(0, opt.focus ? Math.max(AI.per, 2) : AI.per);
    const W = [], G = []; for (const e of pk.slice(0, 30)) { W.push(...e.w); G.push(...e.g.slice(0, -1)); }
    const st = devStats(d), nm = devName(d.key);
    let s = `### ${opt.tag ? opt.tag + ': ' : ''}${nm ? nm + ' — ' : ''}${d.model}${d.id !== undefined && !d.unknown ? ' (ID ' + d.id + ')' : ''}\n`;
    s += `- Frequency ${mhz(d.freqHz)}${d.fskDevHz ? `, FSK deviation ±${Math.round(d.fskDevHz / 1000)} kHz` : ', OOK (on/off keying)'}; typical SNR ${d.snr.toFixed(0)} dB\n`;
    s += `- Heard ${pk.length} packets in ${d.times.length} separate transmissions; ${st.label}\n`;
    s += `- Pulse widths µs (value×count): ${peaks(W)}\n- Gap widths µs (value×count): ${peaks(G)}\n`;
    if (d.unknown && d.id !== 'rule') s += `- The tool grouped these packets as one device because they share the first bits (\`${d.id}\`) and the bit length\n`;
    if (d.id === 'rule') s += `- These packets were grouped by a user-defined rule (a shared bit pattern)\n`;
    if (AI.cands && d.candidates && d.candidates.length) s += `- Closest rtl_433 device-database entries (timing match only, not proof): ${d.candidates.slice(0, 5).map(c => `${c.name} ${Math.round(c.score * 100)}% (${c.why})`).join('; ')}\n`;
    s += `\n**Packets (newest first${opt.focus ? ', the one I am asking about first' : ''}):**\n`;
    for (const e of use) s += packetBlock(e, opt.focus === e.seq);
    if (AI.analysis) {
      const mains = pk.slice(0, 40).map(e => aiRows(e).main).filter(Boolean).map(r => r.bits);
      const bm = mains.length >= 2 ? bitMap(mains) : null;
      if (bm) s += `\n**Bit comparison across ${bm.n} different messages of ${bm.len} bits** (bits equal in all messages are shown, \`x\` = varies): \`${cut(bm.map, 300)}\`\n  - varying bit positions (counted from 0): ${bm.ranges.join(', ') || 'none'}; fixed: ${bm.map.split('').filter(c => c !== 'x').length} bits\n`;
      const msgs = [...new Set(mains.filter(m => m.length >= 24))];
      if (msgs.length >= 3) {
        const r = AC.findChecksums(msgs, 5);
        s += r.hits.length ? `\n**Checksum search** (my tool tried XOR, sums and common CRC-8/16 over all byte ranges): ${r.hits.map(h => `${h.name}${h.shift ? ' at bit offset ' + h.shift : ''}, data bytes ${h.start}-${h.cpos - 1}, checksum at byte ${h.cpos}, holds in ${h.ok}/${h.n}`).join('; ')}\n` : `\n**Checksum search**: nothing found in ${r.tested} distinct messages (the checksum may need more varied packets, another bit order, or an algorithm outside my list)\n`;
      }
    }
    return s + '\n';
  }
  function compareBlock(devs) {
    const F = devs.map((d, i) => {
      const pk = log.filter(x => x.key === d.key && x.w && x.w.length).slice(0, 20);
      const W = [], G = []; for (const e of pk) { W.push(...e.w); G.push(...e.g.slice(0, -1)); }
      return { d, tag: 'D' + (i + 1), hw: AC.hist(W), hg: AC.hist(G), rows: [...new Set(pk.map(e => aiRows(e).main).filter(Boolean).map(r => r.bits.slice(0, 1500)))], f: AC.med(pk.map(e => e.freqHz)) };
    });
    let s = '## What I want to know: are these the same device?\n';
    s += 'My tool measured how similar the devices are (timing = overlap of pulse/gap width histograms, 100% = identical; shared bits = longest bit section found in both):\n\n| pair | timing | longest shared bits | frequency difference |\n|---|---|---|---|\n';
    for (let i = 0; i < F.length; i++) for (let j = i + 1; j < F.length; j++) {
      const a = F[i], b = F[j], c = AC.lcs(a.rows, b.rows);
      s += `| ${a.tag} / ${b.tag} | ${Math.round((AC.overlap(a.hw, b.hw) + AC.overlap(a.hg, b.hg)) / 2 * 100)}% | ${c.length} bits${c.length && AC.lowComplexity(c) ? ' (only filler/preamble)' : ''} | ${Math.round(Math.abs(a.f - b.f) / 1000)} kHz |\n`;
    }
    const secs = AC.commonSections(F.map(f => f.rows), 8, 8);
    s += secs.length ? `\n**Bit sections present in every device** (longest first): ${secs.map(x => `\`${cut(x, 120)}\`${AC.lowComplexity(x) ? ' (filler)' : ''}`).join(', ')}\n` : '\nNo bit section of 8+ bits is shared by all devices with my current decoding.\n';
    return s + '\n';
  }

  function aiGenerate(scope) {
    const devs = scope.keys.map(k => devices.get(k)).filter(Boolean);
    const pk = scope.seq ? log.find(x => x.seq === scope.seq) : null;
    let s = '# Help me identify and reverse-engineer a 433 MHz radio signal\n\n';
    s += '## Context\n';
    s += 'I recorded these signals with an RTL-SDR (RTL2832U + R820T2) in the 433 MHz ISM band and processed them with a home-built browser tool (based on rtl_433-style pulse detection). I am a hobbyist doing reverse engineering. Please treat my data as measurements, not as facts about the device.\n\n';
    s += '- **Pulse / gap**: a pulse is the carrier switched on (OOK) and a gap is the carrier off; times are in microseconds, measured at half amplitude, so they carry a few percent of jitter.\n';
    s += '- **Bits** were derived by my tool from the timings. The coding it used is stated per device (PWM = bit in the pulse width, PPM = bit in the gap width, NRZ/Manchester = level at fixed time slots). **Polarity, bit order (MSB/LSB first) and where a message starts may be wrong**, and weak packets can contain bit errors.\n';
    s += '- A packet usually contains the same message repeated several times (rows).\n';
    s += `- Decoding settings in use: ${optText(AN.opt)}.\n\n`;
    s += `## ${devs.length > 1 ? 'The devices' : pk ? 'The packet' : 'The device'}\n\n`;
    devs.forEach((d, i) => { s += devBlock(d, { tag: devs.length > 1 ? 'D' + (i + 1) : '', focus: scope.seq && pk && pk.key === d.key ? scope.seq : 0 }); });
    if (pk && !devs.length) s += packetBlock(pk, true) + '\n';
    if (devs.length > 1 && AI.analysis) s += compareBlock(devs);
    s += '## What I would like from you\n';
    const q = devs.length > 1
      ? ['Could some of these be the same device or the same product family? Explain which evidence supports it and which bits could be an ID, counter, channel, battery flag, measurement or checksum.']
      : ['What kind of device or protocol could this be (e.g. weather sensor, doorbell, remote, car key, alarm sensor, tyre-pressure sensor, utility meter)? Name matching rtl_433 decoders or known protocols if you recognise the structure.'];
    s += [...q,
      'Split the message into fields (preamble/sync, device ID, command or measurement, counter, checksum) and say how sure you are about each. Use the bit comparison above: bits that never change are likely ID/sync, bits that change every time are likely data, a counter or a checksum.',
      'Suggest what the checksum or CRC could be and how I could verify it with the data above.',
      'Tell me what additional recordings would settle the open questions (for example: press a different button, change the temperature, move the sensor, capture 10 more packets).',
      'If the protocol is clear enough, give me an rtl_433 flex decoder line (`-X "n=name,m=OOK_PWM,s=...,l=...,r=..."`) or a short Python decoder, and say what I should test it against.',
      'Be explicit where you are guessing.'].map((x, i) => `${i + 1}. ${x}`).join('\n') + '\n';
    const extra = $('aiExtra').value.trim();
    if (extra) s += `\n## Notes from me\n${extra}\n`;
    return s;
  }
  function aiRender() {
    if (!aiScope) return;
    const t = aiGenerate(aiScope);
    $('aiOut').value = t;
    $('aiSize').textContent = `${t.length.toLocaleString()} characters · about ${Math.round(t.length / 3.6).toLocaleString()} tokens` + (t.length > 40000 ? ' — long; reduce the packets per device or turn off raw timings' : '');
  }
  function aiOpen(scope) {
    aiScope = scope;
    if (!(scope.keys || []).length && !scope.seq) return;
    scope.keys = scope.keys || [];
    $('aiPer').value = AI.per; $('aiTim').checked = AI.timings; $('aiAll').checked = AI.allrows; $('aiCand').checked = AI.cands; $('aiAna').checked = AI.analysis;
    $('aiTitle').textContent = scope.seq ? `packet #${scope.seq}` : scope.keys.length > 1 ? `${scope.keys.length} devices compared` : '';
    $('aiDlg').hidden = false; aiRender();
  }
  const aiChange = () => { AI.per = +$('aiPer').value; AI.timings = $('aiTim').checked; AI.allrows = $('aiAll').checked; AI.cands = $('aiCand').checked; AI.analysis = $('aiAna').checked; store.set('ai.opt', AI); aiRender(); };
  for (const id of ['aiPer', 'aiTim', 'aiAll', 'aiCand', 'aiAna']) $(id).onchange = aiChange;
  $('aiExtra').oninput = aiRender;
  $('aiClose').onclick = () => { $('aiDlg').hidden = true; aiScope = null; };
  addEventListener('keydown', e => { if (e.key === 'Escape' && !$('aiDlg').hidden) { e.stopPropagation(); $('aiClose').click(); } }, true);
  $('aiCopy').onclick = async e => { const b = e.target; $('aiOut').select(); try { await navigator.clipboard.writeText($('aiOut').value); b.textContent = 'Copied'; } catch { document.execCommand('copy'); b.textContent = 'Copied (selected)'; } setTimeout(() => (b.textContent = 'Copy prompt'), 1500); };
  $('aiDl').onclick = () => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([$('aiOut').value], { type: 'text/markdown' }));
    a.download = `433-ai-prompt-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.md`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
