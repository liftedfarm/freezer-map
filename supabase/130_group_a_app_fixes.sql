-- 130: Group A app-only fixes (approved by Aziz 10/30). No METRC changes.
--  1. Add 7 split bags that are active in METRC at OHR but missing from the app (none ever left on a manifest).
--  2. Rename P0759 -> P759.
--  3. Close 5 x 20 lb splits that already shipped in METRC (P228-1, P253-3, P379-1, P567-1, P658-2).
begin;

-- 1. split bags
with b(parent_code, suffix) as (values
  ('P59','000338'), ('P116','000339'), ('P126','000389'), ('P401','000391'),
  ('P217','000398'), ('P487','000487'), ('P189','000321')
), src as (
  select b.parent_code, p.*, m.label as mlabel, m.lbs as mlbs
    from b
    join pallets p on p.code = b.parent_code
    join metrc_packages m on m.license = 'CCL25-0000017' and m.state = 'active'
                         and m.label like '%AD3D000' || b.suffix
), nums as (
  select s.*, (select coalesce(max(nullif(split_part(c.code, '-', 2), '')::int), 0)
                 from pallets c where c.code like s.parent_code || '-%' and split_part(c.code, '-', 2) ~ '^\d+$') + 1 as n
    from src s
)
insert into pallets (code, strain, zone, harvest_date, og_weight, current_weight, package_tag, parent_id, status,
                     kind, harvest_id, origin_site, product, crop_year, item_id, lot_id, pushed)
select parent_code || '-' || n, strain, zone, harvest_date, mlbs, mlbs, mlabel, id, 'unslotted',
       'package', harvest_id, origin_site, product, crop_year, item_id, lot_id, true
  from nums
 where not exists (select 1 from pallets x where x.package_tag = nums.mlabel);

insert into events (user_email, type, pallet_id, note, details)
select 'aziz@lifted-organics.com', 'restored', id,
       'Split bag active in METRC at OHR, never left on a manifest; added to the app (Aziz 10/30). Find and slot it.',
       jsonb_build_object('tag', package_tag, 'lbs', current_weight)
  from pallets where package_tag ~ 'AD3D000(000338|000339|000389|000391|000398|000487|000321)$' and created_at > now() - interval '5 minutes';

-- 2. rename
update pallets set code = 'P759', updated_at = now()
 where code = 'P0759' and not exists (select 1 from pallets where code = 'P759');

-- 3. close shipped splits
update pallets set status = 'shipped', slot_id = null, updated_at = now()
 where code in ('P228-1','P253-3','P379-1','P567-1','P658-2') and status <> 'shipped';
insert into events (user_email, type, pallet_id, note)
select 'aziz@lifted-organics.com', 'manifest_sync', id, 'Closed: already shipped in METRC (Group A cleanup 10/30)'
  from pallets where code in ('P228-1','P253-3','P379-1','P567-1','P658-2');

select code, status, current_weight, right(package_tag, 6) tag from pallets
 where package_tag ~ 'AD3D000(000338|000339|000389|000391|000398|000487|000321)$'
    or code in ('P759','P228-1','P253-3','P379-1','P567-1','P658-2')
 order by code;
commit;
