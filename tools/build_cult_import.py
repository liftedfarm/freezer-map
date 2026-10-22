"""Turn the extracted cultivation workbooks (cult_extract.py output) into one SQL import for Supabase.

Usage: python3 -I tools/build_cult_import.py <cult.json> <out.sql> "<label>"

What it loads (crop year 2026 unless noted):
  strains        new strain names and other spellings (aliases), Roshi names
  plantings      Farm Data "Clone Planting" + "Biomass #1/#2" (OHR), Strain Selections "GVPlanting" (GVR),
                 with nursery and projected lbs/plant from the Data Tapes
  harvests       Harvest Scheduling "OHR", "GVR", "OHR Biomass" logs, with actuals from Farm Data
                 "Harvest METRC", "Raw Weights", "Clone Dry Harvest" (OHR) and the GVR Data Tape
  pallets        freezer pallets get linked to their harvest (strain + field + harvest date)
  tests          area composite and dry flower strain test entries
  flower picks   dry lbs wanted per strain
  plan           2026 Clone Crop Plan + Field Trials, nursery deliveries, plant receiving
  history        2024 and 2025 Data Tape yields
"""
import datetime as dt
import json
import re
import sys

src, out_f, label = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(src))
YEAR = 2026

# other spellings -> the name to use
ALIAS = {
    'Blue Nerds': 'Blue Nerdz', 'Canal St. Runtz': 'Canal St Runtz', 'Canal St. Runtz x Oreoz5 #41': 'Canal St Runtz x Oreoz #41',
    "Coup' d'tat": "Coup D'etat", 'Diable Haze': 'Madd Fruit', 'Diablo Haze': 'Madd Fruit', 'Diable Haze (Madd Fruit)': 'Madd Fruit',
    'Diesel Daiquiri (Fatso x Nam Wah #37)': 'Diesel Daiquiri', 'Fatso x Nam Wah #37': 'Diesel Daiquiri',
    'Gabilan Guava (Hive x R.G. #12)': 'Gabilan Guava', 'The Hive x Rainbow Guava #12': 'Gabilan Guava',
    'Heavy Zest (Fatso x Nam Wah #27)': 'Heavy Zest',
    'Honeycomb Rainbow (Hive x R.G. #1)': 'Honeycomb Rainbow', 'The Hive x Rainbow Guava #1': 'Honeycomb Rainbow',
    'Molten Grapes (MB x BP x P #5)': 'Molten Grapes', 'NamBuster (Fatso x Nam Wah #9)': 'NamBuster', 'Fatso x Nam Wah #9': 'NamBuster',
    'Turbo Snax (MB x BP x P #9)': 'Turbo Snax', 'Violet Torque (Newport Punch #6)': 'Violet Torque', 'Newport Punch #6': 'Violet Torque',
    'Newport Punch (Newport Punch #28)': 'Newport Punch #28',
    'Government Oasis x Pack Mule #15': 'Governmint Oasis x Pack Mule #15', 'Government Oasis x Pack Mule #9': 'Governmint Oasis x Pack Mule #9',
    'Grape Gas x LOG': 'Grape Gas x OG', 'Mimosa Punch x LOG': 'Mimosa Punch x OG', 'Wedding Cake x Banana': 'Wedding Cake x Banana OG',
    'Limebelts x Hashburger #19': 'Lime Belts x Hashburger #19', 'Limebelts x Hashburger #38': 'Lime Belts x Hashburger #38',
    'Morrocan Peaches x Donny Burger #54': 'Moroccan Peaches x Donny Burger #54', 'Morrocan Peaches x Donny Burger #73': 'Moroccan Peaches x Donny Burger #73',
    'Morrocan Peaches x Donny Burger #74': 'Moroccan Peaches x Donny Burger #74', 'Morrocan Peaches x Donny Burger #79': 'Moroccan Peaches x Donny Burger #79',
    'SBC 26 x PM #31': 'SBC26 x Permanent Marker #31', 'SBC 26 x PM #34': 'SBC26 x Permanent Marker #34',
    'SFVOG x Lemon Kush': 'SFV OG x Lemon Kush', 'The Big Easy': 'The Big Easy #9',
    'Tropicanna Cookies x Honey Banana': 'Trop Cookies x Honey Banana #6', 'Wilson Zero #1': '#1 Wilson Zero',
    'Dragon Fruit Soda': 'Dragonfruit Soda', 'Sour Diesel': 'Sour Diesel (East Coast)', 'Guava Tart': 'Guava Tartz', '4k': '4K',
}
MIXUP = {'Slapz Mix up': 'Slapz', 'Madd Fruit Mix up': 'Madd Fruit'}
SKIP = {'Field Trials - 46 Strains', 'Totals:', None, ''}
flags = []


def canon(s):
    if s is None:
        return None
    s = re.sub(r'\s+', ' ', str(s)).strip()
    s = MIXUP.get(s, s)
    return ALIAS.get(s, s)


def key(s):
    return (canon(s) or '').lower()


def fkey(site, z):
    """'Block 1- A' / 'Field 8A' / '1a' -> '1A' (same idea as norm_field in the database)"""
    z = re.sub(r'(block|field|zone|[^a-z0-9/])', '', str(z or '').lower())
    return f'{site}:{z}'


def q(v):
    if v is None:
        return 'null'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return repr(round(v, 4)) if isinstance(v, float) else str(v)
    if isinstance(v, list):
        return "'{" + ','.join(str(round(x, 2)) for x in v) + "}'::numeric[]"
    return "'" + str(v).replace("'", "''") + "'"


def ival(v):
    return int(round(v)) if isinstance(v, (int, float)) else None


def days(a, b):
    return abs((dt.date.fromisoformat(a) - dt.date.fromisoformat(b)).days)


def values(rows):
    return ',\n'.join('(' + ','.join(q(x) for x in r) + ')' for r in rows)


# ---------- strains ----------
used = set()
def use(s):
    c = canon(s)
    if c not in SKIP:
        used.add(c)
    return c


# ---------- plantings ----------
tape = {}
for t in d['tape_2026']:
    tape.setdefault((key(t['strain']), fkey(t['site'], t['field'])), []).append(t)
recv = {(key(r['strain']), r['batch'] or 1): r for r in d['receiving']}

plantings = []   # site, zone, strain, batch, source, nursery, planted_on, plants, loss, spacing, beds, acres, license, first_flower, lpp, seed_lbs, notes
for r in d['ohr_plantings']:
    if not r['strain'] or not r['plants']:
        continue
    cands = tape.get((key(r['strain']), fkey('OHR', r['zone'])), [])
    t = min(cands, key=lambda t: days(t['planted'], r['planted']) if t['planted'] and r['planted'] else 99) if cands else None
    rc = recv.get((key(r['strain']), r['batch'] or 1))
    notes = '; '.join(x for x in (r['notes'], r['adj'] and f"Adjustment: {r['adj']}", r['testing'] and f"Testing: {r['testing']}") if x) or None
    plantings.append(('OHR', r['zone'], use(r['strain']), ival(r['batch']), 'seed' if (rc and (rc['source'] or '').lower() == 'seed') else 'clone',
                      (t and t['nursery']) or (rc and rc['nursery']), r['planted'], ival(r['plants']), ival(r['loss']), r['spacing'], r['beds'], None,
                      r['license'], r['first_flower'], t and t['lpp'], None, notes))
for r in d['ohr_biomass']:
    if not r['strain'] or not r['planted']:
        continue
    plantings.append(('OHR', r['zone'], use(r['strain']), ival(r['batch']), 'auto' if 'auto' in r['strain'].lower() else 'seed', None, r['planted'],
                      ival(r['plants']), None, r['spacing'], None, r['acres'], r['license'], r['first_flower'], None, r['seed_lbs'],
                      '; '.join(x for x in (r['notes'], f"from {r['src']}") if x)))
for r in d['gvr_plantings']:
    cands = tape.get((key(r['strain']), fkey('GVR', r['zone'])), [])
    t = cands[0] if cands else None
    plantings.append(('GVR', r['zone'], use(r['strain']), None, 'clone', t and t['nursery'], r['planted'], ival(r['plants']), ival(r['loss']),
                      r['spacing_ft'] * 12 if r['spacing_ft'] else None, r['beds'], r['acres'], r['license'], r['first_flower'], t and t['lpp'], None, r['notes']))

# ---------- harvests ----------
metrc = [dict(m, used=False) for m in d['metrc'] if m['strain']]
raw = d['raw_weights']
dry = d['dry_harvests']
gvr_tape = [dict(t, used=False) for t in d['tape_2026'] if t['site'] == 'GVR']


def mtype(t):
    return 'dry' if (t or '').lower().startswith('dry') else 'ff'


harvests = []   # site, field, strain, kind, status, planned_on, plants, lpp, rawpp, deleaf, buck, conv, acres, ypa, merge, harvest_days, harvested_on, plants_harvested, bins, raw_lbs, ff_lbs, bucked, trim, mold, metrc_name, notes
log = [dict(r, s=use(r['strain']), act=None, actual_field=None) for r in d['harvest_log'] if r['strain']]


def take(r, m):
    m['used'] = True
    r['act'] = m
    if fkey('OHR', m['zone']) != fkey('OHR', r['field']):
        r['actual_field'] = m['zone']


# pass 1: same strain, field and type, closest date (3 weeks at most); pass 2: same strain and type in another field (1 week)
for exact, limit in ((True, 21), (False, 7)):
    for r in log:
        if r['site'] != 'OHR' or r['act'] or not r['date']:
            continue
        cands = [m for m in metrc if not m['used'] and key(m['strain']) == key(r['s']) and mtype(m['type']) == r['kind'] and m['date']
                 and (fkey('OHR', m['zone']) == fkey('OHR', r['field'])) == exact]
        if cands:
            m = min(cands, key=lambda m: days(m['date'], r['date']))
            if days(m['date'], r['date']) <= limit:
                take(r, m)

for r in log:
    s = r['s']
    note = r['notes']
    field = r['field']
    if r['strain'] in MIXUP:
        note = '; '.join(x for x in (note, f"Logged as \"{r['strain']}\"") if x)
        flags.append(f"{r['site']} {r['field']} {r['date']}: \"{r['strain']}\" imported as {s} (mix up)")
    act = dict(on=None, plants=None, bins=[], raw=None, ff=None, bucked=None, trim=None, mold=None, name=None)
    if r['site'] == 'OHR':
        m = r['act']
        if m:
            act.update(on=m['date'], plants=m['plants'] if isinstance(m['plants'], (int, float)) else r['plants'], raw=m['raw'],
                       ff=m['frozen'] if r['kind'] == 'ff' else None, name=m['name'])
            if r['actual_field']:
                field = r['actual_field']
                note = '; '.join(x for x in (note, f"Scheduled for field {r['field']}, harvested from {m['zone']} (Harvest METRC)") if x)
                flags.append(f"OHR {s} {r['date']}: scheduled for {r['field']}, harvested from {m['zone']}")
        if r['kind'] == 'dry':
            for x in dry:
                if key(x['strain']) == key(s) and fkey('OHR', x['zone']) == fkey('OHR', field):
                    act.update(on=act['on'] or x['date'], plants=act['plants'] or x['plants'], raw=act['raw'] or x['raw'],
                               bucked=x['bucked'], trim=x['trim'], mold=x['mold'])
    else:
        for t in gvr_tape:
            if t['used'] or key(t['strain']) != key(s) or fkey('GVR', t['field']) != fkey('GVR', r['field']):
                continue
            if r['kind'] == 'ff' and t['ff_date'] and t['ff_lbs']:
                t['used'] = True
                act.update(on=t['ff_date'], plants=t['ff_plants'], ff=t['ff_lbs'])
                break
            if r['kind'] == 'dry' and t['dry_date']:
                act.update(on=t['dry_date'], plants=t['dry_plants'])
                break
    if act['on']:
        bins = [w for w in raw if key(w['strain']) == key(s) and fkey(r['site'], w['zone']) == fkey(r['site'], field) and w['date'] == act['on']
                and mtype(w['type']) == r['kind']]
        if bins:
            act['bins'] = bins[0]['bins']
            raw.remove(bins[0])
    harvests.append((r['site'], field, s, r['kind'], 'done' if act['on'] else 'planned', r['date'], ival(r['plants']), r['lpp'], r['rawpp'],
                     r['deleaf'], r['buck'], r['conv'], None, None, None, None, act['on'], ival(act['plants']), act['bins'],
                     act['raw'] if not act['bins'] or abs(sum(act['bins']) - (act['raw'] or 0)) > 1 else None, act['ff'],
                     act['bucked'], act['trim'], act['mold'], act['name'], note))
# METRC harvests that weren't on the schedule
for m in metrc:
    if m['used']:
        continue
    s = use(m['strain'])
    bins = [w for w in raw if key(w['strain']) == key(s) and fkey('OHR', w['zone']) == fkey('OHR', m['zone']) and w['date'] == m['date']]
    b = bins[0]['bins'] if bins else []
    if bins:
        raw.remove(bins[0])
    flags.append(f"OHR {m['zone']} {m['date']}: {s} harvest in Harvest METRC wasn't on the schedule; added as done")
    harvests.append(('OHR', m['zone'], s, mtype(m['type']), 'done', m['date'], ival(m['plants']), None, None, None, None, None, None, None,
                     None, None, m['date'], ival(m['plants']), b, m['raw'] if not b else None, m['frozen'] if mtype(m['type']) == 'ff' else None,
                     None, None, None, m['name'], 'Not on the harvest schedule (from Harvest METRC)'))
for r in d['biomass_log']:
    if not r['strain']:
        continue
    combine = (r['method'] or '').lower().startswith('combine')
    harvests.append(('OHR', r['field'], use(r['strain']), 'combine' if combine else 'strip', 'planned', r['cut'], None, None, None, None, None, None,
                     r['acres'], r['ypa'], ival(r['merge']) if combine else None, ival(r['harvest']) if combine else None,
                     None, None, [], None, None, None, None, None, None, r['notes']))

# ---------- tests ----------
area = [(t['site'], t['field'], t['lab'], t['submitted'], t['results'], t['result'], t['notes']) for t in d['area_tests']
        if any(t[k] for k in ('lab', 'submitted', 'results', 'result', 'notes'))]
strain_tests = [(t['site'], t['field'], use(t['strain']), t['lab'], t['submitted'], t['results'], t['result'], t['notes']) for t in d['strain_tests']]

# ---------- plan ----------
plan, orders = [], []
for i, r in enumerate(d['crop_plan']):
    if canon(r['strain']) in SKIP or r['farm'] not in ('OHR', 'GVR'):
        continue
    plan.append((i, r['farm'], use(r['strain']), r['nursery'], ival(r['plants']), r['spacing'], r['lpp'], False, r['notes']))
    for n, dd, pd in ((r['d1'], r['d1date'], r['p1date']), (r['d2'], r['d2date'], r['p2date'])):
        if n and n >= 1:
            orders.append((i, r['farm'], canon(r['strain']), r['nursery'], ival(n), dd, pd))
for j, r in enumerate(d['trials']):
    if canon(r['strain']) in SKIP:
        continue
    plan.append((1000 + j, r['farm'] or 'OHR', use(r['strain']), r['nursery'], ival(r['plants']), r['spacing'], r['lpp'], True, None))
receipts = [('OHR', use(r['strain']), ival(r['batch']) or 1, r['nursery'], 'seed' if (r['source'] or '').lower() == 'seed' else 'clone', r['date'],
             ival(r['received']), ival(r['rejected']) or 0) for r in d['receiving'] if canon(r['strain']) not in SKIP]

FARM = {'1363 GV': 'GVR', 'OHR': 'OHR'}
history = [(h['year'], FARM.get(h['farm'], h['farm'] or '?'), use(h['strain']), ival(h['plants']), h['lbs'], h['planted'], h['harvested'])
           for h in d['history'] if canon(h['strain']) not in SKIP]
picks = [(use(p['strain']), p['lbs']) for p in d['flower_picks']]

# roshi names (Data Tape "Roshi Strain") and alias pairs (Data Tape strain vs Roshi strain)
roshi = {}
pairs = set()
for t in d['tape_2026']:
    a, b = canon(t['strain']), canon(t['roshi'])
    if b and a and a.lower() != b.lower():
        pairs.add((t['roshi'], a))
    if a and t['roshi']:
        roshi[a] = t['roshi']
alias_rows = sorted({(k, v) for k, v in ALIAS.items()} | {(k, v) for k, v in MIXUP.items() if False} | pairs)
used -= SKIP
labs = [x for x in d['labs'] if x]

sql = f"""-- Cultivation import from {label}.
-- Run once in Supabase after 019_cultivation.sql: SQL Editor > New query > paste > Run.
-- Safe to re-run until someone starts editing cultivation data in the app (then it refuses, so nothing gets overwritten).
begin;
set local cult.import = 'on';

do $$
begin
  if exists (select 1 from cult_log where user_email not in ('unknown', 'import')) then
    raise exception 'Cultivation data has already been edited in the app. This import would overwrite it, so it stopped.';
  end if;
end $$;

-- start clean (only what an earlier run of this import added)
update pallets set harvest_id = null where harvest_id in (select id from cult_harvests where created_by = 'import');
delete from cult_tests where created_by = 'import';
delete from cult_harvests where created_by = 'import';
delete from cult_plantings where created_by = 'import';
delete from cult_receipts where created_by = 'import';
delete from cult_nursery_orders where created_by = 'import';
delete from cult_plan where created_by = 'import';
delete from cult_flower_picks where updated_by = 'import';
delete from cult_yield_history where source = 'import';

-- ---------- strains ----------
-- other spellings: add as an alias of the strain they belong to (adding that strain if it's new)
create temp table imp_alias (name text, canon text) on commit drop;
insert into imp_alias values
{values(alias_rows)};
insert into strains (name, aliases)
select distinct on (lower(a.canon)) a.canon, '{{}}' from imp_alias a
 where canonical_strain(a.canon) is null and canonical_strain(a.name) is null;
update strains s set aliases = s.aliases || array(select a.name from imp_alias a
       where canonical_strain(a.canon) = s.name and canonical_strain(a.name) is null)
 where exists (select 1 from imp_alias a where canonical_strain(a.canon) = s.name and canonical_strain(a.name) is null);

-- strains that aren't in the list yet
create temp table imp_strain (name text) on commit drop;
insert into imp_strain values
{values(sorted((x,) for x in used))};
insert into strains (name)
select distinct on (lower(name)) name from imp_strain where canonical_strain(name) is null;

-- Roshi strain names
create temp table imp_roshi (strain text, roshi text) on commit drop;
insert into imp_roshi values
{values(sorted(roshi.items()))};
update strains s set roshi_name = r.roshi from imp_roshi r
 where canonical_strain(r.strain) = s.name and s.roshi_name is null;

-- labs
insert into app_settings values ('cult.labs', {q('|'.join(labs))}) on conflict (key) do update set value = excluded.value;

-- ---------- plantings ----------
create temp table imp_planting (site text, zone text, strain text, batch int, source text, nursery text, planted_on date, plants int,
  plant_loss int, spacing_in numeric, beds numeric, acres numeric, license text, first_flower date, lpp numeric, seed_lbs numeric, notes text) on commit drop;
insert into imp_planting values
{values(plantings)};
insert into cult_plantings (crop_year, site, field_id, strain, batch, source, nursery, planted_on, plants, plant_loss, spacing_in, beds, acres,
  license, first_flower, est_lbs_per_plant, seed_lbs, notes, created_by)
select {YEAR}, site, field_id(site, zone), strain, batch, source, nursery, planted_on, plants, plant_loss, spacing_in, beds, acres,
       license, first_flower, lpp, seed_lbs,
       case when field_id(site, zone) is null and zone is not null then concat_ws('; ', notes, 'Field: ' || zone) else notes end, 'import'
  from imp_planting;

-- ---------- harvests ----------
create temp table imp_harvest (site text, field text, strain text, kind text, status text, planned_on date, plants int, lpp numeric, rawpp numeric,
  deleaf numeric, buck numeric, conv numeric, acres numeric, ypa numeric, merge int, hdays int, harvested_on date, plants_harvested int,
  bins numeric[], raw_lbs numeric, ff_lbs numeric, bucked numeric, trim numeric, mold numeric, metrc_name text, notes text) on commit drop;
insert into imp_harvest values
{values(harvests)};
insert into cult_harvests (crop_year, site, field_id, strain, kind, status, planned_on, plants, est_lbs_per_plant, est_raw_per_plant,
  deleaf_rate, buck_rate, dry_conversion, acres, est_yield_per_acre, days_to_merge, days_to_harvest, harvested_on, plants_harvested,
  raw_bins, raw_lbs, ff_lbs, bucked_lbs, trim_lbs, mold_lbs, metrc_name, notes, created_by)
select {YEAR}, site, field_id(site, field), strain, kind, status, planned_on, plants, lpp, rawpp, deleaf, buck, conv, acres, ypa, merge, hdays,
       harvested_on, plants_harvested, coalesce(bins, '{{}}'), raw_lbs, ff_lbs, bucked, trim, mold, metrc_name,
       case when field_id(site, field) is null and field is not null then concat_ws('; ', notes, 'Field: ' || field) else notes end, 'import'
  from imp_harvest;

-- each harvest belongs to the biggest planting of that strain in that field
update cult_harvests h set planting_id = (
  select p.id from cult_plantings p where p.crop_year = h.crop_year and p.site = h.site and p.field_id = h.field_id and p.strain = h.strain
   order by p.plants desc nulls last, p.id limit 1)
 where h.created_by = 'import';

-- ---------- link freezer pallets to their harvest ----------
-- same strain, same field, same harvest date
update pallets p set harvest_id = h.id
  from cult_harvests h
 where h.created_by = 'import' and h.kind = 'ff' and p.harvest_id is null and p.kind = 'package'
   and canonical_strain(p.strain) = h.strain and field_id(h.site, p.zone) = h.field_id
   and p.harvest_date = coalesce(h.harvested_on, h.planned_on)
   and not exists (select 1 from cult_harvests h2 where h2.created_by = 'import' and h2.kind = 'ff' and h2.id <> h.id and h2.strain = h.strain
                     and h2.field_id = h.field_id and coalesce(h2.harvested_on, h2.planned_on) = coalesce(h.harvested_on, h.planned_on));
-- then the closest planned harvest within 10 days for pallets still on their own
update pallets p set harvest_id = (
  select h.id from cult_harvests h
   where h.created_by = 'import' and h.kind = 'ff' and h.strain = canonical_strain(p.strain) and h.field_id = field_id(h.site, p.zone)
     and abs(coalesce(h.harvested_on, h.planned_on) - p.harvest_date) <= 10
   order by abs(coalesce(h.harvested_on, h.planned_on) - p.harvest_date), h.id limit 1)
 where p.harvest_id is null and p.kind = 'package' and p.harvest_date >= '{YEAR}-01-01' and p.strain is not null;
-- freezer pallets from a harvest that wasn't on the schedule or in Harvest METRC: add that harvest (done)
with g as (
  select case when p.code like 'G%' then 'GVR' else 'OHR' end as site, canonical_strain(p.strain) as strain, p.zone, p.harvest_date,
         count(*) as n, array_agg(p.id) as ids
    from pallets p
   where p.harvest_id is null and p.kind = 'package' and p.harvest_date >= '{YEAR}-01-01' and canonical_strain(p.strain) is not null
   group by 1, 2, 3, 4),
ins as (
  insert into cult_harvests (crop_year, site, field_id, strain, kind, status, planned_on, harvested_on, notes, created_by)
  select {YEAR}, g.site, field_id(g.site, g.zone), g.strain, 'ff', 'done', g.harvest_date, g.harvest_date,
         'Not on the harvest schedule (from ' || g.n || ' freezer pallet' || case when g.n > 1 then 's' else '' end || ')'
         || case when field_id(g.site, g.zone) is null then '; Field: ' || coalesce(g.zone, '?') else '' end, 'import'
    from g
  returning id, site, field_id, strain, harvested_on)
update pallets p set harvest_id = ins.id
  from ins where p.harvest_id is null and p.kind = 'package' and p.harvest_date = ins.harvested_on
   and canonical_strain(p.strain) = ins.strain and (case when p.code like 'G%' then 'GVR' else 'OHR' end) = ins.site
   and field_id(ins.site, p.zone) is not distinct from ins.field_id;
update cult_harvests h set planting_id = (
  select pl.id from cult_plantings pl where pl.crop_year = h.crop_year and pl.site = h.site and pl.field_id = h.field_id and pl.strain = h.strain
   order by pl.plants desc nulls last, pl.id limit 1)
 where h.created_by = 'import' and h.planting_id is null;
-- harvests with pallets are done
update cult_harvests h set status = 'done',
       harvested_on = coalesce(h.harvested_on, (select min(p.harvest_date) from pallets p where p.harvest_id = h.id))
 where h.created_by = 'import' and exists (select 1 from pallets p where p.harvest_id = h.id);

-- ---------- tests ----------
create temp table imp_area (site text, field text, lab text, submitted date, results date, result text, notes text) on commit drop;
{"insert into imp_area values" + chr(10) + values(area) + ";" if area else ""}
insert into cult_tests (crop_year, site, kind, field_id, lab, submitted_on, results_on, result, notes, created_by)
select {YEAR}, site, 'area', field_id(site, field), lab, submitted, results, result, notes, 'import'
  from imp_area where field_id(site, field) is not null;
create temp table imp_stest (site text, field text, strain text, lab text, submitted date, results date, result text, notes text) on commit drop;
{"insert into imp_stest values" + chr(10) + values(strain_tests) + ";" if strain_tests else ""}
insert into cult_tests (crop_year, site, kind, harvest_id, lab, submitted_on, results_on, result, notes, created_by)
select distinct on (h.id) {YEAR}, t.site, 'strain', h.id, t.lab, t.submitted, t.results, t.result, t.notes, 'import'
  from imp_stest t
  cross join lateral (
    select h.id from cult_harvests h
     where h.created_by = 'import' and h.kind = 'dry' and h.site = t.site and h.strain = coalesce(canonical_strain(t.strain), t.strain)
     order by (h.field_id = field_id(t.site, t.field)) desc nulls last, h.id limit 1) h
 order by h.id;

-- ---------- dry flower picks ----------
create temp table imp_pick (strain text, lbs numeric) on commit drop;
insert into imp_pick values
{values(picks)};
insert into cult_flower_picks (crop_year, strain, dry_lbs, updated_by)
select distinct on (lower(coalesce(canonical_strain(strain), strain))) {YEAR}, strain, lbs, 'import' from imp_pick
on conflict (crop_year, lower(strain)) do update set dry_lbs = excluded.dry_lbs;

-- ---------- 2026 plan, nursery deliveries, receiving ----------
create temp table imp_plan (k int, site text, strain text, nursery text, plants int, spacing numeric, lpp numeric, trial boolean, notes text) on commit drop;
insert into imp_plan values
{values(plan)};
create temp table imp_plan_ids (k int, id bigint) on commit drop;
with ins as (
  insert into cult_plan (crop_year, site, field_id, strain, nursery, plants, spacing_in, est_lbs_per_plant, trial, notes, created_by)
  select {YEAR}, site, case when trial then field_id('OHR', '3') end, strain, nursery, plants, spacing, lpp, trial, coalesce(notes, '') || '#k' || k, 'import'
    from imp_plan returning id, notes)
insert into imp_plan_ids select substring(notes from '#k(\\d+)$')::int, id from ins;
update cult_plan set notes = nullif(regexp_replace(notes, '#k\\d+$', ''), '') where created_by = 'import';
create temp table imp_order (k int, site text, strain text, nursery text, plants int, deliver_on date, plant_on date) on commit drop;
{"insert into imp_order values" + chr(10) + values(orders) + ";" if orders else ""}
insert into cult_nursery_orders (crop_year, plan_id, site, strain, nursery, plants, deliver_on, plant_on, status, created_by)
select {YEAR}, i.id, o.site, o.strain, o.nursery, o.plants, o.deliver_on, o.plant_on, 'received', 'import'
  from imp_order o left join imp_plan_ids i on i.k = o.k;
create temp table imp_receipt (site text, strain text, batch int, nursery text, source text, received_on date, received int, rejected int) on commit drop;
insert into imp_receipt values
{values(receipts)};
insert into cult_receipts (crop_year, site, strain, batch, nursery, source, received_on, received, rejected, created_by)
select {YEAR}, site, strain, batch, nursery, source, received_on, received, rejected, 'import' from imp_receipt;

-- ---------- older seasons ----------
create temp table imp_hist (crop_year int, site text, strain text, plants int, ff_lbs numeric, planted_on date, harvested_on date) on commit drop;
insert into imp_hist values
{values(history)};
insert into cult_yield_history (crop_year, site, strain, plants, ff_lbs, planted_on, harvested_on, source)
select crop_year, site, strain, plants, ff_lbs, planted_on, harvested_on, 'import' from imp_hist;

commit;

-- check
select (select count(*) from cult_plantings) as plantings, (select count(*) from cult_harvests) as harvests,
       (select count(*) from cult_harvests where status = 'done') as harvested,
       (select count(*) from pallets where harvest_id is not null) as pallets_linked,
       (select count(*) from cult_tests) as tests, (select count(*) from cult_plan) as plan_rows,
       (select count(*) from cult_yield_history) as history_rows;
"""
open(out_f, 'w').write(sql)
print(f'{len(plantings)} plantings, {len(harvests)} harvests, {len(area)} area tests, {len(strain_tests)} strain tests, '
      f'{len(plan)} plan rows, {len(orders)} deliveries, {len(receipts)} receipts, {len(history)} history, {len(used)} strains used')
print('\n'.join(flags))
