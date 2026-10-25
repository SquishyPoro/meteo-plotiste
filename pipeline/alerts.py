#!/usr/bin/env python3
"""Upozornenia do mobilu cez ntfy (https://ntfy.sh) pre Plotiště nad Labem.

Spúšťa GitHub Actions každých 10 minút. Téma ntfy je v tajnom nastavení repozitára NTFY_TOPIC.

  - dážď o chvíľu (radar RainViewer, odhad pohybu zrážok, záloha model ICON-D2)
  - búrka v okolí (silné radarové echo do 40 km alebo na ceste k Plotištu)
  - silný vietor, víchrica, výdatný dážď, búrky (ensemble pravdepodobnosť na dnes/zajtra)
  - mráz v noci (večerná kontrola, september – máj)
  - ranné zhrnutie dňa

Nastavenia sa dajú zmeniť v alerts-config.json v koreni repozitára.
Stav (čo už bolo poslané) sa drží v cache GitHub Actions, aby neprichádzali duplicity.
"""
import base64
import datetime as dt
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_PATH = os.path.join(ROOT, '.alerts-state', 'state.json')  # uchováva sa v cache GitHub Actions
CONFIG_PATH = os.path.join(ROOT, 'alerts-config.json')
TZ = ZoneInfo('Europe/Prague')
HK = (50.236, 15.790)
DASHBOARD = 'https://squishyporo.github.io/meteo-plotiste/'

DEFAULTS = {
    'rain_soon': True,          # dážď do 60 min
    'rain_soon_minutes': 60,
    'storm_nearby': True,
    'wind': True, 'wind_kmh': 60, 'wind_prob': 0.5,
    'heavy_rain': True, 'heavy_rain_mm': 15, 'heavy_rain_prob': 0.5,
    'storms_forecast': True, 'storms_prob': 0.4,
    'frost': True, 'frost_prob': 0.5, 'frost_hour': 18,
    'morning': True, 'morning_hour': 6,
    'quiet_hours': [22, 6],     # v noci len dôležité (vysoká priorita)
}


def log(*a):
    print(*a, flush=True)


def get(url, timeout=40, raw=False):
    req = urllib.request.Request(url, headers={'User-Agent': 'meteo-plotiste'})
    for i in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = r.read()
                return data if raw else json.loads(data)
        except Exception as e:
            err = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f'{url}: {err}')


def send(topic, title, message, tags='', priority=3, dry=False):
    log(f'>> [{priority}] {title}: {message}')
    if dry or not topic:
        return
    # hlavičky HTTP musia byť ASCII; ntfy rozumie zápisu RFC 2047 pre UTF-8
    title_hdr = '=?UTF-8?B?' + base64.b64encode(title.encode()).decode() + '?='
    req = urllib.request.Request(
        'https://ntfy.sh/' + urllib.parse.quote(topic), data=message.encode(), method='POST',
        headers={'Title': title_hdr, 'Tags': tags, 'Priority': str(priority), 'Click': DASHBOARD,
                 'Content-Type': 'text/plain; charset=utf-8'})
    urllib.request.urlopen(req, timeout=30).read()


# ------------------------------------------------------------------ radar

RZ, RX0, RY0, RW = 7, 68, 42, 768
KM_PX = 156.543 * np.cos(np.radians(HK[0])) / 2 ** RZ
UB = ('63615914,66635a19,69665c1e,6c685d24,6f6b5f29,726e612e,75706234,78736439,7c75653e,7f786744,827b6949,857d6a4e,88806c54,8b826d59,'
      '8e856f5e,92887164,9e93756e,aa9e7978,b6a97e82,c2b4828c,cec08796,d2c48ba0,d6c88faa,dacc93b4,ded097be,88ddeeff,6cd1ebff,51c5e8ff,'
      '36bae5ff,1baee2ff,00a3e0ff,009ad5ff,0091caff,0088bfff,007fb4ff,0077aaff,0070a3ff,00699cff,006295ff,005b8eff,005588ff,005180ff,'
      '004e78ff,004a70ff,004768ff,ffee00ff,ffe000ff,ffd200ff,ffc500ff,ffb700ff,ffaa00ff,ff9f00ff,ff9500ff,ff8b00ff,ff8100ff,ff4400ff,'
      'f23600ff,e62800ff,d91b00ff,cd0d00ff,c10000ff,a80000ff,8f0000ff,760000ff,5d0000ff,ffaaffff,ff9fffff,ff95ffff,ff8bffff,ff81ffff,'
      'ff77ffff,ff6cffff,ff62ffff,ff58ffff,ff4effff,ffffffff,ffffffff,ffffffff,ffffffff,ffffffff,ffffffff,ffffffff,ffffffff,ffffffff,'
      'ffffffff,00ff00ff').split(',')
UB_RGB, UB_ALPHA = {}, []
for i, h in enumerate(UB):
    n = int(h, 16)
    if n & 255 == 255:
        UB_RGB.setdefault(n >> 8, i - 10)
    else:
        UB_ALPHA.append((n & 255, i - 10))
NO_ECHO = -128
WET = 15  # dBZ ≈ 0,3 mm/h


def hk_px():
    n = 2 ** RZ * 256
    s = np.sin(np.radians(HK[0]))
    return ((HK[1] + 180) / 360 * n - RX0 * 256, (0.5 - np.log((1 + s) / (1 - s)) / (4 * np.pi)) * n - RY0 * 256)


def decode(img):
    a = img[..., 3].astype(int)
    key = (img[..., 0].astype(int) << 16) | (img[..., 1].astype(int) << 8) | img[..., 2].astype(int)
    out = np.full(a.shape, NO_ECHO, dtype=np.int16)
    solid = a >= 250
    uniq, inv = np.unique(key[solid], return_inverse=True)
    lut = []
    for k in uniq:
        z = UB_RGB.get(int(k))
        if z is None:  # najbližšia farba
            r, g, b = (k >> 16) & 255, (k >> 8) & 255, k & 255
            z = min(UB_RGB.items(), key=lambda kv: ((kv[0] >> 16 & 255) - r) ** 2 + ((kv[0] >> 8 & 255) - g) ** 2 + ((kv[0] & 255) - b) ** 2)[1]
        lut.append(z)
    out[solid] = np.array(lut, dtype=np.int16)[inv] if len(lut) else NO_ECHO
    semi = (a > 0) & ~solid
    if semi.any():
        al = np.array([x[0] for x in UB_ALPHA]); zl = np.array([x[1] for x in UB_ALPHA])
        out[semi] = zl[np.abs(a[semi][:, None] - al[None, :]).argmin(1)]
    return out


def radar():
    meta = get('https://api.rainviewer.com/public/weather-maps.json')
    frames = []
    for f in meta['radar']['past'][-4:]:
        canvas = np.zeros((RW, RW, 4), dtype=np.uint8)
        for dx in range(3):
            for dy in range(3):
                png = get(f"{meta['host']}{f['path']}/256/{RZ}/{RX0 + dx}/{RY0 + dy}/2/0_0.png", raw=True)
                canvas[dy * 256:(dy + 1) * 256, dx * 256:(dx + 1) * 256] = np.array(Image.open(io.BytesIO(png)).convert('RGBA'))
        frames.append((f['time'], decode(canvas)))
    # globálny pohyb: posun ±8 px na 4× zmenšenej mriežke
    def ds(z):
        v = np.where(z >= 10, z, 0).astype(float)
        return v.reshape(RW // 4, 4, RW // 4, 4).mean((1, 3))
    vs = []
    for (t0, a), (t1, b) in zip(frames, frames[1:]):
        if abs(t1 - t0 - 600) > 120:
            continue
        A, B = ds(a), ds(b)
        if (B > 5).mean() < 0.01:
            continue
        best, bv = None, None
        S = 8
        for dy in range(-S, S + 1):
            for dx in range(-S, S + 1):
                bs = B[S:-S, S:-S]
                as_ = A[S - dy:A.shape[0] - S - dy, S - dx:A.shape[1] - S - dx]
                m = (bs > 5) | (as_ > 5)
                if m.sum() < 50:
                    continue
                c = np.abs(bs - as_)[m].mean() + 0.02 * (dx * dx + dy * dy)
                if best is None or c < best:
                    best, bv = c, (dx, dy)
        if bv:
            vs.append(bv)
    v = (float(np.median([x[0] for x in vs])) * 4, float(np.median([x[1] for x in vs])) * 4) if vs else None
    t_last, last = frames[-1]
    hx, hy = hk_px()

    def zmax(x, y, r=3):
        x, y = int(round(x)), int(round(y))
        if x - r < 0 or y - r < 0 or x + r >= RW or y + r >= RW:
            return NO_ECHO
        return int(last[y - r:y + r + 1, x - r:x + r + 1].max())

    wet_now = [int(z[int(hy) - 2:int(hy) + 3, int(hx) - 2:int(hx) + 3].max()) >= WET for _, z in frames[-3:]]
    arrival, storm_path = None, NO_ECHO
    if v:
        for k in range(1, 10):
            z = zmax(hx - v[0] * k, hy - v[1] * k)
            if k <= 6:
                storm_path = max(storm_path, z)
            if arrival is None and z >= WET:
                arrival = (k * 10, z)
    yy, xx = np.ogrid[:RW, :RW]
    near = (np.hypot(xx - hx, yy - hy) * KM_PX) <= 40
    storm_near = int(last[near].max())
    speed = np.hypot(*v) * KM_PX * 6 if v else 0
    dirs = ['sever', 'severovýchod', 'východ', 'juhovýchod', 'juh', 'juhozápad', 'západ', 'severozápad']
    toward = dirs[int(round((np.degrees(np.arctan2(v[0], -v[1])) % 360) / 45)) % 8] if v else ''
    age = time.time() - t_last
    log(f'radar: snímka pred {age / 60:.0f} min, pohyb {v}, {speed:.0f} km/h na {toward}, prší teraz {wet_now}, príchod {arrival}, búrka okolie {storm_near} dBZ, na ceste {storm_path} dBZ')
    return {'time': t_last, 'age': age, 'wet_now': any(wet_now), 'arrival': arrival, 'speed': speed, 'toward': toward,
            'storm_near': storm_near, 'storm_path': storm_path, 'moving': v is not None}


def rate(dbz):
    return (10 ** (dbz / 10) / 200) ** 0.625


def intensity(dbz):
    r = rate(dbz)
    return 'prívalový' if r >= 10 else 'silný' if r >= 4 else 'mierny' if r >= 1 else 'slabý'


# ------------------------------------------------------------------ predpoveď

def forecast():
    q = f'latitude={HK[0]}&longitude={HK[1]}&timezone=Europe%2FPrague&timeformat=unixtime&forecast_days=3'
    ens = get(f'https://ensemble-api.open-meteo.com/v1/ensemble?{q}&hourly=temperature_2m,precipitation,wind_gusts_10m,cape'
              '&models=ecmwf_ifs025,icon_seamless,gfs025', timeout=60)
    det = get(f'https://api.open-meteo.com/v1/forecast?{q}&hourly=temperature_2m,precipitation,wind_gusts_10m,precipitation_probability'
              '&daily=temperature_2m_min,temperature_2m_max,precipitation_sum,wind_gusts_10m_max,weather_code')
    m15 = get(f'https://api.open-meteo.com/v1/forecast?latitude={HK[0]}&longitude={HK[1]}&models=icon_d2&timeformat=unixtime'
              '&minutely_15=precipitation&forecast_minutely_15=8')
    h = ens['hourly']
    times = h['time']

    def members(v):
        return [h[k] for k in h if (k == v or k.startswith(v + '_')) and any(x is not None for x in h[k])]
    return {'times': times, 't': members('temperature_2m'), 'p': members('precipitation'), 'g': members('wind_gusts_10m'),
            'cape': members('cape'), 'det': det, 'm15': m15['minutely_15']}


def prob_window(F, t0, t1):
    """Pravdepodobnosti a mediány v okne [t0, t1) z ensemble."""
    idx = [i for i, t in enumerate(F['times']) if t0 <= t < t1]
    if not idx:
        return None

    def per(arrs, fn):
        out = []
        for m in arrs:
            vals = [m[i] for i in idx if m[i] is not None]
            if len(vals) >= len(idx) * 0.75:
                out.append(fn(vals))
        return out
    gmax, psum, tmin = per(F['g'], max), per(F['p'], sum), per(F['t'], min)
    storm = []
    for e, cm in enumerate(F['cape']):
        if e >= len(F['p']):
            break
        c = [cm[i] for i in idx if cm[i] is not None]
        r = [F['p'][e][i] for i in idx if F['p'][e][i] is not None]
        if len(c) >= len(idx) * 0.75:
            storm.append(1 if max(c) >= 500 and sum(r) >= 1 else 0)
    P = lambda arr, f: (sum(1 for x in arr if f(x)) / len(arr)) if arr else 0.0
    med = lambda arr: float(np.median(arr)) if arr else None
    return {'n': len(gmax), 'gust_med': med(gmax), 'gust_p90': float(np.percentile(gmax, 90)) if gmax else None,
            'p_wind': P(gmax, lambda x: x >= CFG['wind_kmh']), 'p_storm_wind': P(gmax, lambda x: x >= 90),
            'rain_med': med(psum), 'p_heavy': P(psum, lambda x: x >= CFG['heavy_rain_mm']),
            'p_storm': (sum(storm) / len(storm)) if storm else 0.0,
            'tmin_med': med(tmin), 'p_frost': P(tmin, lambda x: x < 0)}


def pct(p):
    return f'{round(p * 100)} %'


def fmt(x, d=0):
    return '–' if x is None else (f'{x:.{d}f}').replace('.', ',')


# ------------------------------------------------------------------ výstrahy ČHMÚ (CAP)

CAP_DIR = 'https://opendata.chmi.cz/meteorology/weather/alerts/cap/'
ORP = '5205'  # obec s rozšírenou pôsobnosťou Hradec Králové (CISORP)
WARN_PATH = os.path.join(ROOT, 'data', 'warnings.json')
LEVEL_FROM_SEVERITY = {'Moderate': 'yellow', 'Severe': 'orange', 'Extreme': 'red'}


def chmi_warnings():
    """Platné výstrahy ČHMÚ pre ORP Hradec Králové z najnovších CAP súborov."""
    import re
    import xml.etree.ElementTree as ET
    html = get(CAP_DIR, raw=True).decode('utf-8', 'replace')
    rows = re.findall(r'href="(alert_cap_(\d+)_\d+\.xml)">[^<]*</a>\s+(\d\d-\w\w\w-\d{4} \d\d:\d\d)', html)
    latest = {}
    for name, kind, when in rows:
        t = dt.datetime.strptime(when, '%d-%b-%Y %H:%M')
        if kind not in latest or t > latest[kind][1]:
            latest[kind] = (name, t)
    ns = {'c': 'urn:oasis:names:tc:emergency:cap:1.2'}
    now = dt.datetime.now(dt.timezone.utc)
    out = []
    for name, _ in latest.values():
        root = ET.fromstring(get(CAP_DIR + name, raw=True, timeout=90))
        for info in root.findall('c:info', ns):
            f = lambda k: (info.findtext('c:' + k, namespaces=ns) or '').strip()
            if f('language') != 'cs' or f('certainty') == 'Unlikely' or f('event').startswith('Žádn'):
                continue
            codes = {g.findtext('c:value', namespaces=ns) for a in info.findall('c:area', ns) for g in a.findall('c:geocode', ns)
                     if g.findtext('c:valueName', namespaces=ns) == 'CISORP'}
            if ORP not in codes:
                continue
            params = {p.findtext('c:valueName', namespaces=ns): p.findtext('c:value', namespaces=ns) for p in info.findall('c:parameter', ns)}
            expires = f('expires') or params.get('eventEndingTime') or ''
            if expires and dt.datetime.fromisoformat(expires) < now:
                continue
            level = LEVEL_FROM_SEVERITY.get(f('severity'), 'yellow')
            al = params.get('awareness_level', '')
            for c in ('yellow', 'orange', 'red'):
                if c in al:
                    level = c
            out.append({'event': f('event'), 'level': level, 'onset': f('onset'), 'expires': expires,
                        'certainty': f('certainty'), 'description': f('description'), 'instruction': f('instruction'),
                        'situation': params.get('situation', ''), 'web': f('web')})
    order = {'red': 0, 'orange': 1, 'yellow': 2}
    out.sort(key=lambda w: (order.get(w['level'], 3), w['onset']))
    return out, sorted(n for n, _ in latest.values())


LEVEL_SK = {'yellow': 'Žltá', 'orange': 'Oranžová', 'red': 'Červená'}


# ------------------------------------------------------------------ main

def main():
    dry = '--dry' in sys.argv
    topic = os.environ.get('NTFY_TOPIC', '').strip()
    if '--test' in sys.argv:
        send(topic, 'Meteo Plotiště: test', 'Upozornenia fungujú. Ťuknutím otvoríš dashboard.', 'white_check_mark', 3, dry)
        return
    if not topic and not dry:
        log('NTFY_TOPIC nie je nastavený – nič neposielam.')
        dry = True
    state = {}
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH) as f:
            state = json.load(f)
    sent = state.setdefault('sent', {})
    now = time.time()
    local = dt.datetime.now(TZ)
    today = local.date()
    quiet = local.hour >= CFG['quiet_hours'][0] or local.hour < CFG['quiet_hours'][1]

    def once(key, hours=None):
        """True, ak upozornenie s týmto kľúčom ešte nebolo poslané (alebo pred viac ako `hours` hodinami)."""
        t = sent.get(key)
        return t is None or (hours is not None and now - t > hours * 3600)

    def mark(key):
        sent[key] = now

    # --- radar
    R = None
    try:
        R = radar()
    except Exception as e:
        log('radar zlyhal:', e)
    if R and R['age'] < 40 * 60:
        if R['wet_now']:
            state['last_wet'] = now
        dry_long = now - state.get('last_wet', 0) > 2 * 3600
        if CFG['rain_soon'] and R['arrival'] and not R['wet_now'] and dry_long and once('rain_soon', 2):
            mins, z = R['arrival']
            if mins <= CFG['rain_soon_minutes']:
                when = dt.datetime.fromtimestamp(R['time'] + mins * 60, TZ).strftime('%H:%M')
                send(topic, f'Dážď o {mins} min', f'Radar: {intensity(z)} dážď by mal doraziť do Plotišťa okolo {when} '
                     f'(zrážky sa posúvajú na {R["toward"]} {fmt(R["speed"])} km/h).', 'umbrella', 2 if quiet else 3, dry)
                mark('rain_soon')
        storm = max(R['storm_near'], R['storm_path'])
        if CFG['storm_nearby'] and storm >= 45 and once('storm_nearby', 3):
            where = 'do 40 km od Plotišťa' if R['storm_near'] >= 45 else 'a smeruje k Plotištu (do 60 min)'
            send(topic, 'Búrka v okolí', f'Radar ukazuje silné búrkové echo ({storm} dBZ) {where}. Možné prívalové zrážky, krúpy a nárazy vetra.',
                 'zap,warning', 4, dry)
            mark('storm_nearby')
    elif CFG['rain_soon']:
        # záloha: ICON-D2 po 15 min
        try:
            m15 = forecast()['m15']
            wet = [i for i, p in enumerate(m15['precipitation']) if (p or 0) >= 0.1]
            if wet and wet[0] > 0 and once('rain_soon', 3):
                when = dt.datetime.fromtimestamp(m15['time'][wet[0]] - 900, TZ).strftime('%H:%M')
                send(topic, 'Dážď čoskoro', f'Model ICON-D2: dážď v Plotišti okolo {when} (radar je nedostupný).', 'umbrella', 3, dry)
                mark('rain_soon')
        except Exception as e:
            log('ICON-D2 zlyhal:', e)

    # --- predpoveď (každú hodinu stačí)
    if now - state.get('last_forecast', 0) > 50 * 60 or '--force' in sys.argv:
        try:
            F = forecast()
            state['last_forecast'] = now
            days = {}
            for d in (0, 1):
                day = today + dt.timedelta(days=d)
                t0 = dt.datetime.combine(day, dt.time(), TZ).timestamp()
                days[d] = (day, prob_window(F, max(t0, now), t0 + 86400))
                w_ = days[d][1]
                log(f'{day}: ' + (', '.join(f'{k}={v:.2f}' for k, v in w_.items() if isinstance(v, float)) if w_ else 'bez dát'))
            names = {0: 'Dnes', 1: 'Zajtra'}
            for d, (day, w) in days.items():
                if not w:
                    continue
                k = f'{day}'
                if CFG['wind'] and w['p_storm_wind'] >= 0.3 and once('vichrica-' + k):
                    send(topic, f'{names[d]}: víchrica', f'Nárazy vetra ≥ 90 km/h s pravdepodobnosťou {pct(w["p_storm_wind"])}; '
                         f'najsilnejšie nárazy asi {fmt(w["gust_med"])}–{fmt(w["gust_p90"])} km/h.', 'dash,warning', 5, dry)
                    mark('vichrica-' + k); mark('vietor-' + k)
                elif CFG['wind'] and w['p_wind'] >= CFG['wind_prob'] and once('vietor-' + k):
                    send(topic, f'{names[d]}: silný vietor', f'Nárazy ≥ {CFG["wind_kmh"]} km/h s pravdepodobnosťou {pct(w["p_wind"])}; '
                         f'typicky {fmt(w["gust_med"])} km/h, v horšom prípade {fmt(w["gust_p90"])} km/h.', 'dash', 4, dry)
                    mark('vietor-' + k)
                if CFG['heavy_rain'] and w['p_heavy'] >= CFG['heavy_rain_prob'] and once('dazd-' + k):
                    send(topic, f'{names[d]}: výdatný dážď', f'Úhrn ≥ {CFG["heavy_rain_mm"]} mm s pravdepodobnosťou {pct(w["p_heavy"])} '
                         f'(najpravdepodobnejšie {fmt(w["rain_med"], 1)} mm).', 'cloud_with_rain', 4, dry)
                    mark('dazd-' + k)
                if CFG['storms_forecast'] and w['p_storm'] >= CFG['storms_prob'] and once('burky-' + k):
                    send(topic, f'{names[d]}: možné búrky', f'Pravdepodobnosť búrok v okolí Plotišťa {pct(w["p_storm"])}.', 'zap', 3, dry)
                    mark('burky-' + k)
            # mráz: večer o frost_hour, september – máj
            if CFG['frost'] and local.hour >= CFG['frost_hour'] and local.month not in (6, 7, 8) and once(f'mraz-{today}'):
                t0 = dt.datetime.combine(today, dt.time(18), TZ).timestamp()
                w = prob_window(F, t0, t0 + 15 * 3600)
                if w and w['p_frost'] >= CFG['frost_prob']:
                    send(topic, 'V noci mráz', f'Minimálna teplota asi {fmt(w["tmin_med"], 1)} °C, pravdepodobnosť mrazu {pct(w["p_frost"])}. '
                         'Pozor na námrazu a citlivé rastliny.', 'snowflake', 3, dry)
                mark(f'mraz-{today}')
            # ranné zhrnutie
            if CFG['morning'] and local.hour >= CFG['morning_hour'] and local.hour < CFG['morning_hour'] + 3 and once(f'rano-{today}'):
                dd = F['det']['daily']
                i = 0
                w = days[0][1] or {}
                pp = F['det']['hourly']['precipitation_probability']
                ht = F['det']['hourly']['time']
                end = dt.datetime.combine(today, dt.time(22), TZ).timestamp()
                pmax = max([p for t, p in zip(ht, pp) if now <= t < end and p is not None] or [0])
                rain = dd['precipitation_sum'][i] or 0
                msg = (f'{fmt(dd["temperature_2m_min"][i])} až {fmt(dd["temperature_2m_max"][i])} °C, '
                       + (f'zrážky {pmax} % ({fmt(rain, 1)} mm)' if rain >= 0.2 else 'bez výraznejších zrážok')
                       + f', nárazy vetra do {fmt(dd["wind_gusts_10m_max"][i])} km/h.')
                risks = [n for n, p in (('silný vietor', w.get('p_wind', 0)), ('výdatný dážď', w.get('p_heavy', 0)), ('búrky', w.get('p_storm', 0))) if p >= 0.3]
                if risks:
                    msg += ' Pozor: ' + ', '.join(risks) + '.'
                send(topic, 'Dobré ráno, dnes v Plotišti', msg, 'sunrise', 2, dry)
                mark(f'rano-{today}')
        except Exception as e:
            log('predpoveď zlyhala:', e)

    # --- výstrahy ČHMÚ
    try:
        warns, files = chmi_warnings()
        log(f'ČHMÚ: {len(warns)} platných výstrah pre ORP Hradec Králové ({", ".join(files)})')
        old = None
        if os.path.exists(WARN_PATH):
            with open(WARN_PATH) as f:
                old = json.load(f).get('warnings')
        if old != warns:
            with open(WARN_PATH, 'w') as f:
                json.dump({'updated': int(now), 'area': 'ORP Hradec Králové', 'warnings': warns}, f, ensure_ascii=False, indent=1)
        for w in warns:
            key = f'chmi-{w["event"]}-{w["onset"]}-{w["level"]}'
            if once(key):
                t = lambda x: dt.datetime.fromisoformat(x).astimezone(TZ).strftime('%d.%m. %H:%M') if x else '?'
                first = w['description'].split('\n')[0]
                until = t(w['expires']) if w['expires'] else 'do odvolania'
                slow = 'sucho' in w['event'].lower()  # dlhodobé výstrahy (sucho) nie sú naliehavé
                prio = 3 if slow else {'yellow': 4, 'orange': 5, 'red': 5}.get(w['level'], 4)
                send(topic, f'ČHMÚ: {w["event"]}', f'{LEVEL_SK.get(w["level"], "")} výstraha pre Hradec Králové, {t(w["onset"])} – {until}. {first}',
                     'droplet' if slow else ('rotating_light' if w['level'] != 'yellow' else 'warning'), prio, dry)
                sent[key] = now + 6 * 86400  # podržať v stave dlhšie, výstrahy trvajú aj niekoľko dní
    except Exception as e:
        log('výstrahy ČHMÚ zlyhali:', e)

    # upratať staré záznamy
    for k in [k for k, t in sent.items() if now - t > 7 * 86400]:
        del sent[k]
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    with open(STATE_PATH, 'w') as f:
        json.dump(state, f, indent=1, sort_keys=True)


CFG = dict(DEFAULTS)
if os.path.exists(CONFIG_PATH):
    with open(CONFIG_PATH) as f:
        CFG.update({k: v for k, v in json.load(f).items() if not k.startswith('_')})

if __name__ == '__main__':
    main()
