#!/usr/bin/env python3
"""Build supabase/033_import_logs_inventory.sql from:
  - Farm Data OHR 2026.xlsx: Fertigation, Foliar, Inputs, Actions  -> ops_logs (Production, OHR)
  - WebbNursery_2027.xlsx: Greenhouse Data (SU26_Gen1)              -> nursery G1 mother lots + their cut batches

  python3 tools/import_farm_data.py FARM_DATA.xlsx WEBB_NURSERY_2027.xlsx supabase/033_import_logs_inventory.sql
Re-running the SQL replaces what it loaded before (ops_logs notes start with '[import FarmData2026]', nursery rows with '[import Webb2027]').
"""
import datetime as dt
import json
import re
import sys
import warnings

import openpyxl

warnings.filterwarnings('ignore')
TAG_LOG, TAG_N = '[import FarmData2026]', '[import Webb2027]'


def q(v):
    if v is None or v == '':
        return 'null'
    if isinstance(v, (int, float)):
        return repr(round(v, 4)) if isinstance(v, float) else str(v)
    return "'" + str(v).replace("'", "''") + "'"


def num(v):
    if v is None or v == '':
        return None
    if isinstance(v, (int, float)):
        return float(v)
    m = re.search(r'[\d.]+', str(v))
    return float(m.group()) if m else None


def day(v):
    if isinstance(v, (dt.datetime, dt.date)):
        return v.strftime('%Y-%m-%d')
    return None


UNIT = {'gallons': 'gal', 'gallon': 'gal', 'gal': 'gal', 'lbs': 'lb', 'lb': 'lb', 'oz': 'fl oz', 'fl oz': 'fl oz', 'ml': 'mL', 'grams': 'g', 'g': 'g', 'tons': 'ton'}


def unit(u):
    return UNIT.get(str(u).strip().lower(), str(u).strip()) if u else None


def line(product, mfr, rate, u, acres):
    r = num(rate)
    uu = unit(u)
    return {'product': str(product).strip(), 'manufacturer': (str(mfr).strip() if mfr else None), 'rate': r, 'unit': uu, 'basis': 'acre',
            'total': round(r * acres, 2) if r is not None and acres else None, 'total_unit': uu}


def logs(path):
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    out = []

    # ---- fertigation: a new log starts on a row with a date or a gallons figure
    cur, date = None, None
    for r in wb['Fertigation'].iter_rows(min_row=2, values_only=True):
        r = list(r) + [None] * 14
        if day(r[0]):
            date = day(r[0])
        if not date:
            continue
        if r[2] or day(r[0]) or (r[3] and cur and r[3] != cur['area'] and r[6]):
            acres = num(r[4])
            cur = {'kind': 'feed', 'method': 'Fertigation', 'log_on': date, 'area': (r[3] or '').strip() or None, 'acres': acres,
                   'water_gal': num(r[2]), 'run_min': num(r[5]), 'products': [], 'notes': r[12]}
            out.append(cur)
        if cur and r[6]:
            cur['products'].append(line(r[6], r[7], r[8], r[9], cur['acres'] or num(r[4])))

    # ---- foliar: new log on a date or a new location
    cur, date = None, None
    for r in wb['Foliar'].iter_rows(min_row=2, values_only=True):
        r = list(r) + [None] * 16
        if day(r[2]):
            date = day(r[2])
        if not date:
            continue
        if day(r[2]) or r[5]:
            acres = num(r[6])
            typ = (r[4] or (cur or {}).get('spray_type') or 'Feed')
            cur = {'kind': 'spray', 'method': 'Foliar', 'spray_type': str(typ).strip(), 'log_on': date, 'area': (str(r[5]).strip() if r[5] else None), 'acres': acres,
                   'products': [], 'notes': r[14]}
            out.append(cur)
        if cur and r[7]:
            cur['products'].append(line(r[7], r[8], r[9], r[10], cur['acres'] or num(r[6])))

    # ---- inputs (amendments, side dress): vendor header rows, then dated rows
    vendor, date = None, None
    for r in wb['Inputs'].iter_rows(min_row=2, values_only=True):
        r = list(r) + [None] * 8
        if r[0] and not day(r[0]) and not r[1]:
            vendor = str(r[0]).strip()
            continue
        if day(r[0]):
            date = day(r[0])
        if not date or not r[1]:
            continue
        acres = num(r[4])
        rate_txt = str(r[2] or '')
        rate = num(rate_txt)
        u = unit(re.sub(r'[\d.\s]+', '', rate_txt)) if rate_txt else None
        out.append({'kind': 'feed', 'method': 'Amendment / side dress', 'log_on': date, 'area': (str(r[3]).strip() if r[3] else None), 'acres': acres,
                    'products': [{'product': str(r[1]).strip(), 'manufacturer': vendor, 'rate': rate, 'unit': u, 'basis': 'acre',
                                  'total': round(rate * acres, 2) if rate and acres else num(r[5]), 'total_unit': u}],
                    'applicator': vendor, 'notes': (f'Quantity {r[5]}' if r[5] else None)})

    # ---- actions -> labor
    for r in wb['Actions'].iter_rows(min_row=2, values_only=True):
        r = list(r) + [None] * 8
        if not day(r[2]) or not r[1]:
            continue
        t = str(r[3] or '').lower()
        h = num(t)
        if h is not None and 'min' in t:
            h = round(h / 60, 2)
        notes = str(r[6]).strip() if r[6] else None
        m = re.search(r'(\d+)\s*people', notes or '')
        out.append({'kind': 'labor', 'task': str(r[1]).strip(), 'log_on': day(r[2]), 'hours': h, 'equipment': (str(r[4]).strip() if r[4] else None),
                    'area': (str(r[5]).strip() if r[5] else None), 'crew': int(m.group(1)) if m else None, 'notes': notes, 'products': []})
    return out


def nursery(path):
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    ws = wb['Greenhouse Data']
    rows = list(ws.iter_rows(values_only=True))
    head = [str(h).strip() if h else '' for h in rows[0]]
    ix = {h: i for i, h in enumerate(head)}
    out = []
    for r in rows[1:]:
        g = lambda k: r[ix[k]] if k in ix and ix[k] < len(r) else None
        if not g('Strain') or not g('Generation'):
            continue
        out.append({k: g(k) for k in ix})
    return out


def main():
    farm, webb, dest = sys.argv[1:4]
    L = logs(farm)
    N = nursery(webb)
    s = [f"""-- Migration 033: imports. Run after 032. Safe to re-run (replaces what it loaded before).
--  1. Production logs from Farm Data OHR 2026 (Fertigation, Foliar, Inputs, Actions): {len(L)} logs.
--  2. Nursery mother inventory from WebbNursery_2027 (Greenhouse Data, SU26_Gen1 = G1 for the 2027 season): {len(N)} lots, with their cut batches.
set client_min_messages = warning;

-- ---------- 1. Production logs ----------
alter table ops_logs disable trigger ops_logs_audit;
delete from ops_logs where notes like '{TAG_LOG}%';
insert into ops_logs (module, kind, site, area, log_on, method, spray_type, acres, water_gal, run_min, products, task, hours, crew, equipment, applicator, notes) values"""]
    vals = []
    for x in L:
        note = TAG_LOG + (f" {x['notes']}" if x.get('notes') else '')
        vals.append(f"  ('cultivation', {q(x['kind'])}, 'OHR', {q(x.get('area'))}, {q(x['log_on'])}, {q(x.get('method'))}, {q(x.get('spray_type'))}, {q(x.get('acres'))}, "
                    f"{q(x.get('water_gal'))}, {q(x.get('run_min'))}, {q(json.dumps(x['products']))}::jsonb, {q(x.get('task'))}, {q(x.get('hours'))}, {q(x.get('crew'))}, "
                    f"{q(x.get('equipment'))}, {q(x.get('applicator'))}, {q(note)})")
    s.append(',\n'.join(vals) + ';')
    s.append("alter table ops_logs enable trigger ops_logs_audit;\n")

    # products seen in the logs go on the product list
    names = sorted({(p['product'], p.get('manufacturer') or '', p.get('unit') or '') for x in L for p in x['products'] if p['product']})
    seen = {}
    for n_, m_, u_ in names:
        seen.setdefault(n_.lower(), (n_, m_, u_))
    s.append("insert into input_products (name, manufacturer, rate_unit) values\n" + ',\n'.join(f"  ({q(n_)}, {q(m_ or None)}, {q((u_ + '/acre') if u_ else None)})" for n_, m_, u_ in seen.values())
             + "\non conflict (name) do nothing;\n")

    # ---- nursery
    s.append(f"""-- ---------- 2. Nursery: G1 mother lots (SU26_Gen1) on the greenhouse benches ----------
alter table nursery_mothers disable trigger nursery_mothers_audit;
alter table nursery_batches disable trigger nursery_batches_audit;
delete from nursery_mothers where notes like '{TAG_N}%';
delete from nursery_batches where notes like '{TAG_N}%';
""")
    for x in N:
        gen = str(x.get('Generation') or '')
        m = re.match(r'(SU|FL)(\d\d)_Gen(\d)', gen)
        if not m:
            continue
        g = int(m.group(3))
        season = 2000 + int(m.group(2)) + (1 if g < 3 else 0)
        bench = str(x.get('Bench') or '').strip()
        bn = re.search(r'\d+', bench)
        room = f"(select id from nursery_rooms where site = '1PN' and name = 'GH B{bn.group()}')" if bn else 'null'
        row = x.get('Row')
        qty = int(num(x.get('Final Mom Quantity')) or 0)
        tag = (str(x.get('Batch ID') or '').strip().upper() or None)
        planted = day(x.get('2nd Plant Date')) or day(x.get('1st Plant Date'))
        src = str(x.get('Source') or '').strip() or None
        notes = TAG_N + (f" {x.get('Notes')}" if x.get('Notes') else '')
        cut = day(x.get('Cut Date'))
        cuts = int(num(x.get('Cut')) or 0)
        rooted = num(x.get('Rooted Qty.'))
        test = num(x.get('Test Batch Qty.'))
        if test:
            notes += f' test batch {int(test)}'
        bvar = 'null'
        if qty == 0:
            # a generation that's been cut but has no counts or moms yet (FL26_Gen2 cut 10/11): a rooting batch, 36 standard cuts until counts are in
            if cut:
                n_cut = cuts or 36
                s.append(f"insert into nursery_batches (site, strain, name, gen, season, cut_on, cuttings, stage, ready_on, tags, room_id, notes) values "
                         f"('1PN', {q(str(x['Strain']).strip())}, {q(gen + ' ' + str(x['Strain']).strip())}, {g}, {season}, {q(cut)}, {n_cut}, 'rooting', "
                         f"{q((dt.date.fromisoformat(cut) + dt.timedelta(days=14)).isoformat())}, {q('{' + tag + '}' if tag else '{}')}, "
                         f"(select id from nursery_rooms where site = '1PN' and name = 'Trailer 4'), "
                         f"{q(notes + ('' if cuts else ' (cut count not entered yet: 36 standard cuts assumed)'))});")
            continue
        if cut and cuts:
            s.append(f"insert into nursery_batches (site, strain, name, gen, season, cut_on, cuttings, lost, stage, room_id, sort1_on, s1_vigorous, moved_out_on, notes) values "
                     f"('1PN', {q(str(x['Strain']).strip())}, {q(gen + ' ' + str(x['Strain']).strip())}, {g}, {season}, {q(cut)}, {cuts}, {max(0, cuts - int(rooted or 0))}, 'done', "
                     f"(select id from nursery_rooms where site = '1PN' and kind = 'trailer' order by sort limit 1), {q(day(x.get('1st Plant Date')))}, {q(int(rooted) if rooted is not None else None)}, "
                     f"{q(day(x.get('1st Plant Date')))}, {q(notes)});")
            bvar = "(select max(id) from nursery_batches)"
        s.append(f"insert into nursery_mothers (site, room_id, strain, plant_tag, started_on, qty, gen, season, bed, pot, cuts_per_plant, source, batch_id, notes) values "
                 f"('1PN', {room}, {q(str(x['Strain']).strip())}, {q(tag)}, {q(planted)}, {qty}, {g}, {season}, {q(f'Row {row}' if row else None)}, {q(x.get('Final Pot Size'))}, 20, "
                 f"{q(src)}, {bvar}, {q(notes)}) on conflict (plant_tag) do update set qty = excluded.qty, room_id = excluded.room_id, bed = excluded.bed, notes = excluded.notes;")
    s.append(f"""-- G2 batches cut from the G1 lot of the same strain
update nursery_batches b set mother_id = m.id from nursery_mothers m
 where b.gen = 2 and b.notes like '{TAG_N}%' and m.gen = 1 and m.notes like '{TAG_N}%' and lower(m.strain) = lower(b.strain) and b.mother_id is null;
""")
    s.append("""alter table nursery_mothers enable trigger nursery_mothers_audit;
alter table nursery_batches enable trigger nursery_batches_audit;

select (select count(*) from ops_logs where notes like '[import FarmData2026]%') as production_logs,
       (select count(*) from nursery_mothers where notes like '[import Webb2027]%') as g1_lots,
       (select coalesce(sum(qty), 0) from nursery_mothers where notes like '[import Webb2027]%') as g1_moms;
""")
    open(dest, 'w').write('\n'.join(s))
    print(len(L), 'logs;', len(N), 'nursery rows')


if __name__ == '__main__':
    main()
