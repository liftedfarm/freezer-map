-- 103: 2025 OHR item names, and W43 Euroz back in inventory.
--  1. Some 2025 OHR items are named "(FL25OHR)" in METRC, not "(FL25OH)" (and a few "Lifted Farm" without the s).
--     The app made every item's METRC name from the farm code, so those didn't match METRC. Each app item now takes
--     the METRC item name its own packages actually use (the most common one, active packages first), only where the
--     difference is OH/OHR or Farm/Farms. Nothing is sent to METRC.
--  2. W43 Euroz 2025 OHR (ABC...2043) was loaded archived on 10/20 with the old workbook pallets. METRC has 35.66 lb of it
--     active at the GVR hub and it's physically there: restored at GVR, Needs a spot, 35.66 lb.
-- Run once in Supabase after 102. Safe to re-run. The result lists what changed.
begin;

create temp table out103 (what text, detail text) on commit drop;

-- 1. item names
with used as (
  select p.item_id, m.item, count(*) filter (where m.state = 'active') as act, count(*) as n
    from pallets p join metrc_packages m on upper(trim(m.label)) = upper(trim(p.package_tag))
   where p.item_id is not null and m.item is not null
     and m.license in ('CCL25-0000017', 'CCL21-0000679', 'CCL25-0000175')
   group by 1, 2),
best as (
  select distinct on (item_id) item_id, item from used order by item_id, act desc, n desc, item),
fix as (
  select i.id, i.metrc_name as was, b.item as now from items i join best b on b.item_id = i.id
   where b.item <> i.metrc_name
     and lower(regexp_replace(regexp_replace(b.item, '\(FL(\d\d)OHR\)', '(FL\1OH)'), '^Lifted Farm ', 'Lifted Farms '))
       = lower(regexp_replace(regexp_replace(i.metrc_name, '\(FL(\d\d)OHR\)', '(FL\1OH)'), '^Lifted Farm ', 'Lifted Farms ')))
, upd as (update items i set metrc_name = f.now from fix f where i.id = f.id returning i.id, f.was, f.now)
insert into out103 select 'item name', was || '  ->  ' || now from upd;

-- 2. W43
do $$
declare p pallets;
begin
  select * into p from pallets where upper(trim(package_tag)) = 'ABC06030007AD3D000002043';
  if p.id is null then insert into out103 values ('W43', 'not found: skipped');
  elsif p.status <> 'archived' then insert into out103 values ('W43', p.code || ' is ' || p.status || ': left as is');
  else
    insert into events (user_email, type, pallet_id, lbs, note, details)
    values (coalesce(current_email(), 'aziz@lifted-organics.com'), 'restored', p.id, 35.66,
            'METRC has 35.66 lb active at the GVR hub (received on 0010399469), physically at GVR',
            jsonb_build_object('from', p.current_weight, 'to', 35.66, 'to_site', 'GVR', 'was', 'archived'));
    update pallets set status = 'unslotted', slot_id = null, received_site = 'GVR', current_weight = 35.66, updated_at = now() where id = p.id;
    insert into out103 values ('W43', p.code || ' Euroz restored at GVR (Needs a spot), ' || p.current_weight || ' -> 35.66 lb');
  end if;
end $$;

select * from out103 order by what desc, detail;
commit;
