-- 135: New package "Same item" = the app's item (Aziz 10/30: D999 went to …7195 as Dry Unbucked because METRC had the old
--   package under that item, while the app has it as Bucked Dry Flower). The sender (api/metrc/_pkg.js) now uses the app's
--   item and stops if that item isn't on the license in METRC. This adds the lookup the form uses to show METRC's item
--   next to the app's when they differ. Safe to re-run.
begin;
create or replace function pallet_metrc_item(p_pallet_id bigint) returns text
language sql stable security definer set search_path = public as $$
  select m.item from metrc_packages m join pallets p on upper(m.label) = upper(p.package_tag)
   where p.id = p_pallet_id
   order by (m.state = 'active') desc, m.seen_at desc nulls last limit 1
$$;
revoke all on function pallet_metrc_item(bigint) from public, anon;
grant execute on function pallet_metrc_item(bigint) to authenticated;
select pallet_metrc_item(1858) as d999_metrc_item;
commit;
