-- 145_cali_mist_cleanup.sql  (Msg TAG-14, 2026-10-30, run live by Claude after Aziz's go)
-- 1. Harvest 34 was a duplicate of harvest 139 (old "Cali Mintz" schedule import, renamed 10/27; Garrett re-entered
--    the 10/3 harvest as one 650.6 lb bin, confirmed by Aziz). Bin removed, harvest cancelled.
-- 2. Harvest 139 / METRC OHR-CaliMist-Frozen-100326: 680 wet, 590.8 packaged (P190), 0 waste, still active in METRC.
--    Queues "Record harvest waste" 89.2 lb and "Finish harvest" on the Compliance to-do list (#660 / #661).
begin;
delete from cult_weights where id = 367 and harvest_id = 34 and lbs = 650.6;
update cult_harvests set status = 'cancelled', stage = null, raw_bins = '{}', notes = 'Duplicate of harvest 139 (Cali Mist 10/3, OHR-CaliMist-Frozen-100326). Removed 10/30, Msg TAG-14.',
       updated_by = 'aziz@lifted-organics.com', updated_at = now()
 where id = 34 and status = 'planned';
update cult_harvests set waste_lbs = 89.2, updated_by = 'aziz@lifted-organics.com', updated_at = now() where id = 139;
insert into events (user_email, type, lbs, note, details)
select 'aziz@lifted-organics.com', 'harvest_waste', 89.2, 'OHR-CaliMist-Frozen-100326',
       jsonb_build_object('due', now(), 'site', 'OHR', 'batch', 'OHR-CaliMist-Frozen-100326', 'strain', 'Cali Mist', 'wet_lbs', 680, 'harvest_id', 139, 'packed_lbs', 590.8)
 where not exists (select 1 from comp_metrc_actions where harvest_id = 139 and kind = 'harvest_waste' and status in ('todo','error','done'));
insert into events (user_email, type, note, details)
select 'aziz@lifted-organics.com', 'harvest_finish', 'OHR-CaliMist-Frozen-100326',
       jsonb_build_object('due', now(), 'site', 'OHR', 'batch', 'OHR-CaliMist-Frozen-100326', 'strain', 'Cali Mist', 'harvest_id', 139)
 where not exists (select 1 from comp_metrc_actions where harvest_id = 139 and kind = 'harvest_finish' and status in ('todo','error','done'));
commit;
