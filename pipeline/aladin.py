#!/usr/bin/env python3
"""Model ALADIN ČHMÚ (CZ 1 km) pre Plotiště nad Labem.

Stiahne najnovší beh z otvorených dát ČHMÚ (GRIB2), vytiahne hodnoty pre bod Plotiště
a uloží ich do data/aladin.json (pre dashboard) a data/aladin/<beh>.json (archív na neskoršie vyhodnotenie).
Spúšťa GitHub Actions 4× denne.
"""
import bz2
import datetime as dt
import json
import os
import re
import tempfile
import time
import urllib.request

import numpy as np
import pygrib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'aladin.json')
ARCHIVE = os.path.join(ROOT, 'data', 'aladin')
BASE = 'https://opendata.chmi.cz/meteorology/weather/nwp_aladin/CZ_1km/'
HK = (50.236, 15.790)
# parameter -> (súbor, spracovanie)
FIELDS = {
    't': 'CLSTEMPERATURE',       # teplota 2 m [K]
    'g': 'CLSRAFAL_MOD_XFU',     # nárazy vetra [m/s]
    'p': 'SURFPREC_TOTAL',       # zrážky [kg/m²], kumulované
    'cloud': 'SURFNEBUL_TOTALE', # oblačnosť [0–1]
    'flash': 'SURFDIAG_FLASH',   # predpovedaná hustota bleskov
}


def log(*a):
    print(*a, flush=True)


def get(url, timeout=300):
    req = urllib.request.Request(url, headers={'User-Agent': 'meteo-plotiste'})
    for i in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:
            err = e
            time.sleep(5 * (i + 1))
    raise RuntimeError(f'{url}: {err}')


def latest_run():
    """Najnovší kompletný beh: (adresár, dátum+hodina) s dostupnými všetkými súbormi."""
    best = None
    for d in ('00', '06', '12', '18'):
        names = re.findall(r'href="(ALADCZ1K4opendata_(\d{10})_[^"]+\.grb\.bz2)"', get(BASE + d + '/', 60).decode())
        runs = {}
        for name, run in names:
            runs.setdefault(run, set()).add(name)
        for run, files in runs.items():
            if all(any(f'_{run}_{v}.grb' in n for n in files) for v in FIELDS.values()):
                if best is None or run > best[1]:
                    best = (d, run)
    return best


def point_series(path, kind):
    g = pygrib.open(path)
    msgs = sorted(g, key=lambda m: m.forecastTime)
    lats, lons = msgs[0].latlons()
    d = (lats - HK[0]) ** 2 + ((lons - HK[1]) * np.cos(np.radians(HK[0]))) ** 2
    j, i = np.unravel_index(d.argmin(), d.shape)
    steps, vals = [], []
    for m in msgs:
        v = m.values
        if kind == 'p':      # zrážky: priemer 3×3 km (menej šumu)
            x = float(np.mean(v[j - 1:j + 2, i - 1:i + 2]))
        elif kind == 'g':    # nárazy: maximum 3×3 km
            x = float(np.max(v[j - 1:j + 2, i - 1:i + 2]))
        else:
            x = float(v[j, i])
        steps.append(int(m.forecastTime))
        vals.append(x)
    g.close()
    return steps, vals


def main():
    found = latest_run()
    if not found:
        raise RuntimeError('nenašiel sa kompletný beh ALADIN')
    d, run = found
    base_time = dt.datetime.strptime(run, '%Y%m%d%H').replace(tzinfo=dt.timezone.utc)
    if os.path.exists(OUT):
        with open(OUT) as f:
            if json.load(f).get('run') == int(base_time.timestamp()):
                log(f'beh {run} už je spracovaný')
                return
    log(f'spracúvam beh {run}')
    series = {}
    with tempfile.TemporaryDirectory() as tmp:
        for key, name in FIELDS.items():
            url = f'{BASE}{d}/ALADCZ1K4opendata_{run}_{name}.grb.bz2'
            path = os.path.join(tmp, name + '.grb')
            with open(path, 'wb') as f:
                f.write(bz2.decompress(get(url)))
            series[key] = point_series(path, key)
            os.remove(path)
            log(f'  {name}: {len(series[key][0])} krokov')
    steps = series['t'][0]
    pick = lambda key: dict(zip(*series[key]))
    t, g, p, c, fl = pick('t'), pick('g'), pick('p'), pick('cloud'), pick('flash')
    # kumulované zrážky -> hodinové úhrny (ak hodnoty klesnú, berieme ich ako hodinové)
    ps = [p.get(s) for s in steps]
    cumulative = all(b is None or a is None or b >= a - 1e-6 for a, b in zip(ps, ps[1:]))
    hourly_p = [None if v is None else round(max(0.0, (v - (ps[k - 1] or 0)) if cumulative and k else v), 2) for k, v in enumerate(ps)]
    if cumulative:
        hourly_p[0] = 0.0
    cl = [c.get(s) for s in steps]
    cscale = 100 if max(x for x in cl if x is not None) <= 1.5 else 1
    out = {
        'run': int(base_time.timestamp()),
        'model': 'ALADIN CZ 1 km (ČHMÚ)',
        'time': [int(base_time.timestamp()) + s * 3600 for s in steps],
        't': [None if t.get(s) is None else round(t[s] - 273.15, 1) for s in steps],
        'g': [None if g.get(s) is None else round(g[s] * 3.6, 1) for s in steps],
        'p': hourly_p,
        'cloud': [None if x is None else round(x * cscale) for x in cl],
        'flash': [None if fl.get(s) is None else round(fl[s], 3) for s in steps],
    }
    os.makedirs(ARCHIVE, exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    with open(os.path.join(ARCHIVE, f'{run}.json'), 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    log(f'uložené: {len(steps)} hodín, teplota {out["t"][0]}…{out["t"][-1]} °C, zrážky spolu {sum(x or 0 for x in hourly_p):.1f} mm')


if __name__ == '__main__':
    main()
