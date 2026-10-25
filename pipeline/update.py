#!/usr/bin/env python3
"""Zber meraní ČHMÚ a vyhodnotenie presnosti modelov pre Plotiště nad Labem.

Spúšťa GitHub Actions každú hodinu. Iba štandardná knižnica Pythonu.

  data/obs/hourly-<stanica>.csv  hodinové merania (UTC), dopĺňajú sa a prepisujú
  data/obs-recent.json           posledných 8 dní meraní pre graf na stránke
  data/skill.json                chyby a váhy modelov = podklad pre "AI predpoveď"
"""
import csv
import datetime as dt
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
OBS_DIR = os.path.join(DATA, 'obs')

HK = (50.236, 15.790)
# primárna stanica: Hradec Králové, Svobodné Dvory (~1,5 km od Plotišťa); záloha: Nový Hradec Králové
STATIONS = [
    {'wsi': '0-203-0-11651', 'name': 'Hradec Králové, Svobodné Dvory', 'lat': 50.2230, 'lon': 15.7878, 'elev': 240},
    {'wsi': '0-203-0-11649', 'name': 'Hradec Králové, Nový Hradec Králové', 'lat': 50.1776, 'lon': 15.8385, 'elev': 278},
]
CHMI_NOW = 'https://opendata.chmi.cz/meteorology/climate/now/data/'
CHMI_RECENT = 'https://opendata.chmi.cz/meteorology/climate/recent/data/10min/'

MODELS = ['ecmwf_ifs025', 'icon_seamless', 'gfs_seamless', 'meteofrance_seamless', 'ukmo_seamless', 'gem_seamless']
VARS = {'t': 'temperature_2m', 'g': 'wind_gusts_10m', 'p': 'precipitation'}
LEADS = range(0, 7)          # previous_day0 … previous_day6
BACKFILL_DAYS = 45           # prvé spustenie: koľko dní meraní skúsiť stiahnuť
TRAIN_DAYS = 60              # okno na vyhodnotenie modelov
HALF_LIFE_DAYS = 14          # novšie dni majú väčšiu váhu
TEST_DAYS = 7                # posledné dni na férové porovnanie AI vs. priemer modelov
FIELDS = ['time', 't', 'rh', 'wind', 'gust', 'dir', 'precip']


def log(*a):
    print(*a, flush=True)


def get_json(url, tries=3, timeout=60):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'meteo-plotiste (github.com/SquishyPoro/meteo-plotiste)'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            err = e
        except Exception as e:  # sieť, timeout, zlý JSON
            err = e
        time.sleep(2 * (i + 1))
    raise RuntimeError(f'{url}: {err}')


# ------------------------------------------------------------------ merania ČHMÚ

def fetch_day_10min(wsi, day):
    """10-min hodnoty jednej stanice za deň -> {element: {datetime: value}}."""
    name = f'10m-{wsi}-{day:%Y%m%d}.json'
    j = None
    for base in (CHMI_NOW, CHMI_RECENT):
        j = get_json(base + name)
        if j:
            break
    if not j:
        return None
    out = {}
    for _st, el, ts, val, _flag, _q in j['data']['data']['values']:
        if val is None:
            continue
        out.setdefault(el, {})[dt.datetime.fromisoformat(ts.replace('Z', '+00:00'))] = float(val)
    return out


def hourly_from_10min(raw, day):
    """Agregácia do hodín. Hodina HH:00 pokrýva interval (HH-1:00, HH:00]."""
    rows = {}
    start = dt.datetime(day.year, day.month, day.day, tzinfo=dt.timezone.utc)
    for h in range(1, 25):
        end = start + dt.timedelta(hours=h)
        win = [end - dt.timedelta(minutes=10 * k) for k in range(6)]
        at = lambda el: raw.get(el, {}).get(end)
        def agg(el, fn):
            v = [raw.get(el, {}).get(w) for w in win]
            v = [x for x in v if x is not None]
            return fn(v) if len(v) >= 4 else None
        row = {
            't': at('T'), 'rh': at('H'),
            'wind': None if at('F') is None else at('F') * 3.6,
            'gust': agg('Fmax', max), 'dir': at('D'), 'precip': agg('SRA10M', sum),
        }
        if row['gust'] is not None:
            row['gust'] *= 3.6
        if any(v is not None for v in row.values()):
            rows[int(end.timestamp())] = row
    return rows


def load_obs(wsi):
    path = os.path.join(OBS_DIR, f'hourly-{wsi}.csv')
    rows = {}
    if os.path.exists(path):
        with open(path, newline='') as f:
            for r in csv.DictReader(f):
                rows[int(r['time'])] = {k: (float(r[k]) if r[k] not in ('', None) else None) for k in FIELDS[1:]}
    return rows


def save_obs(wsi, rows):
    os.makedirs(OBS_DIR, exist_ok=True)
    path = os.path.join(OBS_DIR, f'hourly-{wsi}.csv')
    with open(path, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(FIELDS)
        for t in sorted(rows):
            r = rows[t]
            w.writerow([t] + ['' if r[k] is None else round(r[k], 1) for k in FIELDS[1:]])


def update_obs(today):
    all_obs = {}
    for st in STATIONS:
        rows = load_obs(st['wsi'])
        per_day = {}
        for t in rows:
            d = dt.datetime.fromtimestamp(t - 1, dt.timezone.utc).date()
            per_day[d] = per_day.get(d, 0) + 1
        have_days = {d for d, n in per_day.items() if n >= 22}
        days = []
        for k in range(BACKFILL_DAYS, -1, -1):
            d = today - dt.timedelta(days=k)
            # posledné 2 dni vždy znova (dopĺňajú sa), staršie len ak chýbajú
            if k <= 2 or d not in have_days:
                days.append(d)
        got = 0
        for d in days:
            raw = fetch_day_10min(st['wsi'], d)
            if raw:
                rows.update(hourly_from_10min(raw, d))
                got += 1
        log(f'{st["name"]}: {got}/{len(days)} dní stiahnutých, spolu {len(rows)} hodín')
        save_obs(st['wsi'], rows)
        all_obs[st['wsi']] = rows
    # zlúčené: primárna stanica, chýbajúce hodnoty doplní záložná
    prim, back = (all_obs[s['wsi']] for s in STATIONS)
    merged = {}
    for t in set(prim) | set(back):
        a, b = prim.get(t, {}), back.get(t, {})
        merged[t] = {k: a.get(k) if a.get(k) is not None else b.get(k) for k in FIELDS[1:]}
    return merged


# ------------------------------------------------------------------ predpovede z minulosti

def fetch_previous_runs(model, start, end):
    hourly = [f'{v}_previous_day{L}' if L else v for v in VARS.values() for L in LEADS]
    url = ('https://previous-runs-api.open-meteo.com/v1/forecast?'
           f'latitude={HK[0]}&longitude={HK[1]}&models={model}&timezone=GMT&timeformat=unixtime'
           f'&start_date={start:%Y-%m-%d}&end_date={end:%Y-%m-%d}&hourly={",".join(hourly)}')
    j = get_json(url, timeout=120)
    if not j or 'hourly' not in j:
        return None
    h = j['hourly']
    out = {}
    for key, v in VARS.items():
        for L in LEADS:
            arr = h.get(f'{v}_previous_day{L}' if L else v)
            if arr and any(x is not None for x in arr):
                out[(key, L)] = dict(zip(h['time'], arr))
    return out


# ------------------------------------------------------------------ vyhodnotenie

def weighted(pairs):
    """pairs: [(chyba, váha)] -> (bias, mae, n)"""
    sw = sum(w for _, w in pairs)
    if not pairs or sw <= 0:
        return None, None, 0
    bias = sum(e * w for e, w in pairs) / sw
    mae = sum(abs(e) * w for e, w in pairs) / sw
    return bias, mae, len(pairs)


def hour_bias(samples, overall, k=10.0):
    """Bias podľa hodiny dňa (UTC) so zmrštením k celkovému biasu a vyhladením ±1 h."""
    acc = [[0.0, 0.0] for _ in range(24)]
    for t, e, w in samples:
        h = (t // 3600) % 24
        acc[h][0] += e * w
        acc[h][1] += w
    raw = [(s + k * overall) / (n + k) for s, n in acc]
    return [round((raw[(h - 1) % 24] + 2 * raw[h] + raw[(h + 1) % 24]) / 4, 2) for h in range(24)]


def daily_sums(series, times):
    days = {}
    for t in times:
        v = series.get(t)
        if v is not None:
            days.setdefault((t - 1) // 86400, []).append(v)
    return {d: sum(v) for d, v in days.items() if len(v) == 24}


def evaluate(obs, today):
    end = today - dt.timedelta(days=1)
    first_obs = min(obs) if obs else None
    start = max(today - dt.timedelta(days=TRAIN_DAYS),
                dt.datetime.fromtimestamp(first_obs, dt.timezone.utc).date() if first_obs else today)
    now_ts = time.time()
    test_from = int((dt.datetime.combine(today, dt.time(), dt.timezone.utc) - dt.timedelta(days=TEST_DAYS)).timestamp())
    decay = lambda t: 0.5 ** ((now_ts - t) / 86400 / HALF_LIFE_DAYS)

    fc = {}
    for m in MODELS:
        try:
            r = fetch_previous_runs(m, start, end)
        except Exception as e:
            log(f'{m}: chyba {e}')
            r = None
        if r:
            fc[m] = r
            log(f'{m}: {len(r)} sérií')
    if not fc:
        raise RuntimeError('žiadne historické predpovede')

    obs_key = {'t': 't', 'g': 'gust', 'p': 'precip'}
    res = {'models': {}, 'weights': {}, 'test': {}}
    for m, series in fc.items():
        mm = res['models'][m] = {}
        for key in VARS:
            mm[key] = {}
            for L in LEADS:
                s = series.get((key, L))
                if not s:
                    continue
                samples = [(t, s[t] - obs[t][obs_key[key]], decay(t)) for t in s
                           if s[t] is not None and t in obs and obs[t][obs_key[key]] is not None]
                if key == 'p':
                    # zrážky: denné úhrny, len chyba (bez korekcie)
                    ot = {t: obs[t]['precip'] for t in obs if obs[t]['precip'] is not None}
                    fd, od = daily_sums(s, sorted(s)), daily_sums(ot, sorted(ot))
                    if not fd or not od:
                        continue
                    pairs = [(fd[d] - od[d], decay(d * 86400)) for d in fd if d in od]
                    b, mae, n = weighted(pairs)
                    if n >= 5:
                        mm[key][L] = {'bias': round(b, 2), 'mae': round(mae, 2), 'n': n}
                    continue
                train = [x for x in samples if x[0] < test_from]
                b, mae, n = weighted([(e, w) for _, e, w in samples])
                if n < 48:
                    continue
                entry = {'bias': round(b, 2), 'mae': round(mae, 2), 'n': n}
                # chyba po korekcii (na celom okne – informatívne)
                if key == 't':
                    hb = hour_bias(samples, b)
                    entry['hour_bias'] = hb
                    _, mae_c, _ = weighted([(e - hb[(t // 3600) % 24], w) for t, e, w in samples])
                else:
                    _, mae_c, _ = weighted([(e - b, w) for _, e, w in samples])
                entry['mae_corr'] = round(mae_c, 2)
                # bias len z trénovacej časti pre férový test
                tb, _, tn = weighted([(e, w) for _, e, w in train])
                if tn >= 48:
                    entry['_train_bias'] = tb
                    if key == 't':
                        entry['_train_hb'] = hour_bias(train, tb)
                mm[key][L] = entry

    # váhy: 1 / MAE² po korekcii
    for key in ('t', 'g', 'p'):
        res['weights'][key] = {}
        for L in LEADS:
            inv = {}
            for m in res['models']:
                e = res['models'][m][key].get(L)
                if e:
                    inv[m] = 1 / max(0.05, e.get('mae_corr', e['mae'])) ** 2
            s = sum(inv.values())
            if s:
                res['weights'][key][L] = {m: round(v / s, 3) for m, v in inv.items()}

    # férový test na posledných TEST_DAYS dňoch: AI (bias + váhy z trénovacej časti) vs. obyčajný priemer
    for key in ('t', 'g'):
        res['test'][key] = {}
        for L in (0, 1, 2, 4):
            tr = {}
            for m in res['models']:
                e = res['models'][m][key].get(L)
                if e and '_train_bias' in e:
                    tr[m] = e
            if len(tr) < 2:
                continue
            # váhy z trénovacej časti
            inv = {}
            for m, e in tr.items():
                s = fc[m][(key, L)]
                errs = [(s[t] - obs[t][obs_key[key]] - (e['_train_hb'][(t // 3600) % 24] if key == 't' else e['_train_bias']), decay(t))
                        for t in s if t < test_from and s[t] is not None and t in obs and obs[t][obs_key[key]] is not None]
                _, mae, n = weighted(errs)
                if n >= 48:
                    inv[m] = 1 / max(0.05, mae) ** 2
            if len(inv) < 2:
                continue
            sw = sum(inv.values())
            e_ai, e_mean, n = 0.0, 0.0, 0
            for t, o in obs.items():
                if t < test_from or o[obs_key[key]] is None:
                    continue
                vals = {m: fc[m][(key, L)].get(t) for m in inv}
                if any(v is None for v in vals.values()):
                    continue
                corr = {m: v - (tr[m]['_train_hb'][(t // 3600) % 24] if key == 't' else tr[m]['_train_bias']) for m, v in vals.items()}
                ai = sum(corr[m] * inv[m] for m in inv) / sw
                mean = sum(vals.values()) / len(vals)
                e_ai += abs(ai - o[obs_key[key]]); e_mean += abs(mean - o[obs_key[key]]); n += 1
            if n >= 24:
                res['test'][key][L] = {'ai': round(e_ai / n, 2), 'mean': round(e_mean / n, 2), 'n': n}

    for m in res['models'].values():
        for key in m.values():
            for e in key.values():
                e.pop('_train_bias', None); e.pop('_train_hb', None)
    res['window'] = {'from': f'{start}', 'to': f'{end}', 'days': (end - start).days + 1}
    return res


# ------------------------------------------------------------------ main

def main():
    os.makedirs(DATA, exist_ok=True)
    now = dt.datetime.now(dt.timezone.utc)
    today = now.date()
    obs = update_obs(today)

    cutoff = int((now - dt.timedelta(days=8)).timestamp())
    recent = sorted(t for t in obs if t >= cutoff)
    with open(os.path.join(DATA, 'obs-recent.json'), 'w') as f:
        json.dump({
            'station': STATIONS[0]['name'], 'backup': STATIONS[1]['name'], 'updated': int(now.timestamp()),
            'time': recent, **{k: [None if obs[t][k] is None else round(obs[t][k], 1) for t in recent] for k in FIELDS[1:]},
        }, f, separators=(',', ':'))

    skill_path = os.path.join(DATA, 'skill.json')
    force = '--train' in sys.argv
    stale = True
    if os.path.exists(skill_path):
        with open(skill_path) as f:
            stale = time.time() - json.load(f).get('updated', 0) > 20 * 3600
    if force or stale:
        res = evaluate(obs, today)
        res.update({'updated': int(now.timestamp()), 'station': STATIONS[0]['name'],
                    'method': 'bias podľa hodiny dňa + váhy 1/MAE², polčas zabúdania 14 dní'})
        with open(skill_path, 'w') as f:
            json.dump(res, f, separators=(',', ':'))
        log('skill.json aktualizovaný:', json.dumps(res['test']))
    else:
        log('skill.json je čerstvý, preskakujem trénovanie')


if __name__ == '__main__':
    main()
