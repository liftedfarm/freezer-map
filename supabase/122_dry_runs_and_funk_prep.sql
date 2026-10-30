-- 122: after the METRC website work on GVR 679 (10/29 night):
--   New items on 679: Lifted Farms (FL26OH) - Wilson Zero #1 - OCAL Bucked Dry Flower / OCAL Dry Trim,
--                     Lifted Farms (FL26OH) - Super Buff Cherry - OCAL Bucked Dry Flower / OCAL Dry Trim.
--   Packages: D7169 = 1A4060300030F35000007169 (611 lb bucked), DN8 = ...7171 (88.76 trim), DN4 = ...7172 (132 trim).
--   ABC...010000 adjusted -4,904.09 and ABC...0316 adjusted -785.26 (Weight Change Due to Moisture), both finished.
--   The app had D7169's tag mistyped (1A40603000F35000007169, missing "03").
-- Also: Swampwater's harvest date goes back to 10/03 (it was moved to 10/08 only for the send), and the OHR drying
-- location is pointed at Field 1-B just for the Funk Mintz send (that METRC harvest's drying location is Field 1-B).
begin;
update pallets set package_tag = '1A4060300030F35000007169', tag_pending = false, updated_at = now() where code = 'D7169';
update pallets set package_tag = '1A4060300030F35000007171', tag_pending = false, updated_at = now() where code = 'DN8' and package_tag is null;
update pallets set package_tag = '1A4060300030F35000007172', tag_pending = false, updated_at = now() where code = 'DN4' and package_tag is null;
update comp_metrc_actions set status = 'done', done_by = 'aziz@lifted-organics.com', done_at = now(), push_state = null,
       note = 'Done on the METRC website 10/29: 7169 611 lb bucked, 7171 88.76 lb trim from ABC...010000; source adjusted -4,904.09 (moisture) and finished'
 where id in (161, 162, 163) and status = 'todo';
insert into events (user_email, type, pallet_id, note, details)
select 'aziz@lifted-organics.com', 'tag_audit', id, 'METRC package made on the website 10/29', jsonb_build_object('tag', package_tag)
  from pallets where code in ('D7169', 'DN8', 'DN4');
update cult_harvests set harvested_on = '2026-10-03' where id = 19;
update metrc_location_map d set location = f.location, location_id = f.location_id
  from metrc_location_map f
 where d.license = 'CCL25-0000017' and d.app_kind = 'drying' and d.app_ref = 'OHR'
   and f.license = 'CCL25-0000017' and f.app_kind = 'field' and f.app_ref = '2';
select code, right(package_tag, 6) tag, current_weight from pallets where code in ('D7169','DN8','DN4');
commit;
