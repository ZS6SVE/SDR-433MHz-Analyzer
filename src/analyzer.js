  // ===== Analyze workspace: compare devices, find shared sections, build rules =====
  const PAL = ['#58a6ff', '#f0a32b', '#3fb950', '#c6b5ff', '#ff7b72', '#39c5cf', '#e3b341', '#db61a2'];
  const esc = s => escapeHtml(s);
  const cmpSel = new Set(store.get('cmpSel', []));
  let rules = store.get('rules', []);
  const saveRules = () => store.set('rules', rules);
  function parsePat(s) {
    s = String(s || '').trim().replace(/[\s_]/g, '');
    if (/^0x[0-9a-f]+$/i.test(s)) return AC.hexBits(s.slice(2), (s.length - 2) * 4);
    return /^[01]+$/.test(s) ? s : '';
  }
  // ---- rules ("signatures"): a bit section that marks packets as one device
  function ruleMatches(r, e) {
    if (!e || !e.w || !e.w.length) return false;
    if (r.useUnit && r.unit) { const u = AC.autoUnit(e); if (u < r.unit * 0.7 || u > r.unit * 1.43) return false; }
    for (const row of AC.decode(e, r.opt)) {
      if (r.len && Math.abs(row.bits.length - r.len) > (r.lenTol || 0)) continue;
      if (r.at >= 0 && r.at !== undefined && r.at !== null && r.at !== '') {
        const w = row.bits.substr(+r.at, r.pattern.length);
        if (w.length < r.pattern.length) continue;
        let err = 0; for (let j = 0; j < w.length && err <= r.maxErr; j++) if (w[j] !== r.pattern[j]) err++;
        if (err <= r.maxErr) return true;
      } else if (AC.findApprox(row.bits, r.pattern, r.maxErr) >= 0) return true;
    }
    return false;
  }
  function ruleFor(e) {
    if (!rules.length || !e || !e.w || !e.w.length) return null;
    for (const r of rules) if (r.on && ruleMatches(r, e)) return r;
    return null;
  }
  const METHODS = [['auto', 'Auto (detected coding)'], ['app', 'As in log (app bit rows)'], ['levels', 'Waveform (raw levels at unit)'], ['nrz', 'NRZ'],
    ['manchester', 'Manchester (10=1)'], ['diffman', 'Differential Manchester'], ['pwm', 'PWM (short pulse = 1)'], ['ppm', 'PPM (long gap = 1)']];
  const ruleWhere = r => (r.at >= 0 && r.at !== '' && r.at !== null && r.at !== undefined ? `at bit ${r.at}` : 'anywhere') + (r.len ? ` · rows of ${r.len}${r.lenTol ? ' ±' + r.lenTol : ''} bits` : '');
  const optText = o => (METHODS.find(m => m[0] === o.method) || METHODS[0])[1] + (+o.unit ? `, unit ${o.unit} µs` : '') + (+o.rowGap ? `, rows split > ${o.rowGap} µs` : '') +
    (o.invert ? ', inverted' : '') + (o.lsb ? ', LSB first' : '') + (+o.skip ? `, skip ${o.skip}` : '');

  const AN = {
    tab: 'same', per: +store.get('an.per', 5), rowsMode: 'main', view: 'bin', anchor: '', anchorErr: 0, anchorOpt: '', sel: null, excl: new Set(),
    opt: Object.assign({ method: 'auto', unit: 0, rowGap: 0, invert: false, lsb: false, skip: 0 }, store.get('an.opt', {})),
    minLen: 8, scope: 'device', draft: null, zoom: 0, cs: null, common: null,
  };

  document.head.insertAdjacentHTML('beforeend', `<style>
  #cmpBar { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 15; display: flex; gap: 10px; align-items: center; background: var(--panel); border: 1px solid var(--accent); border-radius: 10px; padding: 8px 12px; box-shadow: 0 6px 24px #000a; }
  #cmpBar[hidden] { display: none; }
  .cmpChk { flex-direction: row; align-items: center; gap: 4px; text-transform: none; letter-spacing: 0; font-size: 12px; margin-left: auto; cursor: pointer; }
  .card.cmp { box-shadow: 0 0 0 2px var(--accent) inset; }
  #ana { position: fixed; inset: 0; background: #000b; z-index: 25; display: flex; justify-content: center; padding: 14px 12px; overscroll-behavior: contain; }
  #ana[hidden] { display: none; }
  #ana .apanel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; width: min(1500px, 100%); height: 100%; box-sizing: border-box; padding: 12px 18px 0; display: flex; flex-direction: column; min-height: 0; }
  #ana .apanel > * { flex: none; }
  #ana #aBody { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; padding-bottom: 18px; }
  #ana .chipsWrap { max-height: 62px; overflow: auto; flex: 1; min-width: 0; overscroll-behavior: contain; }
  #ana .chip b { font: 600 11px var(--mono); color: var(--c); }
  #ana .mxWrap { overflow: auto; max-width: 100%; }
  #ana .ahead { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  #ana .ahead h3 { margin: 0; font-size: 18px; }
  #ana .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  #ana .chip { display: inline-flex; gap: 6px; align-items: center; background: var(--panel2); border: 1px solid var(--line); border-radius: 14px; padding: 2px 4px 2px 10px; font-size: 12px; }
  #ana .chip i, #ana .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; background: var(--c); flex: none; }
  #ana .chip button { padding: 0 6px; border: 0; background: none; color: var(--dim); }
  #ana .actrl { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; margin: 12px 0 8px; padding: 10px; background: var(--panel2); border-radius: 8px; }
  #ana .actrl label { font-size: 10px; }
  #ana .actrl input[type=number], #ana .actrl input[type=text] { width: 80px; padding: 4px 6px; }
  #ana .actrl .chk { flex-direction: row; align-items: center; gap: 4px; }
  #ana .atabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 12px; flex-wrap: wrap; }
  #ana .atabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; color: var(--dim); }
  #ana .atabs button.on { color: var(--text); border-bottom-color: var(--accent); }
  #ana .note { color: var(--dim); font-size: 13px; margin: 6px 0; }
  #ana .note b { color: var(--text); font-weight: 500; }
  #ana h4 { margin: 16px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); }
  #ana table { border-collapse: collapse; font-size: 12px; }
  #ana td, #ana th { padding: 4px 10px 4px 0; text-align: left; vertical-align: top; }
  #ana th { color: var(--dim); font-weight: 500; font-size: 11px; }
  #ana .mono { font-family: var(--mono); }
  #ana .tb { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
  #ana .tb label { flex-direction: row; align-items: center; gap: 4px; text-transform: none; letter-spacing: 0; font-size: 12px; }
  #ana .tb input { width: 70px; padding: 3px 6px; }
  .gwrap { position: relative; overflow-x: auto; overflow-y: hidden; background: var(--panel2); border-radius: 8px; font: 12px/18px var(--mono); padding-bottom: 6px; user-select: none; }
  .gwrap .gl { white-space: pre; cursor: crosshair; }
  .gwrap .lab { position: sticky; left: 0; z-index: 2; display: inline-block; width: 170px; box-sizing: border-box; padding: 0 8px; background: var(--panel2); color: var(--dim); overflow: hidden; text-overflow: ellipsis; vertical-align: top; cursor: pointer; font-family: system-ui; font-size: 11px; }
  .gwrap .gl.hd .lab { cursor: default; }
  .gwrap .gl.off { opacity: .35; }
  .gwrap .gl.off .lab { text-decoration: line-through; }
  .gwrap .p { color: #3a4552; } .gwrap .k { color: #7ee2a8; } .gwrap .v { color: var(--text); } .gwrap .m { color: #ff9b5c; background: #ff7b5c22; } .gwrap .u { color: var(--dim); } .gwrap .x { color: var(--dim); }
  .gwrap .rul { color: #5d6b7a; } .gwrap .cs { color: #7ee2a8; } .gwrap .cs .d { color: #ff9b5c; }
  .gwrap .selov { position: absolute; top: 0; bottom: 0; background: #f0a32b30; border-left: 1px solid var(--accent); border-right: 1px solid var(--accent); pointer-events: none; z-index: 1; }
  .gwrap .anc { position: absolute; top: 0; bottom: 0; width: 0; border-left: 2px dashed #58a6ffaa; pointer-events: none; z-index: 1; }
  #ana .fields { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0; }
  #ana .fields button { padding: 2px 8px; font: 11px var(--mono); }
  #ana .fields button.k { border-color: #2f6f4a; } #ana .fields button.v { border-color: #8a5a2b; }
  #ana .wv { display: flex; background: var(--panel2); border-radius: 8px; }
  #ana .wv .wl { flex: none; width: 170px; font-size: 11px; color: var(--dim); }
  #ana .wv .wl div { height: 30px; line-height: 30px; padding: 0 8px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; cursor: pointer; }
  #ana .wv .wl div.off { opacity: .35; text-decoration: line-through; }
  #ana .wv .ws { overflow-x: auto; flex: 1; }
  #ana .wv canvas { width: auto; background: transparent; border-radius: 0; }
  #ana .mx td { text-align: center; min-width: 70px; padding: 6px; border: 1px solid var(--line); font-family: var(--mono); }
  #ana .mx th { padding: 6px; max-width: 160px; }
  #ana .pair { background: var(--panel2); border-radius: 8px; padding: 8px 12px; margin: 6px 0; font-size: 13px; }
  #ana .pair .bar { display: inline-block; height: 6px; border-radius: 3px; background: var(--accent); vertical-align: middle; margin-left: 6px; }
  #ana .rule { background: var(--panel2); border-radius: 8px; padding: 8px 12px; margin: 6px 0; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; font-size: 13px; }
  #ana .rule .pat { font: 11px var(--mono); color: var(--dim); word-break: break-all; flex-basis: 100%; }
  #ana .draft { border: 1px solid var(--accent); border-radius: 8px; padding: 10px 12px; margin: 8px 0; }
  #ana .draft textarea { width: 100%; height: 54px; background: var(--panel2); color: var(--text); border: 1px solid var(--line); border-radius: 6px; font: 12px var(--mono); padding: 6px; }
  #ana .draft .tb input[type=text] { width: 240px; }
  #ana .ok { color: var(--ok); } #ana .warn { color: var(--accent); } #ana .badc { color: var(--bad); }
  </style>`);
  document.body.insertAdjacentHTML('beforeend', `<div id="cmpBar" hidden><span id="cmpInfo"></span><button class="primary" id="cmpGo">Analyze</button><button id="cmpAi" title="Make one prompt for all selected devices, including the comparison">AI prompt</button><button id="cmpHide" title="Hide the selected devices from the list and the log">Hide</button><button id="cmpClr">Clear</button></div><div id="ana" hidden><div class="apanel" id="apanel"></div></div>`);

  function updCmpBar() {
    for (const k of [...cmpSel]) if (!devices.has(k) && devices.size) cmpSel.delete(k);
    $('cmpBar').hidden = !cmpSel.size || !$('ana').hidden;
    $('cmpInfo').textContent = `${cmpSel.size} device${cmpSel.size === 1 ? '' : 's'} selected for comparison`;
  }
  function toggleCmp(key, on) {
    if (on) cmpSel.add(key); else cmpSel.delete(key);
    store.set('cmpSel', [...cmpSel]); updCmpBar();
    const c = [...document.querySelectorAll('#devices .card')].find(x => x.dataset.key === key); if (c) c.classList.toggle('cmp', on);
  }
  $('devices').addEventListener('change', e => { const i = e.target.closest('[data-cmp]'); if (i) toggleCmp(i.closest('[data-key]').dataset.key, i.checked); });
  $('cmpGo').onclick = () => anOpen();
  $('cmpAi').onclick = () => aiOpen({ keys: [...cmpSel] });
  $('cmpHide').onclick = () => { setHidden([...cmpSel], true); cmpSel.clear(); store.set('cmpSel', []); updCmpBar(); };
  $('cmpClr').onclick = () => { cmpSel.clear(); store.set('cmpSel', []); updCmpBar(); renderDevices(); };
  addEventListener('keydown', e => { if (e.key === 'Escape' && !$('ana').hidden && $('aiDlg').hidden) anClose(); });

  // ---- model: the packets and bit rows being compared
  function anModel() {
    const devs = [...cmpSel].map(k => devices.get(k)).filter(Boolean);
    const lines = [];
    devs.forEach((d, di) => {
      for (const e of log.filter(x => x.key === d.key && x.w && x.w.length).slice(0, AN.per)) {
        const rows = AC.decode(e, AN.opt);
        let use;
        if (AN.rowsMode === 'all') use = rows;
        else {
          const r = AN.anchor && rows.find(r => AC.findApprox(r.bits, AN.anchor, AN.anchorErr) >= 0);
          const m = r || AC.mainRow(rows); use = m ? [m] : [];
        }
        for (const r of use) {
          const ri = rows.indexOf(r);
          lines.push({ id: e.seq + '.' + ri, e, d, di, r, label: '#' + e.seq + (AN.rowsMode === 'all' ? '.' + (ri + 1) : '') });
        }
        if (!use.length) lines.push({ id: e.seq + '.x', e, d, di, r: null, label: '#' + e.seq });
      }
    });
    let maxPos = 0, found = 0;
    for (const L of lines) {
      L.pos = !L.r ? -1 : AN.anchor ? AC.findApprox(L.r.bits, AN.anchor, AN.anchorErr) : 0;
      if (L.pos >= 0) found++;
      if (L.pos > maxPos) maxPos = L.pos;
    }
    // pattern in no row at all: show everything unaligned instead of an empty grid
    const anchorMissing = !!AN.anchor && !found;
    if (anchorMissing) for (const L of lines) L.pos = L.r ? 0 : -1;
    const useAnchor = AN.anchor && !anchorMissing;
    const extra = useAnchor ? (4 - maxPos % 4) % 4 : 0; // anchor on a nibble boundary so hex lines up too
    for (const L of lines) { L.pad = L.pos >= 0 ? maxPos - L.pos + extra : 0; L.active = !!L.r && L.pos >= 0 && !AN.excl.has(L.id); }
    const width = Math.max(0, ...lines.map(L => (L.r && L.pos >= 0 ? L.pad + L.r.bits.length : 0)));
    const cons = new Array(width);
    for (let c = 0; c < width; c++) {
      let n0 = 0, n1 = 0;
      for (const L of lines) { if (!L.active) continue; const ch = L.r.bits[c - L.pad]; if (ch === '0') n0++; else if (ch === '1') n1++; }
      cons[c] = { n0, n1, maj: n1 > n0 ? '1' : '0', cls: n0 + n1 < 2 ? 'u' : (!n0 || !n1) ? 'k' : 'v' };
    }
    return { devs, lines, width, cons, anchorCol: useAnchor ? maxPos + extra : -1, anchorMissing, found };
  }
  const bitAt = (L, c) => (L.r ? L.r.bits[c - L.pad] : undefined);
  const lineBits = (L, a, b) => { let s = ''; for (let c = a; c <= b; c++) { const x = bitAt(L, c); if (x === undefined) return null; s += x; } return s; };
  const colorOf = di => PAL[di % PAL.length];
  const tag = di => `<b style="--c:${colorOf(di)}">D${di + 1}</b>`;
  const devLabel = d => devName(d.key) || d.model + (d.unknown ? ' ' + fmtId(d) : '');

  // ---- open / close
  function anOpen(tab) {
    if (tab) AN.tab = tab;
    AN.cs = null; AN.common = null;
    $('ana').hidden = false; updCmpBar(); document.body.style.overflow = 'hidden';
    const P = $('apanel');
    P.innerHTML = `<div class="ahead"><h3>Analyze</h3><div class="chipsWrap"><div class="chips" id="aChips"></div></div><button id="aAi" title="Make one prompt for the selected devices, with the comparison, to paste into an AI chat">AI prompt</button><button id="aClose">Close</button></div>
      <div class="actrl">
        <label>packets per device<select id="aPer">${[1, 3, 5, 10, 20, 50].map(n => `<option ${n === AN.per ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label>decode as<select id="aMethod">${METHODS.map(([v, t]) => `<option value="${v}" ${v === AN.opt.method ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label title="Bit / sample unit in µs. Empty = measured per packet.">unit µs<input type="number" id="aUnit" min="1" placeholder="auto" value="${+AN.opt.unit || ''}"></label>
        <label title="Gaps longer than this start a new row (message repeat). Empty = automatic.">row split µs<input type="number" id="aRowGap" min="1" placeholder="auto" value="${+AN.opt.rowGap || ''}"></label>
        <label title="Drop this many bits from the start of every row">skip bits<input type="number" id="aSkip" min="0" value="${+AN.opt.skip || 0}" style="width:56px"></label>
        <label class="chk"><input type="checkbox" id="aInv" ${AN.opt.invert ? 'checked' : ''}>invert</label>
        <label class="chk" title="Reverse the bit order inside every byte"><input type="checkbox" id="aLsb" ${AN.opt.lsb ? 'checked' : ''}>LSB first</label>
        <label>rows<select id="aRows"><option value="main">main row per packet</option><option value="all" ${AN.rowsMode === 'all' ? 'selected' : ''}>all rows</option></select></label>
        <label title="Line all rows up on this bit pattern (bits, or hex as 0x…). Set it from a common section or a selection.">align on pattern<input type="text" id="aAnchor" placeholder="none" value="${AN.anchor}" style="width:170px"></label>
        <label title="Allowed wrong bits when looking for the pattern">tolerance<input type="number" id="aAncErr" min="0" value="${AN.anchorErr}" style="width:50px"></label>
      </div>
      <div class="atabs" id="aTabs">${[['same', 'Same device?'], ['wave', 'Waveforms'], ['bits', 'Bits & fields'], ['common', 'Common sections'], ['timing', 'Timing'], ['cs', 'Checksum / CRC'], ['rules', 'Rules']]
        .map(([k, t]) => `<button data-tab="${k}">${t}</button>`).join('')}</div>
      <div id="aBody"></div>`;
    $('aClose').onclick = anClose;
    $('aAi').onclick = () => aiOpen({ keys: [...cmpSel] });
    $('aTabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) { AN.tab = b.dataset.tab; anBody(); } };
    const ch = () => {
      AN.per = +$('aPer').value; store.set('an.per', AN.per);
      const prevOpt = JSON.stringify(AN.opt);
      AN.opt = { method: $('aMethod').value, unit: +$('aUnit').value || 0, rowGap: +$('aRowGap').value || 0, invert: $('aInv').checked, lsb: $('aLsb').checked, skip: +$('aSkip').value || 0 };
      store.set('an.opt', AN.opt);
      AN.rowsMode = $('aRows').value;
      const raw = $('aAnchor').value.trim(); AN.anchor = parsePat(raw); $('aAnchor').style.borderColor = raw && !AN.anchor ? 'var(--bad)' : '';
      AN.anchorErr = Math.max(0, +$('aAncErr').value || 0);
      if (AN.anchor && JSON.stringify(AN.opt) !== prevOpt && AN.anchorOpt === prevOpt) {
        // the pattern was made with the old decoding and means nothing in the new one
        AN.anchor = ''; $('aAnchor').value = ''; AN.sel = null;
        AN.flash = 'The align pattern was cleared because it came from a different decoding.';
      }
      AN.anchorOpt = AN.anchor ? (AN.anchorOpt && AN.anchor === AN.lastAnchor ? AN.anchorOpt : JSON.stringify(AN.opt)) : '';
      AN.lastAnchor = AN.anchor;
      AN.cs = null; AN.common = null; anBody();
    };
    for (const id of ['aPer', 'aMethod', 'aUnit', 'aRowGap', 'aSkip', 'aInv', 'aLsb', 'aRows', 'aAnchor', 'aAncErr']) $(id).onchange = ch;
    anBody();
  }
  function anClose() { $('ana').hidden = true; document.body.style.overflow = ''; updCmpBar(); renderDevices(); }
  function setAnchor(bits, err) { AN.anchor = bits; AN.lastAnchor = bits; AN.anchorOpt = JSON.stringify(AN.opt); AN.anchorErr = err || 0; $('aAnchor').value = bits; $('aAncErr').value = AN.anchorErr; AN.sel = null; AN.cs = null; AN.common = null; anBody(); }
  function anBody() {
    const M = anModel();
    $('aChips').innerHTML = M.devs.length ? M.devs.map((d, di) => `<span class="chip" style="--c:${colorOf(di)}"><i></i>${tag(di)} ${esc(devLabel(d))} <span style="color:var(--dim)">${M.lines.filter(L => L.di === di).length} rows</span><button data-rm="${esc(d.key)}" title="Remove from comparison">×</button></span>`).join('')
      : '<span class="note">No devices selected. Tick "compare" on device cards, then press Analyze.</span>';
    $('aChips').onclick = e => { const b = e.target.closest('[data-rm]'); if (b) { toggleCmp(b.dataset.rm, false); anBody(); } };
    for (const b of $('aTabs').children) b.classList.toggle('on', b.dataset.tab === AN.tab);
    $('aTabs').lastChild.textContent = `Rules (${rules.length})`;
    const body = $('aBody');

    const f = { same: tabSame, wave: tabWave, bits: tabBits, common: tabCommon, timing: tabTiming, cs: tabCs, rules: tabRules }[AN.tab];
    f(M, body);
    if (AN.flash) { body.insertAdjacentHTML('afterbegin', `<div class="note"><span class="warn">${AN.flash}</span></div>`); AN.flash = ''; }
  }
  const note = s => `<div class="note">${s}</div>`;
  const pct = x => Math.round(x * 100) + '%';

  // ---- tab: are these the same device?
  function devFeatures(M) {
    return M.devs.map((d, di) => {
      const pk = log.filter(x => x.key === d.key && x.w && x.w.length);
      const use = pk.slice(0, Math.max(AN.per, 10));
      const W = [], G = []; for (const e of use) { W.push(...e.w); G.push(...e.g.slice(0, -1)); }
      const rows = [...new Set(M.lines.filter(L => L.di === di && L.active).map(L => L.r.bits))].map(s => s.slice(0, 2000));
      const mods = {}; for (const e of use) { const m = e.analysis ? e.analysis.modulation : 'decoded'; mods[m] = (mods[m] || 0) + 1; }
      const mod = (Object.entries(mods).sort((a, b) => b[1] - a[1])[0] || ['?'])[0];
      return { d, di, W, G, hw: AC.hist(W), hg: AC.hist(G), rows, mod, f: AC.med(use.map(e => e.freqHz)), times: pk.map(e => e.time).sort((a, b) => a - b), len: AC.med(rows.map(r => r.length)) };
    });
  }
  function together(A, B) {
    if (!A.length || !B.length) return 0;
    let j = 0, hit = 0;
    for (const t of A) { while (j < B.length && B[j] < t - 1500) j++; if (j < B.length && Math.abs(B[j] - t) <= 1500) hit++; }
    return hit / A.length;
  }
  function tabSame(M, body) {
    if (M.devs.length < 2) { body.innerHTML = note('Select at least two devices to compare them. Tick <b>compare</b> on the device cards.'); return; }
    const F = devFeatures(M), pairs = [];
    for (let i = 0; i < F.length; i++) for (let j = i + 1; j < F.length; j++) {
      const a = F[i], b = F[j];
      const timing = (AC.overlap(a.hw, b.hw) + (a.G.length && b.G.length ? AC.overlap(a.hg, b.hg) : AC.overlap(a.hw, b.hw))) / 2;
      const common = AC.lcs(a.rows, b.rows), minLen = Math.min(a.len, b.len) || 1;
      const filler = AC.lowComplexity(common);
      let bits = Math.min(1, common.length / minLen); if (filler) bits *= 0.3;
      const df = Math.abs(a.f - b.f), freq = df < 15e3 ? 1 : df < 60e3 ? 0.5 : 0;
      const mod = a.mod === b.mod ? 1 : 0.3;
      const tog = Math.max(together(a.times, b.times), together(b.times, a.times));
      let score = 0.35 * timing + 0.35 * bits + 0.15 * freq + 0.15 * mod;
      if (tog > 0.5) score = Math.max(score, 0.5 + 0.5 * tog * timing);
      let verdict;
      if (tog > 0.6 && timing > 0.5) verdict = '<span class="ok">Heard at the same moments — very likely one transmitter (or one transmission split into two cards).</span>';
      else if (score >= 0.8) verdict = '<span class="ok">Very likely the same device.</span>';
      else if (timing >= 0.75 && bits >= 0.4) verdict = '<span class="warn">Same kind of device (same timing and largely the same bits). The bits that differ may be an ID — could be two units of one model, or one device whose data changed.</span>';
      else if (score >= 0.6) verdict = '<span class="warn">Possibly the same device.</span>';
      else if (timing >= 0.7) verdict = 'Similar timing (maybe the same chip/protocol family), different content.';
      else verdict = '<span class="badc">Probably different devices.</span>';
      pairs.push({ i, j, a, b, timing, bits, common, filler, freq, df, mod, tog, score, verdict });
    }
    const cell = (i, j) => { if (i === j) return '<td style="color:var(--dim)">—</td>'; const p = pairs.find(p => (p.i === i && p.j === j) || (p.i === j && p.j === i)); const h = Math.round(p.score * 120); return `<td style="background:hsla(${h},60%,35%,.45)" title="${esc(p.verdict.replace(/<[^>]+>/g, ''))}">${pct(p.score)}</td>`; };
    let h = note('Compares timing fingerprints (pulse and gap widths), the longest shared bit section (using the decoding chosen above), frequency, modulation and whether they are heard at the same moments. Use it to spot cards that are really one device.');
    const big = F.length > 5;
    h += '<div class="mxWrap"><table class="mx"><tr><th></th>' + F.map(f => `<th title="${esc(devLabel(f.d))}">${tag(f.di)}${big ? '' : ' ' + esc(devLabel(f.d))}</th>`).join('') + '</tr>' +
      F.map(f => `<tr><th title="${esc(devLabel(f.d))}" style="text-align:left;white-space:nowrap">${tag(f.di)}${big ? '' : ' ' + esc(devLabel(f.d))}</th>${F.map(g => cell(f.di, g.di)).join('')}</tr>`).join('') + '</table></div>';
    if (pairs.length > 30) h += note(`Showing the 30 most similar of ${pairs.length} pairs.`);
    h += '<h4>Pairs, most similar first</h4>';
    for (const p of pairs.sort((x, y) => y.score - x.score).slice(0, 30)) {
      const bar = v => `<span class="bar" style="width:${Math.round(v * 60)}px"></span>`;
      h += `<div class="pair"><b>${tag(p.i)} ${esc(devLabel(p.a.d))}</b> vs <b>${tag(p.j)} ${esc(devLabel(p.b.d))}</b> — ${pct(p.score)} · ${p.verdict}
        <div class="note" style="margin:4px 0 0">timing ${pct(p.timing)}${bar(p.timing)} · shared bits ${p.common.length}/${Math.round(Math.min(p.a.len, p.b.len))} ${p.filler ? '(only preamble-like filler)' : ''}${bar(p.bits)} · frequency Δ ${Math.round(p.df / 1000)} kHz · modulation ${p.mod === 1 ? 'same' : `${esc(p.a.mod)} / ${esc(p.b.mod)}`} · heard together ${pct(p.tog)}
        ${p.common.length >= 8 ? `<br><span class="mono" style="word-break:break-all">${p.common.length > 96 ? p.common.slice(0, 96) + '…' : p.common}</span> <button class="mini" data-anchor="${p.common}">Align on this</button> <button class="mini" data-rule="${p.common}">Make rule</button>` : ''}</div></div>`;
    }
    body.innerHTML = h;
    body.onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.anchor) { AN.tab = 'bits'; setAnchor(b.dataset.anchor); }
      else if (b.dataset.rule) newDraft(b.dataset.rule, M);
    };
  }

  // ---- tab: waveforms, stacked on one time scale
  function tabWave(M, body) {
    if (!M.lines.length) { body.innerHTML = note('No packets with timing data for the selected devices.'); return; }
    const sel = AN.sel;
    const anchorT = L => (AN.anchor && L.r && L.r.t && L.pos >= 0 ? L.r.t[L.pos] : 0);
    const maxA = Math.max(0, ...M.lines.map(anchorT));
    const dur = e => { let t = 0; for (let i = 0; i < e.w.length; i++) t += e.w[i] + (i < e.w.length - 1 ? e.g[i] : 0); return t; };
    const total = Math.max(1, ...M.lines.map(L => dur(L.e) + maxA - anchorT(L)));
    const minFeat = Math.max(10, AC.med(M.lines.flatMap(L => L.e.w)) / 2);
    const fit = Math.max(0.0005, (Math.min(1300, innerWidth - 260)) / total);
    if (!AN.zoom) AN.zoom = 1;
    const sx = Math.min(fit * AN.zoom, 20 / minFeat * 4);
    const RH = 30, W = Math.min(32000, Math.ceil(total * sx) + 20), H = M.lines.length * RH + 24;
    body.innerHTML = `<div class="tb"><label>zoom <input type="range" id="wZoom" min="0" max="7" step="0.25" value="${Math.log2(AN.zoom)}" style="width:180px"></label>
      <span class="note">${AN.anchor ? 'Aligned on the pattern' + (AN.anchor && M.lines.some(L => L.r && !L.r.t) ? ' (not possible with “As in log” decoding — pick another decoding)' : '') : 'Aligned on the first pulse. Set “align on pattern” to line the packets up on a shared section.'}
      ${sel ? ' · orange = selected bits.' : ''} Click a label to leave a packet out.</span></div>
      <div class="wv"><div class="wl">${M.lines.map(L => `<div class="${L.active ? '' : 'off'}" data-line="${L.id}" title="${esc(devLabel(L.d))}">${tag(L.di)} ${L.label} ${hhmmss(L.e.time)}</div>`).join('')}</div>
      <div class="ws"><canvas id="wCan" width="${W}" height="${H}" style="width:${W}px;height:${H}px"></canvas></div></div>`;
    const ctx = $('wCan').getContext('2d');
    // time grid
    let step = 1; const want = 100 / sx, pw = Math.pow(10, Math.floor(Math.log10(want)));
    for (const k of [1, 2, 5, 10]) if (k * pw >= want) { step = k * pw; break; }
    ctx.font = '10px system-ui'; ctx.fillStyle = '#8b98a8'; ctx.strokeStyle = '#2a3340';
    for (let t = 0; t <= total; t += step) { const x = 10 + t * sx; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H - 18); ctx.stroke(); ctx.fillText(t >= 1000 ? (t / 1000).toFixed(step >= 1000 ? 0 : 2) + ' ms' : Math.round(t) + ' µs', x + 2, H - 6); }
    M.lines.forEach((L, k) => {
      const off = maxA - anchorT(L), y0 = k * RH, hi = y0 + 6, lo = y0 + RH - 6;
      const X = t => 10 + (t + off) * sx;
      if (L.r && L.r.t && L.active) {
        const tEnd = i => (i + 1 < L.r.t.length ? L.r.t[i + 1] : L.r.t[i] + (L.r.t[i] - (L.r.t[i - 1] || 0)));
        if (AN.anchor && L.pos >= 0) { ctx.fillStyle = '#58a6ff22'; ctx.fillRect(X(L.r.t[L.pos]), y0 + 2, X(tEnd(Math.min(L.r.t.length - 1, L.pos + AN.anchor.length - 1))) - X(L.r.t[L.pos]), RH - 4); }
        if (sel) {
          const a = sel.a - L.pad, b = sel.b - L.pad;
          if (b >= 0 && a < L.r.t.length) { const aa = Math.max(0, a), bb = Math.min(L.r.t.length - 1, b); ctx.fillStyle = '#f0a32b44'; ctx.fillRect(X(L.r.t[aa]), y0 + 2, Math.max(2, X(tEnd(bb)) - X(L.r.t[aa])), RH - 4); }
        }
      }
      ctx.strokeStyle = colorOf(L.di); ctx.globalAlpha = L.active ? 1 : 0.3; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(X(0), lo);
      let t = 0; const e = L.e;
      for (let i = 0; i < e.w.length; i++) { ctx.lineTo(X(t), lo); ctx.lineTo(X(t), hi); ctx.lineTo(X(t + e.w[i]), hi); ctx.lineTo(X(t + e.w[i]), lo); t += e.w[i] + (i < e.w.length - 1 ? e.g[i] : 0); }
      ctx.stroke(); ctx.globalAlpha = 1;
    });
    $('wZoom').oninput = e => { AN.zoom = Math.pow(2, +e.target.value); tabWave(M, body); };
    body.querySelector('.wl').onclick = e => { const d = e.target.closest('[data-line]'); if (d) { toggleExcl(d.dataset.line); } };
  }
  function toggleExcl(id) { if (AN.excl.has(id)) AN.excl.delete(id); else AN.excl.add(id); AN.cs = null; AN.common = null; anBody(); }

  // ---- tab: aligned bits / hex with consensus and field selection
  let chW = 7.2;
  function measureCh(wrap) { const s = document.createElement('span'); s.textContent = '0'.repeat(100); s.style.cssText = 'position:absolute;visibility:hidden;white-space:pre'; wrap.appendChild(s); chW = s.getBoundingClientRect().width / 100 || 7.2; s.remove(); }
  function rowText(L, M, hex) {
    const out = []; let cur = '', cls = '';
    const put = (ch, c) => { if (c !== cls) { if (cur) out.push(`<span class="${cls}">${cur}</span>`); cur = ''; cls = c; } cur += ch; };
    if (!L.r || L.pos < 0) { put(L.r ? 'pattern not found in this row' : 'no bits decoded', 'x'); }
    else if (!hex) {
      const end = L.pad + L.r.bits.length;
      for (let c = 0; c < end; c++) {
        if (c < L.pad) { put('·', 'p'); continue; }
        const ch = L.r.bits[c - L.pad];
        if (!L.active) { put(ch, 'x'); continue; }
        const k = M.cons[c]; put(ch, k.cls === 'u' ? 'u' : k.cls === 'k' ? 'k' : ch === k.maj ? 'v' : 'm');
      }
    } else {
      const end = L.pad + L.r.bits.length;
      for (let n = 0; n * 4 < end; n++) {
        const s = lineBits(L, n * 4, n * 4 + 3);
        if (s === null) { put(n * 4 + 3 < L.pad ? '·' : (n * 4 < L.pad ? '·' : '·'), 'p'); continue; }
        const ch = parseInt(s, 2).toString(16);
        if (!L.active) { put(ch, 'x'); continue; }
        let all = true, maj = true, und = false;
        for (let c = n * 4; c < n * 4 + 4; c++) { const k = M.cons[c]; if (k.cls === 'u') und = true; if (k.cls !== 'k') all = false; if (s[c - n * 4] !== k.maj) maj = false; }
        put(ch, und ? 'u' : all ? 'k' : maj ? 'v' : 'm');
      }
    }
    if (cur) out.push(`<span class="${cls}">${cur}</span>`);
    return out.join('');
  }
  function fieldsOf(M) {
    const segs = []; let s = 0;
    const cl = c => (M.cons[c].cls === 'u' ? 'u' : M.cons[c].cls);
    for (let c = 1; c <= M.width; c++) if (c === M.width || cl(c) !== cl(s)) { if (cl(s) !== 'u') segs.push({ a: s, b: c - 1, cls: cl(s) }); s = c; }
    // a short run of agreeing bits inside a varying area is usually chance: merge it into the varying field
    const out = [];
    for (let i = 0; i < segs.length; i++) {
      const g = segs[i], prev = out[out.length - 1];
      const short = g.cls === 'k' && g.b - g.a < 3 && prev && prev.cls === 'v' && segs[i + 1] && segs[i + 1].cls === 'v';
      if (prev && prev.b === g.a - 1 && (prev.cls === g.cls || short)) { prev.b = g.b; continue; }
      if (prev && prev.cls === 'v' && g.cls === 'v' && prev.b === g.a - 1) { prev.b = g.b; continue; }
      out.push({ ...g, cls: short ? 'v' : g.cls });
    }
    return out;
  }
  function tabBits(M, body) {
    if (!M.lines.length) { body.innerHTML = note('No packets with timing data for the selected devices.'); return; }
    const hex = AN.view === 'hex', n = M.lines.filter(L => L.active).length;
    let ruler = '', cs = '';
    if (!hex) {
      for (let c = 0; c < M.width; c += 8) ruler += String(c).padEnd(8, ' ');
      for (let c = 0; c < M.width; c++) cs += M.cons[c].cls === 'k' ? '=' : M.cons[c].cls === 'v' ? '<span class="d">≠</span>' : ' ';
    } else {
      for (let c = 0; c < M.width; c += 16) ruler += String(c).padEnd(4, ' ');
      for (let c = 0; c < M.width; c += 4) { const k = M.cons.slice(c, c + 4); cs += k.some(x => x.cls === 'v') ? '<span class="d">≠</span>' : k.every(x => x.cls === 'k') ? '=' : ' '; }
    }
    const fields = fieldsOf(M);
    body.innerHTML = `<div class="tb">
        <label>show <select id="bView"><option value="bin">binary</option><option value="hex" ${hex ? 'selected' : ''}>hex</option></select></label>
        <label>select bits <input type="number" id="bA" min="0" value="${AN.sel ? AN.sel.a : ''}"> to <input type="number" id="bB" min="0" value="${AN.sel ? AN.sel.b : ''}"></label>
        <button class="mini" id="bClr">Clear selection</button><button class="mini" id="bCopy">Copy as text</button>
        ${M.anchorMissing ? `<div class="note" style="flex-basis:100%"><span class="warn">The align pattern isn't in any row with this decoding — showing rows unaligned.</span> It probably came from another “decode as” setting. <button class="mini" id="bNoAnc">Clear pattern</button></div>` : ''}
        <span class="note">${AN.anchor && !M.anchorMissing ? `Align pattern found in <b class="${n < M.lines.length ? 'warn' : ''}">${M.lines.filter(L => L.pos >= 0).length}/${M.lines.length}</b> rows${n < M.lines.filter(L => L.pos >= 0).length ? '' : ''}. ` : ''}${n} rows compared. <span style="color:#7ee2a8">green</span> = same in every row, <span style="color:#ff9b5c">orange</span> = differs from the majority. Drag across the bits to select a field; click a label to leave a row out.</span></div>
      <div class="gwrap" id="bGrid">
        <div class="gl hd"><span class="lab">bit</span><span class="rul">${ruler}</span></div>
        <div class="gl hd"><span class="lab" title="= same in all rows, ≠ differs">agreement</span><span class="cs">${cs}</span></div>
        ${M.lines.map(L => `<div class="gl ${L.active ? '' : 'off'}" data-line="${L.id}"><span class="lab" title="${esc(devLabel(L.d))} · ${L.r ? L.r.bits.length + ' bits' : ''} · click to include/exclude">${tag(L.di)} ${L.label} ${hhmmss(L.e.time)} ${L.r ? '· ' + L.r.bits.length : ''}</span>${rowText(L, M, hex)}</div>`).join('')}
        <div class="selov" id="bSel" hidden></div>${M.anchorCol >= 0 ? `<div class="anc" style="left:calc(170px + ${hex ? M.anchorCol / 4 : M.anchorCol}ch)"></div>` : ''}
      </div>
      <h4>Fields (from where the rows agree or differ)</h4>
      <div class="fields">${fields.slice(0, 80).map(f => `<button class="${f.cls}" data-a="${f.a}" data-b="${f.b}" title="${f.cls === 'k' ? 'same in all rows' : 'differs between rows'}">${f.a}–${f.b} ${f.cls === 'k' ? '=' : '≠'} (${f.b - f.a + 1})</button>`).join('') || '<span class="note">Need at least two rows.</span>'}</div>
      <div id="bSelInfo"></div>`;
    const grid = $('bGrid'); measureCh(grid);
    const ov = $('bSel');
    const showSel = () => {
      if (!AN.sel) { ov.hidden = true; return; }
      const a = hex ? Math.floor(AN.sel.a / 4) : AN.sel.a, b = hex ? Math.floor(AN.sel.b / 4) : AN.sel.b;
      ov.hidden = false; ov.style.left = `calc(170px + ${a}ch)`; ov.style.width = `calc(${b - a + 1}ch)`;
      $('bA').value = AN.sel.a; $('bB').value = AN.sel.b;
    };
    const colAt = ev => { const r = grid.getBoundingClientRect(); const x = ev.clientX - r.left + grid.scrollLeft - 170; const c = Math.max(0, Math.floor(x / chW)); return hex ? c * 4 : c; };
    let drag = null;
    grid.onmousedown = ev => {
      const lab = ev.target.closest('.lab');
      if (lab) { const gl = lab.closest('[data-line]'); if (gl) toggleExcl(gl.dataset.line); return; }
      const c = Math.min(colAt(ev), Math.max(0, M.width - 1)); drag = c; AN.sel = { a: c, b: hex ? c + 3 : c }; showSel(); ev.preventDefault();
    };
    grid.onmousemove = ev => { if (drag === null) return; const c = Math.min(colAt(ev), Math.max(0, M.width - 1)); AN.sel = { a: Math.min(drag, c), b: Math.max(drag, c) + (hex ? 3 : 0) }; showSel(); };
    const up = () => { if (drag === null) return; drag = null; selInfo(M); };
    grid.onmouseup = up; grid.onmouseleave = up;
    $('bView').onchange = e => { AN.view = e.target.value; anBody(); };
    if ($('bNoAnc')) $('bNoAnc').onclick = () => setAnchor('');
    const setNum = () => { const a = +$('bA').value, b = +$('bB').value; if ($('bA').value !== '' && $('bB').value !== '' && b >= a && !(AN.sel && AN.sel.a === a && AN.sel.b === b)) { AN.sel = { a, b }; showSel(); selInfo(M); } };
    $('bA').onchange = setNum; $('bB').onchange = setNum;
    $('bClr').onclick = () => { AN.sel = null; showSel(); selInfo(M); };
    $('bCopy').onclick = e => copy(M.lines.filter(L => L.active).map(L => `${L.label}\t${devLabel(L.d)}\t${' '.repeat(hex ? L.pad >> 2 : L.pad)}${hex ? AC.toBytes(L.r.bits, 0).map(x => x.toString(16).padStart(2, '0')).join('') : L.r.bits}`).join('\n'), e.target);
    body.querySelector('.fields').onclick = e => { const b = e.target.closest('[data-a]'); if (b) { AN.sel = { a: +b.dataset.a, b: +b.dataset.b }; showSel(); selInfo(M); } };
    showSel(); selInfo(M);
  }
  function selInfo(M) {
    const box = $('bSelInfo'); if (!box) return;
    if (!AN.sel) { box.innerHTML = note('Select bits (drag across the grid, or click a field above) to see their values per packet, line the packets up on them, test them for a checksum, or turn them into a rule.'); return; }
    const { a, b } = AN.sel, n = b - a + 1;
    const vals = M.lines.filter(L => L.active).map(L => ({ L, s: lineBits(L, a, b) })).filter(x => x.s !== null);
    if (!vals.length) { box.innerHTML = note('No row covers the whole selection.'); return; }
    const distinct = [...new Set(vals.map(v => v.s))];
    const maj = [...Array(n)].map((_, i) => (M.cons[a + i] ? M.cons[a + i].maj : '0')).join('');
    const maxErr = Math.max(...vals.map(v => [...v.s].filter((c, i) => c !== maj[i]).length));
    const u = s => (n <= 52 ? parseInt(s, 2) : NaN);
    const sgn = s => { const x = u(s); return n <= 52 && s[0] === '1' ? x - Math.pow(2, n) : x; };
    const rev = s => u([...s].reverse().join(''));
    const bcd = s => (n % 4 === 0 && /^(?:[0-9])+$/.test(s.match(/.{4}/g).map(q => parseInt(q, 2)).map(x => (x > 9 ? 'x' : x)).join('')) ? s.match(/.{4}/g).map(q => parseInt(q, 2)).join('') : '');
    const hx = s => (n % 4 === 0 ? s.match(/.{4}/g).map(q => parseInt(q, 2).toString(16)).join('') : AC.toBytes(s.padStart(Math.ceil(n / 8) * 8, '0'), 0).map(x => x.toString(16).padStart(2, '0')).join(''));
    // observations
    const obs = [];
    if (distinct.length === 1) obs.push(`<span class="ok">Identical in all ${vals.length} rows</span> — a sync word, ID or fixed setting. Good material for a rule.`);
    else {
      obs.push(`${distinct.length} different values in ${vals.length} rows.`);
      const byT = [...vals].sort((x, y) => x.L.e.time - y.L.e.time).map(v => u(v.s));
      let inc = 0; for (let i = 1; i < byT.length; i++) if (byT[i] > byT[i - 1] || byT[i] < byT[i - 1] - Math.pow(2, n - 1)) inc++;
      if (byT.length >= 3 && inc === byT.length - 1) obs.push('Increases with every packet (oldest → newest): looks like a <b>counter</b> or rolling code.');
      const devsHere = new Set(vals.map(v => v.L.di));
      if (devsHere.size > 1 && [...devsHere].every(di => new Set(vals.filter(v => v.L.di === di).map(v => v.s)).size === 1)) obs.push('Constant within each device but different between devices: looks like a <b>device ID</b> (or a channel / button).');
      const t10 = byT.map(x => x / 10); if (n >= 8 && n <= 16 && t10.every(x => x > -40 && x < 70) && Math.max(...t10) - Math.min(...t10) < 15) obs.push('Values ÷ 10 stay in a narrow −40…70 range: could be a <b>temperature in 0.1 °C</b>.');
    }
    box.innerHTML = `<h4>Selection: bits ${a}–${b} (${n} bits)</h4><div class="note">${obs.join(' ')}</div>
      <div class="tb"><button class="mini" id="sAnchor">Align all rows on this</button><button class="mini" id="sRule">Make rule from this</button><button class="mini" id="sCs">Look for a checksum in this</button>
      ${distinct.length > 1 ? `<span class="note">A rule from varying bits needs a tolerance of about ${maxErr} wrong bits.</span>` : ''}</div>
      <div style="max-height:260px;overflow:auto"><table><tr><th>row</th><th>time</th><th>bits</th><th>hex</th><th>unsigned</th><th>signed</th><th>LSB-first</th><th>BCD</th></tr>
      ${vals.map(v => `<tr><td><span class="dot" style="--c:${colorOf(v.L.di)}"></span> ${v.L.label}</td><td>${hhmmss(v.L.e.time)}</td><td class="mono" style="word-break:break-all;max-width:420px">${v.s}</td><td class="mono">${hx(v.s)}</td><td class="mono">${isNaN(u(v.s)) ? '—' : u(v.s)}</td><td class="mono">${isNaN(u(v.s)) ? '—' : sgn(v.s)}</td><td class="mono">${isNaN(u(v.s)) ? '—' : rev(v.s)}</td><td class="mono">${bcd(v.s)}</td></tr>`).join('')}</table></div>`;
    $('sAnchor').onclick = () => setAnchor(maj, maxErr);
    $('sRule').onclick = () => { const ps = [...new Set(vals.map(v => a - v.L.pad))]; newDraft(maj, M, maxErr, ps.length === 1 && ps[0] >= 0 ? ps[0] : -1); };
    $('sCs').onclick = () => { AN.tab = 'cs'; AN.cs = null; anBody(); };
  }

  // ---- tab: sections every device (or every packet) shares
  function tabCommon(M, body) {
    if (!M.lines.length) { body.innerHTML = note('Nothing to compare yet.'); return; }
    body.innerHTML = `<div class="tb"><label>min length <input type="number" id="cMin" min="4" value="${AN.minLen}"> bits</label>
      <label>must appear in <select id="cScope"><option value="device">every selected device (at least one packet each)</option><option value="packet" ${AN.scope === 'packet' ? 'selected' : ''}>every packet</option></select></label>
      <button class="mini" id="cRun">Find</button></div>
      ${note('A section shared by all selected devices — and not just preamble filler (1010…, 0000…) — is strong evidence they are the same device or the same protocol. Turn it into a rule to merge them; lengths may differ. Change “decode as” above to search the raw waveform (“Waveform”) or a different coding.')}<div id="cOut"></div>`;
    const run = () => {
      AN.minLen = Math.max(4, +$('cMin').value || 8); AN.scope = $('cScope').value;
      const act = M.lines.filter(L => L.active);
      const groups = AN.scope === 'packet' ? act.map(L => [L.r.bits]) : M.devs.map((d, di) => act.filter(L => L.di === di).map(L => L.r.bits)).filter(g => g.length);
      $('cOut').innerHTML = note('Searching…');
      setTimeout(() => {
        const t0 = performance.now();
        const secs = AC.commonSections(groups, AN.minLen, 25);
        AN.common = { secs, ms: Math.round(performance.now() - t0) };
        renderCommon(M);
      }, 20);
    };
    $('cRun').onclick = run;
    if (AN.common) renderCommon(M); else run();
  }
  function renderCommon(M) {
    const { secs, ms } = AN.common, act = M.lines.filter(L => L.active);
    if (!secs.length) { $('cOut').innerHTML = note(`No shared section of ${AN.minLen}+ bits. Try a shorter minimum, another decoding, or leave out noisy rows (click their label in the Bits tab).`); return; }
    $('cOut').innerHTML = `<table><tr><th>bits</th><th>kind</th><th>pattern</th><th>found in</th><th></th></tr>${secs.map((s, i) => {
      const per = act.filter(L => L.r.bits.includes(s)).length;
      const pos = M.devs.map((d, di) => { const p = act.filter(L => L.di === di).map(L => L.r.bits.indexOf(s)).filter(x => x >= 0); return p.length ? `<span class="dot" style="--c:${colorOf(di)}"></span> @${[...new Set(p)].slice(0, 3).join(',')}` : ''; }).join(' ');
      const lc = AC.lowComplexity(s);
      return `<tr><td class="mono">${s.length}</td><td>${lc ? '<span class="warn">filler / preamble</span>' : 'content'}</td><td class="mono" style="word-break:break-all;max-width:520px">${s.length > 128 ? s.slice(0, 128) + '…' : s}${s.length % 4 === 0 ? `<br><span style="color:var(--dim)">0x${s.match(/.{4}/g).map(q => parseInt(q, 2).toString(16)).join('')}</span>` : ''}</td>
        <td>${per}/${act.length} rows<br>${pos}</td><td><button class="mini" data-i="${i}" data-act="anchor">Align</button> <button class="mini" data-i="${i}" data-act="rule">Make rule</button></td></tr>`;
    }).join('')}</table><div class="note">${secs.length} sections in ${ms} ms. @n = bit position in the row.</div>`;
    $('cOut').onclick = e => { const b = e.target.closest('[data-act]'); if (!b) return; const s = secs[+b.dataset.i]; if (b.dataset.act === 'anchor') { AN.tab = 'bits'; setAnchor(s); } else newDraft(s, M); };
  }

  // ---- tab: timing fingerprints
  function tabTiming(M, body) {
    const F = devFeatures(M);
    if (!F.length) { body.innerHTML = note('Nothing selected.'); return; }
    body.innerHTML = `${note('Pulse and gap widths of every packet (log scale). Devices built on the same chip and protocol have their peaks in the same places; different peaks mean a different protocol.')}
      <canvas id="tCan" height="300"></canvas>
      <table style="margin-top:10px"><tr><th>device</th><th>modulation</th><th>frequency</th><th>pulse widths µs (main clusters)</th><th>gap widths µs</th><th>row length</th><th>interval</th></tr>
      ${F.map(f => { const st = devStats(f.d); return `<tr><td><span class="dot" style="--c:${colorOf(f.di)}"></span> ${esc(devLabel(f.d))}</td><td>${esc(f.mod)}</td><td class="mono">${mhz(f.f)}</td><td class="mono">${peaks(f.W)}</td><td class="mono">${peaks(f.G)}</td><td class="mono">${Math.round(f.len) || '—'}</td><td>${esc(st.label)}</td></tr>`; }).join('')}</table>`;
    const c = $('tCan'), [ctx, w, h] = fitCanvas(c);
    const half = (h - 30) / 2, X = b => 40 + (b / 60) * (w - 50);
    ctx.font = '10px system-ui'; ctx.fillStyle = '#8b98a8'; ctx.strokeStyle = '#2a3340';
    for (let d = 0; d <= 4; d++) { const x = X(d * 15); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - 20); ctx.stroke(); ctx.fillText(['10 µs', '100 µs', '1 ms', '10 ms', '100 ms'][d], x + 2, h - 6); }
    ctx.fillText('pulses', 2, 12); ctx.fillText('gaps', 2, half + 22);
    for (const [k, key] of [[0, 'hw'], [1, 'hg']]) {
      const y0 = k * (half + 10) + 4, mx = Math.max(1e-9, ...F.map(f => Math.max(...f[key])));
      for (const f of F) {
        ctx.strokeStyle = colorOf(f.di); ctx.lineWidth = 1.6; ctx.beginPath();
        for (let b = 0; b < 60; b++) { const y = y0 + half - (f[key][b] / mx) * (half - 6); if (!b) ctx.moveTo(X(b + 0.5), y); else ctx.lineTo(X(b + 0.5), y); }
        ctx.stroke();
      }
    }
  }
  function peaks(v) {
    if (!v.length) return '—';
    const s = [...v].sort((a, b) => a - b), cl = [];
    for (const x of s) { const c = cl[cl.length - 1]; if (c && x <= c.hi * 1.25) { c.hi = x; c.n++; c.sum += x; } else cl.push({ hi: x, n: 1, sum: x }); }
    return cl.filter(c => c.n >= Math.max(2, v.length * 0.03)).sort((a, b) => b.n - a.n).slice(0, 4).sort((a, b) => a.sum / a.n - b.sum / b.n).map(c => `${Math.round(c.sum / c.n)}×${c.n}`).join('  ') || '—';
  }

  // ---- tab: checksum / CRC search
  function tabCs(M, body) {
    const act = M.lines.filter(L => L.active);
    const sel = AN.sel;
    const msgs = act.map(L => (sel ? lineBits(L, sel.a, sel.b) : L.r.bits.slice(Math.max(0, (M.anchorCol >= 0 ? M.anchorCol - L.pad : 0))))).filter(Boolean);
    body.innerHTML = `${note(`Tries XOR, sums and common CRC-8 / CRC-16 variants over every byte range, at every bit offset, on <b>${msgs.length}</b> rows ${sel ? `(selected bits ${sel.a}–${sel.b})` : M.anchorCol >= 0 ? '(from the align pattern to the end)' : '(whole rows)'}. Works best with 5+ packets of <b>one</b> device whose data differs. Select the message without the preamble/sync in the Bits tab to speed it up.`)}
      <button class="mini" id="csRun">Search</button><div id="csOut" style="margin-top:8px"></div>`;
    const show = () => {
      const r = AN.cs;
      if (!r.hits.length) { $('csOut').innerHTML = note(`Nothing found in ${r.tested} distinct rows (${r.ms} ms). Possible reasons: not enough different packets, a bit error in one of them, a different alignment or bit order (try “LSB first” or “invert”), or an algorithm not in the list.`); return; }
      $('csOut').innerHTML = `<table><tr><th>algorithm</th><th>data</th><th>checksum at</th><th>holds in</th></tr>${r.hits.map(x => `<tr><td>${esc(x.name)}</td><td class="mono">bits ${x.shift + x.start * 8}–${x.shift + x.cpos * 8 - 1} (${x.dataBytes} bytes)</td><td class="mono">${x.nibble ? 'last nibble' : `bits ${x.shift + x.cpos * 8}–${x.shift + x.cpos * 8 + x.width * 8 - 1}`}</td><td>${x.ok}/${x.n}</td></tr>`).join('')}</table>
        ${note(`${r.tested} distinct rows tested in ${r.ms} ms. Bit positions are counted from the start of the tested section. A hit that holds in every packet with several different values is very unlikely to be chance.`)}`;
    };
    $('csRun').onclick = () => { $('csOut').innerHTML = note('Searching…'); setTimeout(() => { const t0 = performance.now(); AN.cs = AC.findChecksums(msgs, 25); AN.cs.ms = Math.round(performance.now() - t0); show(); }, 20); };
    if (AN.cs) show();
  }

  // ---- tab: rules
  function newDraft(pattern, M, maxErr, at) {
    const act = M.lines.filter(L => L.active);
    // fixed position: where the pattern sits in every row (if it is the same everywhere)
    if (at === undefined) {
      const ps = [...new Set(act.map(L => AC.findApprox(L.r.bits, pattern, maxErr || 0)).filter(x => x >= 0))];
      at = ps.length === 1 ? ps[0] : -1;
    }
    const lens = [...new Set(act.map(L => L.r.bits.length))];
    const len = lens.length ? Math.max(...lens) : 0, lenTol = lens.length ? len - Math.min(...lens) : 0;
    const unit = Math.round(AC.med(act.map(L => AC.autoUnit(L.e)))) || 0;
    const nm = M.devs.length ? devLabel(M.devs[0]) : 'Device';
    AN.draft = { name: 'Signature: ' + nm.replace(/^Signature: /, ''), pattern, maxErr: maxErr || 0, useUnit: !!unit, unit, opt: { ...AN.opt }, test: null,
      at, useAt: at >= 0, atV: Math.max(0, at), len, lenTol, useLen: lens.length > 0 && lenTol <= 4 };
    AN.tab = 'rules'; anBody();
  }
  function draftRule(D) {
    return { id: D.id || Date.now().toString(36), name: D.name, on: true, pattern: D.pattern, maxErr: D.maxErr, useUnit: D.useUnit, unit: D.unit, opt: D.opt,
      at: D.useAt ? D.atV : -1, len: D.useLen ? D.len : 0, lenTol: D.useLen ? D.lenTol : 0 };
  }
  function testRule(r) {
    const tot = new Map(); let n = 0, cand = 0;
    for (const e of log) {
      if (!e.unknown) continue; cand++;
      if (!ruleMatches(r, e)) continue; n++;
      const k = e.key || '?'; tot.set(k, (tot.get(k) || 0) + 1);
    }
    return { n, cand, by: [...tot.entries()].sort((a, b) => b[1] - a[1]) };
  }
  function tabRules(M, body) {
    let h = note('A rule says: “every unknown packet that contains this bit pattern (decoded this way) is the same device”. Matching packets are grouped on one card named after the rule, whatever their length or the rest of their bits. Rules are checked first, in this order, and are saved in this browser.');
    const D = AN.draft;
    if (D) {
      h += `<div class="draft"><div class="tb"><label>name <input type="text" id="dName" value="${esc(D.name)}"></label>
        <label title="Allowed wrong bits (for noisy reception or a few changing bits)">tolerance <input type="number" id="dErr" min="0" value="${D.maxErr}"> bits</label>
        <label title="Pattern must start at this bit of the row (counted from 0), or may be anywhere"><input type="checkbox" id="dAtOn" ${D.useAt ? 'checked' : ''}> at bit <input type="number" id="dAt" min="0" value="${D.atV}" style="width:56px"></label>
        <label title="Only rows of this length match (± tolerance) — useful when only a few bits are fixed"><input type="checkbox" id="dLenOn" ${D.useLen ? 'checked' : ''}> row length <input type="number" id="dLen" min="1" value="${D.len || ''}" style="width:56px"> ± <input type="number" id="dLenTol" min="0" value="${D.lenTol || 0}" style="width:46px"></label>
        <label title="Only match packets whose bit unit is within ±30% of ${D.unit} µs — avoids matching a different protocol by chance"><input type="checkbox" id="dUnit" ${D.useUnit ? 'checked' : ''}> similar timing (${D.unit} µs ±30%)</label></div>
        <div class="note">pattern (bits, or hex as 0x…) · decoded as <b>${esc(optText(D.opt))}</b></div>
        <textarea id="dPat">${D.pattern}</textarea>
        <div class="tb" style="margin-top:6px"><button class="mini" id="dTest">Test on the log</button><button class="mini primary" id="dSave">Save rule</button><button class="mini" id="dCancel">Cancel</button>
        <span class="note">${AC.lowComplexity(D.pattern) && !D.useAt ? '<span class="warn">This pattern is only filler (1010… / 0000…): it will match many unrelated devices.</span>' : D.pattern.length < 12 && !(D.useAt && D.useLen) ? '<span class="warn">Short patterns match by chance anywhere in a row. Tie it to a bit position and a row length (above), or use 16+ bits.</span>' : D.pattern.length < 12 ? '<span class="note">Short pattern, but tied to a position and row length — check with Test that it doesn\'t catch other devices.</span>' : ''}</span></div>
        <div id="dRes">${D.test ? testHtml(D.test) : ''}</div></div>`;
    }
    if (!rules.length) h += note('No rules yet. Create one from a common section, a “Same device?” pair, or a selection in the Bits tab.');
    rules.forEach((r, i) => {
      const cnt = log.filter(e => e.unknown && e.key === devKey({ model: r.name, id: 'rule', sim: e.sim })).length;
      h += `<div class="rule"><label class="chk"><input type="checkbox" data-on="${i}" ${r.on ? 'checked' : ''}> on</label><b>${esc(r.name)}</b>
        <span class="note" style="margin:0">${r.pattern.length} bits ${ruleWhere(r)} · tolerance ${r.maxErr} · ${esc(optText(r.opt))}${r.useUnit ? ` · unit ${r.unit} µs ±30%` : ''} · ${cnt} packets in the log</span>
        <span style="margin-left:auto;display:flex;gap:6px"><button class="mini" data-up="${i}" ${i ? '' : 'disabled'}>↑</button><button class="mini" data-edit="${i}">Edit</button><button class="mini" data-show="${i}">Compare its card</button><button class="mini" data-del="${i}">Delete</button></span>
        <div class="pat">${r.pattern}</div></div>`;
    });
    body.innerHTML = h;
    const readD = () => { D.name = $('dName').value.trim() || 'Signature'; D.maxErr = Math.max(0, +$('dErr').value || 0); D.useUnit = $('dUnit').checked;
      D.useAt = $('dAtOn').checked; D.atV = Math.max(0, +$('dAt').value || 0); D.useLen = $('dLenOn').checked && +$('dLen').value > 0; D.len = +$('dLen').value || 0; D.lenTol = Math.max(0, +$('dLenTol').value || 0); const p = parsePat($('dPat').value); if (p) D.pattern = p; return !!p; };
    if (D) {
      $('dTest').onclick = () => { if (!readD()) { $('dRes').innerHTML = note('<span class="badc">The pattern must be 0/1 bits, or hex starting with 0x.</span>'); return; } D.test = testRule(draftRule(D)); $('dRes').innerHTML = testHtml(D.test); };
      $('dSave').onclick = () => {
        if (!readD()) return;
        const r = draftRule(D);
        const i = rules.findIndex(x => x.id === r.id); if (i >= 0) rules[i] = r; else rules.push(r);
        saveRules(); AN.draft = null; applyRules(r);
      };
      $('dCancel').onclick = () => { AN.draft = null; anBody(); };
    }
    body.onclick = e => {
      const b = e.target.closest('button'); if (!b || b.closest('.draft')) return;
      if (b.dataset.del !== undefined) { if (b.dataset.sure) { rules.splice(+b.dataset.del, 1); saveRules(); applyRules(); } else { b.dataset.sure = 1; b.textContent = 'Really delete?'; } }
      else if (b.dataset.up !== undefined) { const i = +b.dataset.up; [rules[i - 1], rules[i]] = [rules[i], rules[i - 1]]; saveRules(); applyRules(); }
      else if (b.dataset.edit !== undefined) { const r = rules[+b.dataset.edit]; AN.draft = { ...r, test: null, useAt: r.at >= 0, atV: Math.max(0, r.at || 0), useLen: !!r.len, len: r.len || 0, lenTol: r.lenTol || 0 }; anBody(); }
      else if (b.dataset.show !== undefined) { const r = rules[+b.dataset.show]; for (const d of devices.values()) if (d.model === r.name && d.id === 'rule') toggleCmp(d.key, true); AN.tab = 'same'; anBody(); }
    };
    body.onchange = e => { const c = e.target.closest('[data-on]'); if (c) { rules[+c.dataset.on].on = c.checked; saveRules(); applyRules(); } };
  }
  function testHtml(t) {
    if (!t.n) return note(`<span class="warn">Matches none of the ${t.cand} unknown packets in the log.</span> Check the decoding and tolerance.`);
    return note(`Matches <b>${t.n}</b> of ${t.cand} unknown packets in the log, currently on these cards:`) +
      '<table>' + t.by.slice(0, 15).map(([k, n]) => { const d = devices.get(k); return `<tr><td>${n}×</td><td>${d ? esc(devLabel(d)) : k.startsWith('#') ? 'no card yet (log only)' : esc(k.split('|')[0])}</td></tr>`; }).join('') + '</table>';
  }
  // regroup everything; keep the comparison pointing at the cards that now exist
  function applyRules(newRule) {
    const before = [...cmpSel];
    rebuildDevices();
    for (const k of before) if (!devices.has(k)) cmpSel.delete(k);
    if (newRule) for (const d of devices.values()) if (d.id === 'rule' && d.model === newRule.name) cmpSel.add(d.key);
    store.set('cmpSel', [...cmpSel]); updCmpBar();
    AN.common = null; AN.cs = null; anBody();
  }
  $('anaBtn').onclick = () => anOpen();
  updCmpBar();
