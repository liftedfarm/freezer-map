-- 136: D999 back on its METRC tag …7195 (Aziz 10/30). Aziz changed …7195's item in METRC to
--   Lifted Farms (FL26GV) - Cadillac Rainbows - OCAL Bucked Dry Flower (checked in METRC: 330 lb on that item), so the
--   repackage onto …7196 (to-do #649, METRC answered 400 twice, nothing made) isn't needed. …7196 stays unused.
begin;
update pallets set package_tag = '1A4060300030F35000007195', tag_pending = false, updated_at = now()
 where id = 1858 and code = 'D999' and package_tag = '1A4060300030F35000007196';
update comp_metrc_actions set status = 'done', push_state = null, done_by = 'aziz@lifted-organics.com', done_at = now(),
       note = 'Not needed: Aziz changed …7195''s item to Bucked Dry Flower in METRC instead. D999 stays on …7195; …7196 unused.'
 where id = 649 and status in ('todo', 'error');
insert into events (user_email, type, pallet_id, note, details)
values ('aziz@lifted-organics.com', 'tag_audit', 1858, 'Back on …7195: item changed in METRC to Bucked Dry Flower instead of repackaging onto …7196',
        jsonb_build_object('from', '1A4060300030F35000007196', 'to', '1A4060300030F35000007195'));
select code, right(package_tag, 6) tag, product, item_id, current_weight from pallets where id = 1858;
select id, status, note from comp_metrc_actions where id = 649;
commit;
