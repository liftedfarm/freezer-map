-- 131: P851 Sour Diesel starting weight back to Jordan's 10/28 harvest (536.92). App only (Aziz 10/30).
-- The weight on the pallet is already 536.92 in the app and METRC; only og_weight was left at 144.9
-- from the 10/28 5:23 PM step that was undone at 5:31 PM.
begin;
update pallets set og_weight = 536.92, updated_at = now()
 where code = 'P851' and og_weight = 144.9;
insert into events (user_email, type, pallet_id, note, details)
select 'aziz@lifted-organics.com', 'harvest_fix', id, 'Starting weight back to Jordan''s harvest (536.92); 144.9 was a step that got undone (Aziz 10/30)',
       jsonb_build_object('og_weight', jsonb_build_object('from', 144.9, 'to', 536.92))
  from pallets where code = 'P851';
select code, og_weight, current_weight from pallets where code = 'P851';
commit;
