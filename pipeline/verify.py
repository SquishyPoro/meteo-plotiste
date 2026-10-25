#!/usr/bin/env python3
"""Archív vlastných predpovedí, zmeny predpovede od včera a overenie včerajšej predpovede.

Každých ~6 h uloží „čo ukazoval dashboard“ (AI predpoveď / priemer modelov) do data/fcarchive/,
potom vypočíta:
  data/fc-changes.json  – ako sa zmenila predpoveď na najbližšie dni oproti stavu spred ~24 h
  data/verify.json      – ako sa trafila predpoveď na včerajšok (vydaná predvčerom ráno) + história chýb
Iba štandardná knižnica Pythonu.
"""
import csv
import datetime as dt
import json
import os
import time
import urllib.request
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
ARCH = os.path.join(DATA, 'fcarchive')
TZ = ZoneInfo('Europe/Prague')
HK = (50.236, 15.790)
MODELS = ['ecmwf_ifs025', 'icon_seamless', 'gfs_seamless', 'meteofrance_seamless', 'ukmo_seamless', 'gem_seamless']
OBS_FILES = ['hourly-0-203-0-11651.csv', 'hourly-0-203-0-11649.csv']


def log(*a):
    print(*a, flush=True)


def get_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'meteo-plotiste'})
    for i in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception as e:
            err = e
            time.sleep(3 * (i + 1))
    raise RuntimeError(f'{url}: {err}')


def mean(v):
    v = [x for x in v if x is not None]
    return sum(v) / len(v) if v else None


def snapshot(now):
    """Aktuálna predpoveď v tvare, aký zobrazuje dashboard (AI ak je skill.json, inak priemer modelov)."""
    j = get_json('https://api.open-meteo.com/v1/forecast?'
                 f'latitude={HK[0]}&longitude={HK[1]}&timeformat=unixtime&forecast_days=8'
                 f'&hourly=temperature_2m,precipitation,wind_gusts_10m&models={",".join(MODELS)}')
    h = j['hourly']
    skill = None
    try:
        with open(os.path.join(DATA, 'skill.json')) as f:
            skill = json.load(f)
    except Exception:
        pass
    out = {'issued': int(now), 'time': [], 't': [], 'p': [], 'g': []}
    for i, t in enumerate(h['time']):
        if t < now - 3600:
            continue
        lead = str(min(6, max(0, int((t - now) // 86400))))
        vals = {k: {m: h.get(f'{v}_{m}', [None] * len(h['time']))[i] for m in MODELS}
                for k, v in (('t', 'temperature_2m'), ('p', 'precipitation'), ('g', 'wind_gusts_10m'))}
        row = {}
        for k in ('t', 'p', 'g'):
            W = (skill or {}).get('weights', {}).get(k, {}).get(lead)
            if W:
                s = sw = 0.0
                for m, w in W.items():
                    v = vals[k].get(m)
                    if v is None:
                        continue
                    e = skill['models'].get(m, {}).get(k, {}).get(lead, {})
                    if k == 't' and e.get('hour_bias'):
                        v -= e['hour_bias'][(t // 3600) % 24]
                    elif k == 'g' and e:
                        v -= e['bias']
                    s += v * w
                    sw += w
                row[k] = s / sw if sw else mean(vals[k].values())
            else:
                row[k] = mean(vals[k].values())
            if row[k] is not None and k != 't':
                row[k] = max(0.0, row[k])
        out['time'].append(t)
        for k in ('t', 'p', 'g'):
            out[k].append(None if row[k] is None else round(row[k], 1))
    return out


def daily(snap):
    """{dátum: {'tmax','tmin','p','g','start'}} v miestnom čase."""
    days = {}
    for i, t in enumerate(snap['time']):
        d = dt.datetime.fromtimestamp(t, TZ).date().isoformat()
        dp = dt.datetime.fromtimestamp(t - 1, TZ)  # zrážky = úhrn za predchádzajúcu hodinu
        e = days.setdefault(d, {'t': [], 'g': [], 'n': 0})
        if snap['t'][i] is not None:
            e['t'].append(snap['t'][i])
        if snap['g'][i] is not None:
            e['g'].append(snap['g'][i])
        pe = days.setdefault(dp.date().isoformat(), {'t': [], 'g': [], 'n': 0})
        pe.setdefault('p', 0.0)
        pe['p'] += snap['p'][i] or 0
        pe['n'] += 1
        if (snap['p'][i] or 0) >= 0.2 and 'start' not in pe:
            pe['start'] = dp.hour
    out = {}
    for d, e in days.items():
        if len(e['t']) >= 20 and e['n'] >= 20:
            out[d] = {'tmax': round(max(e['t']), 1), 'tmin': round(min(e['t']), 1), 'p': round(e.get('p', 0), 1),
                      'g': round(max(e['g']), 0) if e['g'] else None, 'start': e.get('start')}
    return out


def load_obs():
    rows = {}
    for name in reversed(OBS_FILES):  # primárna stanica prepíše záložnú
        path = os.path.join(DATA, 'obs', name)
        if not os.path.exists(path):
            continue
        with open(path, newline='') as f:
            for r in csv.DictReader(f):
                t = int(r['time'])
                cur = rows.setdefault(t, {})
                for k in ('t', 'precip', 'gust'):
                    if r.get(k) not in ('', None):
                        cur[k] = float(r[k])
    return rows


def obs_day(obs, day):
    start = dt.datetime.combine(day, dt.time(), TZ)
    ts = [int((start + dt.timedelta(hours=h)).timestamp()) for h in range(1, 25)]
    temps = [obs[t]['t'] for t in ts if t in obs and 't' in obs[t]]
    rain = [(h, obs[t]['precip']) for h, t in enumerate(ts) if t in obs and 'precip' in obs[t]]
    if len(temps) < 20 or len(rain) < 20:
        return None
    first = next((h for h, p in rain if p >= 0.2), None)
    gust = [obs[t]['gust'] for t in ts if t in obs and 'gust' in obs[t]]
    return {'tmax': round(max(temps), 1), 'tmin': round(min(temps), 1), 'p': round(sum(p for _, p in rain), 1),
            'g': round(max(gust)) if gust else None, 'start': first}


def bootstrap(obs, days=14):
    """Kým nie je vlastný archív, overenie z Open-Meteo Previous Runs (predpoveď spred 1 dňa, priemer modelov)."""
    end = dt.datetime.now(TZ).date() - dt.timedelta(days=1)
    start = end - dt.timedelta(days=days - 1)
    vars_ = ','.join(f'{v}_previous_day1' for v in ('temperature_2m', 'precipitation', 'wind_gusts_10m'))
    series = {}
    for m in MODELS:
        try:
            j = get_json('https://previous-runs-api.open-meteo.com/v1/forecast?'
                         f'latitude={HK[0]}&longitude={HK[1]}&timeformat=unixtime&models={m}'
                         f'&start_date={start - dt.timedelta(days=1)}&end_date={end + dt.timedelta(days=1)}&hourly={vars_}')
            series[m] = j['hourly']
        except Exception as e:
            log('bootstrap', m, e)
    if not series:
        return []
    times = next(iter(series.values()))['time']
    snap = {'time': times, 't': [], 'p': [], 'g': []}
    for i in range(len(times)):
        for k, v in (('t', 'temperature_2m'), ('p', 'precipitation'), ('g', 'wind_gusts_10m')):
            x = mean([series[m].get(f'{v}_previous_day1', [None] * len(times))[i] for m in series])
            snap[k].append(None if x is None else round(x, 1))
    fc_days = daily(snap)
    out = []
    d = start
    while d <= end:
        o, fc = obs_day(obs, d), fc_days.get(d.isoformat())
        if o and fc:
            out.append({'date': d.isoformat(), 'issued': None, 'src': 'previous_runs', 'fc': fc, 'obs': o,
                        'dtmax': round(fc['tmax'] - o['tmax'], 1), 'dtmin': round(fc['tmin'] - o['tmin'], 1), 'dp': round(fc['p'] - o['p'], 1)})
        d += dt.timedelta(days=1)
    log(f'bootstrap overenia: {len(out)} dní')
    return out


def main():
    os.makedirs(ARCH, exist_ok=True)
    now = time.time()
    files = sorted(os.listdir(ARCH))
    issued = [int(dt.datetime.strptime(n[:10], '%Y%m%d%H').replace(tzinfo=dt.timezone.utc).timestamp()) for n in files]
    if not issued or now - issued[-1] > 5.5 * 3600:
        snap = snapshot(now)
        name = dt.datetime.fromtimestamp(now, dt.timezone.utc).strftime('%Y%m%d%H') + '.json'
        with open(os.path.join(ARCH, name), 'w') as f:
            json.dump(snap, f, separators=(',', ':'))
        log(f'uložený snapshot {name}')
        files.append(name)
        issued.append(int(now))
    for n, t in zip(list(files), list(issued)):  # archív 16 dní
        if now - t > 16 * 86400:
            os.remove(os.path.join(ARCH, n))
    load = lambda n: json.load(open(os.path.join(ARCH, n)))
    pairs = sorted(zip(issued, files))
    latest = load(pairs[-1][1])
    # --- zmeny oproti predpovedi spred ~24 h
    prev = min(pairs, key=lambda p: abs(p[0] - (latest['issued'] - 86400)))
    if abs(prev[0] - (latest['issued'] - 86400)) < 8 * 3600 and prev[1] != pairs[-1][1]:
        a, b = daily(latest), daily(load(prev[1]))
        days = [{'date': d, **{k: [a[d][k], b[d][k]] for k in ('tmax', 'tmin', 'p', 'g')}} for d in sorted(a) if d in b]
        changes = {'issued': latest['issued'], 'prev': prev[0], 'days': days}
    else:
        changes = {'issued': latest['issued'], 'prev': None, 'days': []}
    with open(os.path.join(DATA, 'fc-changes.json'), 'w') as f:
        json.dump(changes, f, separators=(',', ':'))
    # --- overenie: predpoveď na včerajšok vydaná predvčerom okolo 6:00
    obs = load_obs()
    path = os.path.join(DATA, 'verify.json')
    ver = {'history': []}
    if os.path.exists(path):
        with open(path) as f:
            ver = json.load(f)
    if not ver['history']:
        ver['history'] = bootstrap(obs)
    done = {h['date'] for h in ver['history'] if h.get('src') != 'previous_runs'}
    today = dt.datetime.now(TZ).date()
    for back in range(1, 8):
        day = today - dt.timedelta(days=back)
        if day.isoformat() in done:
            continue
        target = dt.datetime.combine(day - dt.timedelta(days=1), dt.time(6), TZ).timestamp()
        cand = [p for p in pairs if abs(p[0] - target) < 7 * 3600]
        o = obs_day(obs, day)
        if not cand or not o:
            continue
        p = min(cand, key=lambda x: abs(x[0] - target))
        fc = daily(load(p[1])).get(day.isoformat())
        if not fc:
            continue
        rec = {'date': day.isoformat(), 'issued': p[0], 'fc': fc, 'obs': o,
               'dtmax': round(fc['tmax'] - o['tmax'], 1), 'dtmin': round(fc['tmin'] - o['tmin'], 1), 'dp': round(fc['p'] - o['p'], 1)}
        ver['history'].append(rec)
        log(f'overenie {day}: predpoveď {fc} vs. merania {o}')
    best = {}
    for h in ver['history']:  # na deň jeden záznam, vlastný archív má prednosť pred previous runs
        if h['date'] not in best or best[h['date']].get('src') == 'previous_runs':
            best[h['date']] = h
    ver['history'] = sorted(best.values(), key=lambda h: h['date'])[-60:]
    ver['updated'] = int(now)
    with open(path, 'w') as f:
        json.dump(ver, f, separators=(',', ':'))


if __name__ == '__main__':
    main()
