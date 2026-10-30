-- 120: two app-only fixes from the 10/29 audit. No METRC writes.
-- DN1 Pressure (2,062.6 lb, Central Coast Processing): was entered as received back on 10/23 but hasn't come back.
--   Back to at_processor, out of the GVR reefer (R1A), product wet, item FL26-OH-OCAL-DH-Pressure (279).
-- P316 Hashburger (650 lb): closed by mistake in the 10/24 audit (its app tag ...010316 is a Garlic Grapes x Pack Mule #26
--   package in METRC). The real package is ABC...0001316, active on 017 and Available in Roshi.
--   Restored to OHR freezer 21 spot M (open), or staging if that spot is taken.
-- Run once in Supabase. Safe to re-run.
begin;

update pallets set status = 'at_processor', slot_id = null, product = 'wet', item_id = 279, updated_at = now()
 where code = 'DN1' and status = 'in_freezer';
insert into events (user_email, type, pallet_id, lbs, note, details)
select 'aziz@lifted-organics.com', 'tag_audit', id, current_weight,
       'Not received back from CCP yet; the 10/23 receipt was a mistake (inventory audit 10/29)', jsonb_build_object('processor', 'Central Coast Processing')
  from pallets where code = 'DN1';

update pallets p set status = case when exists (select 1 from pallets o where o.slot_id = 368 and o.status in ('in_freezer','unslotted') and o.id <> p.id)
                                   then 'unslotted' else 'in_freezer' end,
       slot_id = case when exists (select 1 from pallets o where o.slot_id = 368 and o.status in ('in_freezer','unslotted') and o.id <> p.id)
                      then null else 368 end,
       current_weight = 650, package_tag = m.label, tag_pending = false, needs_review = null, updated_at = now()
  from metrc_packages m
 where p.code = 'P316' and p.status = 'depleted'
   and m.license = 'CCL25-0000017' and m.state = 'active' and m.label like 'ABC%0001316' and m.item ilike '%Hashburger%';
insert into events (user_email, type, pallet_id, lbs, note, details)
select 'aziz@lifted-organics.com', 'tag_audit', id, current_weight,
       'Restored: closed by mistake 10/24. METRC package is the 0001316 tag (inventory audit 10/29)', jsonb_build_object('tag', package_tag)
  from pallets where code = 'P316';

-- nothing from this should reach METRC
update comp_metrc_actions set status = 'done', done_by = 'aziz@lifted-organics.com', done_at = now(),
       note = 'App-only fix (inventory audit 10/29). Nothing to send.'
 where status = 'todo' and pallet_id in (select id from pallets where code in ('DN1', 'P316'));

select p.code, p.status, s.code as spot, p.current_weight, p.product, right(p.package_tag, 7) as tag_end
  from pallets p left join slots s on s.id = p.slot_id where p.code in ('DN1', 'P316');
commit;
