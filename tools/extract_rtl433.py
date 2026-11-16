#!/usr/bin/env python3
"""Build a device fingerprint database (JSON) from an rtl_433 source checkout.

usage: extract_rtl433.py <rtl_433 dir> <out.json>

Reads the r_device structs in src/devices/*.c (timing, modulation, name) plus the
row-length checks in each decoder, and the flex decoders in conf/*.conf.
"""
import json, re, sys, os, glob

root, out_path = sys.argv[1], sys.argv[2]

def num(expr, consts):
    expr = expr.strip().rstrip(',')
    expr = re.sub(r'\b([A-Z_][A-Z0-9_]*)\b', lambda m: str(consts.get(m.group(1), m.group(0))), expr)
    expr = re.sub(r'(\d+(?:\.\d+)?)[fF]\b', r'\1', expr)
    if not re.fullmatch(r'[\d\s.+\-*/()]+', expr):
        return None
    try:
        v = eval(expr, {'__builtins__': {}})
        return round(float(v), 1)
    except Exception:
        return None

MOD_MAP = {  # rtl_433 name -> (carrier, coding)
    'OOK_PULSE_PPM': ('OOK', 'PPM'), 'OOK_PULSE_PWM': ('OOK', 'PWM'),
    'OOK_PULSE_PCM': ('OOK', 'PCM'), 'OOK_PULSE_RZ': ('OOK', 'RZ'),
    'OOK_PULSE_MANCHESTER_ZEROBIT': ('OOK', 'MC'), 'OOK_PULSE_DMC': ('OOK', 'DMC'),
    'OOK_PULSE_PIWM_RAW': ('OOK', 'PIWM'), 'OOK_PULSE_PIWM_DC': ('OOK', 'PIWM'),
    'OOK_PULSE_PWM_OSV1': ('OOK', 'OSV1'), 'OOK_PULSE_NRZS': ('OOK', 'NRZS'),
    'OOK_PULSE_RZI': ('OOK', 'RZ'),
    'FSK_PULSE_PCM': ('FSK', 'PCM'), 'FSK_PULSE_PWM': ('FSK', 'PWM'),
    'FSK_PULSE_MANCHESTER_ZEROBIT': ('FSK', 'MC'), 'LORA': ('LORA', 'LORA'),
    # flex decoder short names
    'OOK_PPM': ('OOK', 'PPM'), 'OOK_PWM': ('OOK', 'PWM'), 'OOK_PCM': ('OOK', 'PCM'), 'OOK_RZ': ('OOK', 'RZ'),
    'OOK_MC_ZEROBIT': ('OOK', 'MC'), 'OOK_MC': ('OOK', 'MC'), 'OOK_DMC': ('OOK', 'DMC'), 'OOK_PIWM_RAW': ('OOK', 'PIWM'),
    'OOK_PIWM_DC': ('OOK', 'PIWM'), 'OOK_NRZS': ('OOK', 'NRZS'),
    'FSK_PCM': ('FSK', 'PCM'), 'FSK_PWM': ('FSK', 'PWM'), 'FSK_MC_ZEROBIT': ('FSK', 'MC'), 'FSK_MC': ('FSK', 'MC'),
}

devices = []

# ---------------------------------------------------------------- C decoders
for path in sorted(glob.glob(os.path.join(root, 'src/devices/*.c'))):
    src = open(path, encoding='utf-8', errors='replace').read()
    nocomment = re.sub(r'//[^\n]*', '', src)
    consts = {}
    for m in re.finditer(r'#define\s+([A-Z_][A-Z0-9_]*)\s+\(?\s*([\d.]+)\s*\)?\s*$', nocomment, re.M):
        consts[m.group(1)] = m.group(2)
    # Row lengths the decoder checks for: bits_per_row[..] == N, != N, < N, find_repeated_row(.., .., N)
    bits = set()
    for m in re.finditer(r'bits_per_row\[[^\]]*\]\s*(?:!=|==)\s*(\d+)', nocomment):
        bits.add(int(m.group(1)))
    for m in re.finditer(r'find_repeated_(?:row|prefix)\s*\([^,]+,\s*\d+\s*,\s*(\d+)\s*\)', nocomment):
        bits.add(int(m.group(1)))
    minbits = [int(m.group(1)) for m in re.finditer(r'bits_per_row\[[^\]]*\]\s*<\s*(\d+)', nocomment)]
    bits = sorted(b for b in bits if 4 <= b <= 2000)
    fname = os.path.basename(path)
    for m in re.finditer(r'r_device\s+(?:const\s+)?(\w+)\s*=\s*\{(.*?)\n\};', nocomment, re.S):
        var, body = m.group(1), m.group(2)
        f = {}
        name_m = re.search(r'\.name\s*=\s*((?:"(?:[^"\\]|\\.)*"\s*)+)', body)
        if not name_m:
            continue
        f['name'] = ''.join(re.findall(r'"((?:[^"\\]|\\.)*)"', name_m.group(1)))
        for key in ['modulation', 'short_width', 'long_width', 'sync_width', 'gap_limit', 'reset_limit', 'tolerance', 'disabled']:
            km = re.search(r'\.' + key + r'\s*=\s*([^,\n]+)', body)
            if km:
                f[key] = km.group(1).strip()
        mod = f.get('modulation', '')
        if mod not in MOD_MAP:
            continue
        carrier, coding = MOD_MAP[mod]
        d = {
            'name': f['name'], 'src': 'rtl_433/' + fname, 'carrier': carrier, 'coding': coding,
            'short': num(f.get('short_width', '0'), consts), 'long': num(f.get('long_width', '0'), consts),
        }
        for k_in, k_out in [('sync_width', 'sync'), ('gap_limit', 'gap'), ('reset_limit', 'reset'), ('tolerance', 'tol')]:
            if k_in in f:
                v = num(f[k_in], consts)
                if v:
                    d[k_out] = v
        if bits:
            d['bits'] = bits
        if f.get('disabled', '0').strip() not in ('0', ''):
            d['disabled'] = True
        if not d['short']:
            continue
        devices.append(d)

# ---------------------------------------------------------------- flex decoders (conf/*.conf)
KEYS = {'n': 'name', 'name': 'name', 'm': 'modulation', 'modulation': 'modulation', 's': 'short', 'short': 'short',
        'l': 'long', 'long': 'long', 'y': 'sync', 'sync': 'sync', 'g': 'gap', 'gap': 'gap', 'r': 'reset', 'reset': 'reset',
        't': 'tol', 'tolerance': 'tol'}
for path in sorted(glob.glob(os.path.join(root, 'conf/*.conf'))):
    text = open(path, encoding='utf-8', errors='replace').read()
    text = '\n'.join(l for l in text.splitlines() if not l.strip().startswith('#'))
    blocks = re.findall(r'^\s*decoder\s*\{(.*?)\}', text, re.S | re.M) + re.findall(r'^\s*decoder\s+([^{\n][^\n]*)$', text, re.M)
    for b in blocks:
        parts = [p.strip() for p in re.split(r',\s*(?![^\[]*\])', b.replace('\n', ',')) if p.strip()]
        d = {'src': 'rtl_433/conf/' + os.path.basename(path)}
        bits = []
        gets = []
        for p in parts:
            kv = re.match(r'(\w+)\s*(>=|<=|=|>|<)?\s*(.*)', p)
            if not kv:
                continue
            k, op, v = kv.group(1), kv.group(2), kv.group(3).strip()
            if k in KEYS:
                if KEYS[k] in ('name', 'modulation'):
                    d[KEYS[k]] = v
                else:
                    x = num(v, {})
                    if x:
                        d[KEYS[k]] = x
            elif k in ('bits', 'b'):
                x = num(v, {})
                if x:
                    if op in ('>=', '>'):
                        d['minBits'] = int(x)
                    elif op in ('<=', '<'):
                        d['maxBits'] = int(x)
                    else:
                        bits.append(int(x))
            elif k == 'get':
                gm = re.match(r'@(\d+):\{(\d+)\}:(\w+)', v)
                if gm:
                    gets.append(gm.group(3))
            elif k == 'invert':
                d['invert'] = True
        mod = d.pop('modulation', None)
        if not mod or mod not in MOD_MAP or 'short' not in d:
            continue
        d['carrier'], d['coding'] = MOD_MAP[mod]
        d.setdefault('long', d['short'])
        if bits:
            d['bits'] = sorted(set(bits))
        if gets:
            d['fields'] = gets
        d.setdefault('name', os.path.basename(path)[:-5])
        devices.append(d)

meta = {'source': 'https://github.com/merbanan/rtl_433', 'license': 'GPL-2.0-or-later (data extracted from rtl_433 sources)'}
try:
    import subprocess
    meta['commit'] = subprocess.check_output(['git', '-C', root, 'log', '-1', '--format=%h %cs'], text=True).strip()
except Exception:
    pass
json.dump({'meta': meta, 'devices': devices}, open(out_path, 'w'), ensure_ascii=False, separators=(',', ':'))
from collections import Counter
print(len(devices), 'entries', Counter(d['coding'] + '/' + d['carrier'] for d in devices).most_common())
print('with bit lengths:', sum(1 for d in devices if 'bits' in d))
