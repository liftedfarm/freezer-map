"""Build a non-destructive sync SQL from an updated Freezer Map workbook.

It never moves pallets or touches history. It only:
  - adds pallets that are on the map but not in the app (placed in their slot)
  - fills in strain / weight / tag / dates on pallets the app has without them
  - clears import flags that the updated sheet no longer has
  - adds strains that aren't in the Strains list
and finally lists pallets where the sheet and the app disagree on location (for a person to check).

Usage: python3 tools/sync_from_sheet.py <workbook.xlsm> <out.sql> "<label>"
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

src, out, label = sys.argv[1], sys.argv[2], sys.argv[3]
tmp = Path(tempfile.mkdtemp())
subprocess.run([sys.executable, '-I', str(Path(__file__).with_name('build_seed.py')), src, str(tmp)], check=True, capture_output=True)
d = json.loads((tmp / 'web' / 'demo' / 'demo-data.json').read_text())
fz = {f['id']: f for f in d['freezers']}
sl = {s['id']: s for s in d['slots']}


def q(v):
    if v is None:
        return 'null'
    if isinstance(v, (int, float)):
        return repr(round(v, 2))
    return "'" + str(v).replace("'", "''") + "'"


rows = []
for p in d['pallets']:
    if not p['slot_id']:
        continue
    s = sl[p['slot_id']]
    f = fz[s['freezer_id']]
    rows.append('(' + ','.join(q(x) for x in [
        p['code'], p.get('label'), p.get('strain'), p.get('zone'), p.get('harvest_date'), p.get('planting_date'),
        p.get('og_weight'), p.get('current_weight'), p.get('package_tag'), p.get('needs_review'), p.get('notes'),
        f['site'], f['number'], s['code']]) + ')')

sql = f"""-- Sync from {label}. Adds and fills in only; never moves pallets or deletes history. Safe to re-run.
begin;

create temp table sheet (code text, label text, strain text, zone text, harvest_date date, planting_date date,
  og_weight numeric, current_weight numeric, package_tag text, needs_review text, notes text,
  site text, freezer int, slot_code text) on commit drop;
insert into sheet values
{(',' + chr(10)).join(rows)};

create temp table sheet_slot on commit drop as
  select sh.*, s.id as slot_id from sheet sh
    join freezers f on f.site = sh.site and f.number = sh.freezer
    join slots s on s.freezer_id = f.id and s.code = sh.slot_code;

-- 1. fill in missing info on pallets the app already has
create temp table filled on commit drop as
  select p.id, p.code, p.strain as old_strain, p.current_weight as old_w, x.strain, x.current_weight
    from pallets p join sheet_slot x on x.code = p.code
   where (p.strain is null and x.strain is not null)
      or (coalesce(p.current_weight, 0) = 0 and coalesce(x.current_weight, 0) > 0)
      or (p.package_tag is null and x.package_tag is not null and not p.tag_pending);
update pallets p set
    strain = coalesce(p.strain, x.strain),
    zone = coalesce(p.zone, x.zone),
    harvest_date = coalesce(p.harvest_date, x.harvest_date),
    planting_date = coalesce(p.planting_date, x.planting_date),
    og_weight = case when coalesce(p.og_weight, 0) = 0 then x.og_weight else p.og_weight end,
    current_weight = case when coalesce(p.current_weight, 0) = 0 then x.current_weight else p.current_weight end,
    package_tag = coalesce(p.package_tag, x.package_tag),
    needs_review = case when p.needs_review like 'Missing strain or weight%' and x.needs_review is null then null else p.needs_review end,
    updated_at = now()
  from sheet_slot x where x.code = p.code and p.id in (select id from filled);
insert into events (user_email, type, pallet_id, lbs, note, details)
select 'sheet sync', 'sheet_sync', f.id, f.current_weight, {q(label)},
       jsonb_build_object('filled', true, 'strain', f.strain, 'weight', f.current_weight)
  from filled f;

-- 2. add pallets that are on the map but not in the app
create temp table added on commit drop as
  select x.* from sheet_slot x where not exists (select 1 from pallets p where p.code = x.code);
insert into pallets (code, label, strain, zone, harvest_date, planting_date, og_weight, current_weight, package_tag,
                     status, slot_id, needs_review, notes)
select a.code, a.label, a.strain, a.zone, a.harvest_date, a.planting_date, a.og_weight, a.current_weight, a.package_tag,
       'in_freezer', a.slot_id,
       nullif(concat_ws('; ', a.needs_review,
         case when exists (select 1 from pallets o where o.slot_id = a.slot_id and o.container_id is null)
              then 'Added from the sheet into a slot that already had a pallet in the app' end), ''),
       a.notes
  from added a;
insert into events (user_email, type, pallet_id, to_slot_id, lbs, note)
select 'sheet sync', 'import', p.id, p.slot_id, p.current_weight, {q(label)}
  from pallets p join added a on a.code = p.code;

-- 3. clear import flags the updated sheet no longer has
create temp table cleared on commit drop as
  select p.id, p.needs_review from pallets p join sheet_slot x on x.code = p.code
   where p.needs_review is not null and x.needs_review is null
     and p.needs_review not like 'Added from the sheet%'
     and exists (select 1 from events e where e.pallet_id = p.id and e.type = 'import');
update pallets set needs_review = null, updated_at = now() where id in (select id from cleared);
insert into events (user_email, type, pallet_id, note, details)
select 'sheet sync', 'review_cleared', id, {q(label)}, jsonb_build_object('reason', needs_review) from cleared;

-- 4. strains list (if Settings is set up)
do $$
begin
  if to_regclass('public.strains') is not null then
    insert into strains (name)
    select distinct on (lower(trim(p.strain))) trim(p.strain) from pallets p
     where p.strain is not null and trim(p.strain) <> ''
       and not exists (select 1 from strains s where lower(s.name) = lower(trim(p.strain))
                                              or lower(trim(p.strain)) = any(select lower(a) from unnest(s.aliases) a));
  end if;
end $$;

-- results
select 'filled in' as what, count(*) from filled
union all select 'added', count(*) from added
union all select 'flags cleared', count(*) from cleared;

select x.code, x.site || ' F' || x.freezer || ' · ' || x.slot_code as sheet_says,
       coalesce(f.site || ' F' || f.number || ' · ' || s.code, p.status) as app_says
  from sheet_slot x join pallets p on p.code = x.code
  left join slots s on s.id = p.slot_id left join freezers f on f.id = s.freezer_id
 where p.slot_id is distinct from x.slot_id and p.container_id is null
 order by 1;

commit;
"""
Path(out).write_text(sql)
print(f'{len(rows)} pallets on the map -> {out}')
