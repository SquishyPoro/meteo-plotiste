#!/usr/bin/env python3
"""Klimatológia Hradca Králové z dát ČHMÚ (stanica Nový Hradec Králové, 0-203-0-11649).

Výstup data/climate.json: normál 1991–2020, rekordy pre každý deň v roku, absolútne rekordy,
porovnanie posledných mesiacov s normálom a charakteristické dni v aktuálnom roku.
Historické CSV sa sťahujú raz za týždeň (menia sa zriedka), aktuálne mesiace denne.
"""
import csv
import datetime as dt
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'climate.json')
CACHE = os.path.join(ROOT, '.climate-cache')
WSI = '0-203-0-11649'
HIST = 'https://opendata.chmi.cz/meteorology/climate/historical_csv/data/daily/'
RECENT = 'https://opendata.chmi.cz/meteorology/climate/recent/data/daily/'
NOW = 'https://opendata.chmi.cz/meteorology/climate/now/data/'
ELEMENTS = {  # prvok: (priečinok, funkcia v recent JSON)
    'TMA': ('temperature', '20:00'), 'TMI': ('temperature', '20:00'), 'T': ('temperature', 'AVG'),
    'SRA': ('precipitation', '06:00'), 'SCE': ('snow', '06:00'), 'Fmax': ('wind', '00:00'),
}
NORMAL = (1991, 2020)
KEEP = os.path.join(ROOT, 'data', 'chmi-daily-11649.csv')  # priebežne uložené dni z recent/ (ČHMÚ drží len aktuálny mesiac)
ERA = {'TMA': 'temperature_2m_max', 'TMI': 'temperature_2m_min', 'T': 'temperature_2m_mean', 'SRA': 'precipitation_sum'}


def log(*a):
    print(*a, flush=True)


def get(url, timeout=180):
    for i in range(3):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'meteo-plotiste'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            err = e
        except Exception as e:
            err = e
        time.sleep(3 * (i + 1))
    raise RuntimeError(f'{url}: {err}')


def load_history():
    """{prvok: {date: hodnota}} z historických CSV (s lokálnou cache na týždeň)."""
    os.makedirs(CACHE, exist_ok=True)
    data = {}
    for el, (folder, _) in ELEMENTS.items():
        path = os.path.join(CACHE, f'{el}.csv')
        if not os.path.exists(path) or time.time() - os.path.getmtime(path) > 7 * 86400:
            raw = get(f'{HIST}{folder}/dly-{WSI}-{el}.csv')
            if raw:
                with open(path, 'wb') as f:
                    f.write(raw)
        vals = {}
        if os.path.exists(path):
            with open(path, newline='') as f:
                for r in csv.DictReader(f):
                    if r['VALUE'] in ('', None):
                        continue
                    vals[dt.date.fromisoformat(r['DT'][:10])] = float(r['VALUE'])
        data[el] = vals
        log(f'{el}: {len(vals)} dní z histórie, do {max(vals) if vals else "–"}')
    return data


def add_recent(data, today):
    """Doplní mesiace aktuálneho a minulého roka z recent/ (JSON po mesiacoch)."""
    want = {el: fn for el, (_, fn) in ELEMENTS.items()}
    last_hist = min(max(v) for v in data.values() if v) if any(data.values()) else dt.date(today.year - 1, 1, 1)
    m = dt.date(last_hist.year, last_hist.month, 1)
    while m <= today:
        j = get(f'{RECENT}dly-{WSI}-{m:%Y%m}.json')
        if j:
            for st, el, fn, ts, val, flag, q in json.loads(j)['data']['data']['values']:
                if el in want and fn == want[el] and val not in (None, ''):
                    data[el][dt.date.fromisoformat(ts[:10])] = float(val)
        m = (m.replace(day=28) + dt.timedelta(days=4)).replace(day=1)


def keep_recent(data):
    """Uloží dni novšie než história do data/chmi-daily-11649.csv a načíta skôr uložené."""
    hist_end = {el: max(v) if v else dt.date(1900, 1, 1) for el, v in data.items()}
    rows = {}
    if os.path.exists(KEEP):
        with open(KEEP, newline='') as f:
            for r in csv.DictReader(f):
                rows[(r['date'], r['element'])] = float(r['value'])
    for el, vals in data.items():
        for d, x in vals.items():
            if d > hist_end.get(el, d):
                rows[(d.isoformat(), el)] = x
    for (ds, el), x in rows.items():
        data.setdefault(el, {}).setdefault(dt.date.fromisoformat(ds), x)
    with open(KEEP, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['date', 'element', 'value'])
        for (ds, el) in sorted(rows):
            w.writerow([ds, el, rows[(ds, el)]])


def fill_gaps_era5(data, today):
    """Chýbajúce dni (medzi koncom histórie a uloženými dňami) doplní reanalýza ERA5. Vráti množinu odhadnutých dní."""
    have = set(data['TMA'])
    first_missing, d = None, dt.date(today.year - 1, 1, 1)
    while d < today - dt.timedelta(days=6):
        if d not in have:
            first_missing = d
            break
        d += dt.timedelta(days=1)
    if not first_missing:
        return set()
    end = today - dt.timedelta(days=6)
    url = ('https://archive-api.open-meteo.com/v1/archive?latitude=50.1776&longitude=15.8385&timezone=Europe%2FPrague'
           f'&start_date={first_missing}&end_date={end}&daily=' + ','.join(ERA.values()))
    j = json.loads(get(url))
    est = set()
    for i, ds in enumerate(j['daily']['time']):
        day = dt.date.fromisoformat(ds)
        if day in have:
            continue
        for el, var in ERA.items():
            v = j['daily'][var][i]
            if v is not None:
                data[el][day] = float(v)
        est.add(day)
    log(f'ERA5 doplnil {len(est)} dní ({first_missing} – {end})')
    return est


def r1(x):
    return None if x is None else round(x, 1)


def build(data, today, est=frozenset()):
    T, TMA, TMI, SRA, SCE, FMAX = (data[k] for k in ('T', 'TMA', 'TMI', 'SRA', 'SCE', 'Fmax'))
    y0, y1 = NORMAL
    # --- normál 1991–2020 po mesiacoch
    normals = []
    for mo in range(1, 13):
        def mean_of(src):
            v = [x for d, x in src.items() if y0 <= d.year <= y1 and d.month == mo]
            return sum(v) / len(v) if v else None
        sums = []
        for y in range(y0, y1 + 1):
            v = [x for d, x in SRA.items() if d.year == y and d.month == mo]
            if len(v) >= 25:
                sums.append(sum(v))
        normals.append({'t': r1(mean_of(T)), 'tmax': r1(mean_of(TMA)), 'tmin': r1(mean_of(TMI)),
                        'p': r1(sum(sums) / len(sums)) if sums else None})
    # --- denný normál (vyhladený ±7 dní) a rekordy pre každý deň v roku
    days = {}
    for src, key in ((TMA, 'tmax'), (TMI, 'tmin'), (SRA, 'p')):
        for d, x in src.items():
            days.setdefault(d.strftime('%m-%d'), {}).setdefault(key, []).append((x, d.year))
    by_day = {}
    ref = dt.date(2020, 1, 1)  # priestupný rok
    for k in range(366):
        dd = ref + dt.timedelta(days=k)
        key = dd.strftime('%m-%d')
        e = days.get(key, {})
        win = [(ref + dt.timedelta(days=(k + o) % 366)).strftime('%m-%d') for o in range(-7, 8)]
        def norm(var):
            v = [x for w in win for x, y in days.get(w, {}).get(var, []) if y0 <= y <= y1]
            return r1(sum(v) / len(v)) if v else None
        rec = {'nmax': norm('tmax'), 'nmin': norm('tmin')}
        if e.get('tmax'):
            x, y = max(e['tmax']); rec['hi'] = [r1(x), y]
        if e.get('tmin'):
            x, y = min(e['tmin']); rec['lo'] = [r1(x), y]
        if e.get('p'):
            x, y = max(e['p']); rec['p'] = [r1(x), y]
        by_day[key] = rec
    # --- absolútne rekordy
    def extreme(src, fn):
        if not src:
            return None
        d = fn(src, key=src.get)
        return [r1(src[d]), d.isoformat()]
    records = {'tmax': extreme(TMA, max), 'tmin': extreme(TMI, min), 'p': extreme(SRA, max),
               'snow': extreme(SCE, max), 'gust': extreme(FMAX, max)}
    # --- posledných 24 mesiacov vs. normál
    months = []
    m = dt.date(today.year - 2, today.month, 1)
    while m <= today:
        tv = [x for d, x in T.items() if d.year == m.year and d.month == m.month]
        pv = [x for d, x in SRA.items() if d.year == m.year and d.month == m.month]
        n = normals[m.month - 1]
        if tv:
            ne = sum(1 for d in T if d.year == m.year and d.month == m.month and d in est)
            months.append({'m': m.strftime('%Y-%m'), 'days': len(tv), 'est': ne, 't': r1(sum(tv) / len(tv)),
                           'ta': r1(sum(tv) / len(tv) - n['t']) if n['t'] is not None else None,
                           'p': r1(sum(pv)), 'pn': n['p']})
        m = (m.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
    # --- charakteristické dni: tento rok vs. normál (do dnešného dňa v roku)
    doy = today.timetuple().tm_yday
    def counts(y):
        mx = [x for d, x in TMA.items() if d.year == y and d.timetuple().tm_yday <= doy]
        mn = [x for d, x in TMI.items() if d.year == y and d.timetuple().tm_yday <= doy]
        return {'trop': sum(x >= 30 for x in mx), 'summer': sum(x >= 25 for x in mx),
                'frost': sum(x < 0 for x in mn), 'ice': sum(x < 0 for x in mx), 'n': len(mx)}
    cur = counts(today.year)
    cur['est'] = sum(1 for d in est if d.year == today.year)
    norm_years = [counts(y) for y in range(y0, y1 + 1)]
    norm_years = [c for c in norm_years if c['n'] > doy * 0.9]
    ncount = {k: r1(sum(c[k] for c in norm_years) / len(norm_years)) for k in ('trop', 'summer', 'frost', 'ice')} if norm_years else {}
    # --- posledných 60 dní
    last = []
    for k in range(60, 0, -1):
        d = today - dt.timedelta(days=k)
        last.append([d.isoformat(), r1(TMA.get(d)), r1(TMI.get(d)), r1(SRA.get(d))])
    first = {k: min(v).year for k, v in (('t', T), ('p', SRA)) if v}
    return {'station': 'Hradec Králové – Nový Hradec Králové (ČHMÚ)', 'since': first, 'normal': f'{y0}–{y1}',
            'updated': int(time.time()), 'normals': normals, 'days': by_day, 'records': records,
            'months': months, 'year': {'y': today.year, 'cur': cur, 'normal': ncount}, 'last60': last}


def main():
    if os.path.exists(OUT) and '--force' not in sys.argv:
        with open(OUT) as f:
            if time.time() - json.load(f).get('updated', 0) < 20 * 3600:
                log('climate.json je čerstvý')
                return
    today = dt.datetime.now(dt.timezone.utc).date()
    data = load_history()
    add_recent(data, today)
    keep_recent(data)
    try:
        est = fill_gaps_era5(data, today)
    except Exception as e:
        log('ERA5 zlyhal:', e)
        est = set()
    res = build(data, today, est)
    with open(OUT, 'w') as f:
        json.dump(res, f, ensure_ascii=False, separators=(',', ':'))
    log('climate.json:', json.dumps(res['records'], ensure_ascii=False), json.dumps(res['year'], ensure_ascii=False))


if __name__ == '__main__':
    main()
