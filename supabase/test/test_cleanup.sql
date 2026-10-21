-- Removes the TEST freezer, the TEST pallets and everything made from them (splits, merges) plus their history.
begin;
create temp table t_pallets on commit drop as
with recursive fam(id) as (
  select id from pallets where code like 'TEST%'
  union
  select p.id from pallets p join fam on p.parent_id = fam.id or p.id = (select merged_into from pallets where id = fam.id)
)
select id from fam;
create temp table t_slots on commit drop as
  select s.id from slots s join freezers f on f.id = s.freezer_id where f.site = 'GVR' and f.number = 99;
do $$
begin
  if exists (select 1 from pallets where slot_id in (select id from t_slots) and id not in (select id from t_pallets)) then
    raise exception 'A real pallet is still in the TEST freezer. Move it out first.';
  end if;
end $$;
delete from events where pallet_id in (select id from t_pallets)
   or freezer_id in (select freezer_id from slots where id in (select id from t_slots))
   or from_slot_id in (select id from t_slots) or to_slot_id in (select id from t_slots);
update pallets set parent_id = null, merged_into = null where id in (select id from t_pallets);
delete from pallets where id in (select id from t_pallets);
delete from slots where id in (select id from t_slots);
delete from freezers where site = 'GVR' and number = 99;
-- reuse C numbers if only test merges used them
select setval('combined_pallet_seq', coalesce((select max(substring(code from 2)::int) from pallets where code ~ '^C[0-9]+$'), 0) + 1, false);
commit;
select 'cleaned up' as result, (select count(*) from pallets where code like 'TEST%') as test_pallets_left;
