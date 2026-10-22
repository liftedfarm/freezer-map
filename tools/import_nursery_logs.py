"""Nursery 2026 logs and products from WebbNursery_2026.xlsx -> supabase/037_products.sql

- Products: the workbook's Fert List, with the typical rate taken from what was actually logged.
- Logs: the Spray Log (Apr-Jun 2026), one log per spray (date, time, location, type) with its product lines.
  Foliar sprays with only nutrients become Feed logs (Foliar feed); IPM, sulfur, and foliar sprays carrying a
  pesticide (Regalia, Pyganic...) become Spray logs.
- The Feed Log's baseline per-gallon recipe becomes a Nursery recipe.
Usage: python3 tools/import_nursery_logs.py WebbNursery_2026.xlsx > supabase/037_products.sql (the header/schema part is in this file too)
"""
import collections, datetime, json, sys, warnings
import openpyxl

warnings.filterwarnings('ignore')
wb = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=True)
TAG = '[import Webb2026]'
PEST = {'Azaguard', 'Pyganic', 'PFR-97', 'Venerate', 'Regalia', 'Sulfur'}


def q(v):
    if v is None or (isinstance(v, str) and not v.strip()):
        return 'null'
    if isinstance(v, (int, float)):
        return repr(round(float(v), 4)).rstrip('0').rstrip('.') if isinstance(v, float) else str(v)
    return "'" + str(v).strip().replace("'", "''") + "'"


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# ---------- the Spray Log ----------
rows = []
last = None
for r in wb['Spray Log'].iter_rows(min_row=2, values_only=True):
    if not r[0] or not r[7]:
        continue
    d, start, end, loc, sqft, typ, water, prod, rate, unit, total = r[:11]
    applicator = r[13] or r[14] if len(r) > 14 else None
    # blank location / times: same spray as the row above (same day and type)
    if last and last['d'] == d and last['typ'] == typ:
        loc = loc or last['loc']; start = start or last['start']; end = end or last['end']
        sqft = sqft or last['sqft']; water = water or last['water']
    rows.append(dict(d=d, start=start, end=end, loc=loc, sqft=sqft, typ=typ, water=water, prod=str(prod).strip(),
                     rate=num(rate), unit=(unit or '').strip() or None, total=num(total), app=applicator))
    last = rows[-1]

groups = collections.OrderedDict()
for x in rows:
    k = (x['d'], x['start'], x['end'], x['loc'], x['typ'], x['water'])
    groups.setdefault(k, []).append(x)

logs = []
for (d, start, end, loc, typ, water), xs in groups.items():
    prods = []
    for x in xs:
        u = (x['unit'] or '').split('/')[0] or None
        tot = round(x['rate'] * float(water), 2) if x['rate'] is not None and water else x['total']
        prods.append({'product': x['prod'], 'rate': x['rate'], 'unit': u, 'basis': 'gal', 'total': tot, 'total_unit': u})
    pest = any(p['product'] in PEST for p in prods)
    if typ == 'Foliar Spray' and not pest:
        kind, spray_type, method = 'feed', None, 'Foliar feed'
    else:
        kind, method = 'spray', 'Foliar'
        spray_type = 'Sulfur' if typ == 'Sulfur Spray' else 'Pesticide' if typ == 'IPM Spray' else 'Feed + pesticide'
    app = next((x['app'] for x in xs if x['app'] and not str(x['app']).startswith('*')), None)
    logs.append(dict(kind=kind, area=loc, log_on=d.date().isoformat(), start=start.strftime('%H:%M') if isinstance(start, datetime.time) else None,
                     end=end.strftime('%H:%M') if isinstance(end, datetime.time) else None, sqft=num(xs[0]['sqft']), spray_type=spray_type,
                     water=num(water), app=app, products=prods, method=method, note=f'{TAG} {typ}'))

# the one Feed Log entry (5/4, Webb Road): True Leaf Life + LFP, no rates written down
logs.append(dict(kind='feed', area='Webb', log_on='2026-05-04', start='09:00', end=None, sqft=43920, spray_type=None, water=None, app=None,
                 products=[{'product': 'True Leaf Life', 'rate': None, 'unit': None, 'basis': 'gal', 'total': None, 'total_unit': None},
                           {'product': 'LFP', 'rate': None, 'unit': None, 'basis': 'gal', 'total': None, 'total_unit': None}],
                 method='Fertigation', note=f'{TAG} Feed Log'))

# ---------- products: Fert List + what was logged ----------
used = collections.defaultdict(collections.Counter)
for x in rows:
    if x['rate'] is not None:
        used[x['prod']][(x['rate'], x['unit'] or '')] += 1
fert = list(wb['Fert List'].iter_rows(min_row=3, values_only=True))
products = []
for r in fert:
    if not r[0]:
        continue
    name, manu, full, rate, runit, label_rate, form, npk, sec, micro, notes, link = [r[i] if i < len(r) else None for i in range(12)]
    name = str(name).strip()
    if used[name]:
        (lr, lu), _ = used[name].most_common(1)[0]
        rate, runit = lr, lu or runit
    if isinstance(rate, str):
        label_rate = label_rate or rate
        rate = None
    note_bits = [b for b in [f'Label rate {label_rate}' if label_rate else None, notes] if b]
    nutrients = ', '.join(str(b) for b in [sec, micro] if b) or None
    products.append(dict(name=name, manufacturer=manu, full_name=full, rate=num(rate), rate_unit=runit.replace('Gal', 'gal') if runit else None,
                         form=form, npk=npk, nutrients=nutrients, notes='. '.join(str(b) for b in note_bits) or None,
                         label_url=link if link and (str(link).startswith('http') or str(link).endswith('.pdf')) else None,
                         pesticide=name in PEST or 'Pesticide' in str(form or ''), kind=form))

recipe = []
for r in wb['Feed Log'].iter_rows(values_only=True):
    if len(r) > 13 and r[11] and isinstance(r[12], (int, float)):
        nm = str(r[11]).strip()
        nm = {'Agrothrive LFP': 'LFP'}.get(nm, nm)
        recipe.append({'product': nm, 'rate': r[12], 'unit': str(r[13]).split('/')[0], 'basis': 'gal', 'total': None, 'total_unit': None})

# ---------- SQL ----------
out = []
w = out.append
w(open('tools/037_products_head.sql').read())
w('-- Nursery products: the Fert List in WebbNursery_2026.xlsx, typical rate = what the 2026 Spray Log used most')
for p in products:
    w(f"insert into input_products (module, name, manufacturer, full_name, rate, rate_unit, kind, form, npk, nutrients, notes, label_url, pesticide) values "
      f"('nursery', {q(p['name'])}, {q(p['manufacturer'])}, {q(p['full_name'])}, {q(p['rate'])}, {q(p['rate_unit'])}, {q(p['kind'])}, {q(p['form'])}, {q(p['npk'])}, "
      f"{q(p['nutrients'])}, {q(p['notes'])}, {q(p['label_url'])}, {'true' if p['pesticide'] else 'false'})\n"
      f"  on conflict (module, name) do update set manufacturer = coalesce(input_products.manufacturer, excluded.manufacturer), full_name = coalesce(input_products.full_name, excluded.full_name),\n"
      f"    rate = coalesce(excluded.rate, input_products.rate), rate_unit = coalesce(excluded.rate_unit, input_products.rate_unit), form = coalesce(input_products.form, excluded.form),\n"
      f"    npk = coalesce(input_products.npk, excluded.npk), nutrients = coalesce(input_products.nutrients, excluded.nutrients), notes = coalesce(input_products.notes, excluded.notes),\n"
      f"    label_url = coalesce(input_products.label_url, excluded.label_url), pesticide = input_products.pesticide or excluded.pesticide;")
w('')
w('-- Nursery 2026 logs (Spray Log, Feed Log). Re-running replaces them.')
w(f"delete from ops_logs where module = 'nursery' and notes like '{TAG}%';")
for x in logs:
    w(f"insert into ops_logs (module, kind, site, area, log_on, start_at, end_at, sqft, spray_type, water_gal, applicator, products, method, notes) values "
      f"('nursery', '{x['kind']}', '1PN', {q(x['area'])}, '{x['log_on']}', {q(x['start'])}, {q(x['end'])}, {q(x['sqft'])}, {q(x['spray_type'])}, {q(x['water'])}, {q(x['app'])}, "
      f"{q(json.dumps(x['products']))}::jsonb, {q(x['method'])}, {q(x['note'])});")
w('')
if recipe:
    w(f"insert into ops_recipes (module, kind, name, method, products, notes, sort) values ('nursery', 'feed', 'Baseline foliar (per gal)', 'Foliar feed', {q(json.dumps(recipe))}::jsonb, "
      f"'Universal per-gallon baseline from the 2026 Feed Log', 1) on conflict (module, name) do update set products = excluded.products;")
w(open('tools/037_products_tail.sql').read())
sys.stdout.write('\n'.join(out))
sys.stderr.write(f'{len(products)} products, {len(logs)} logs ({sum(1 for x in logs if x["kind"] == "spray")} spray), {len(rows)} product lines, recipe {len(recipe)} lines\n')
