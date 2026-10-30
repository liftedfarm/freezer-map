-- 125: DN3 (Super Buff Cherry bucked, 513 lb) repackaged on the METRC website 10/29 night, per Aziz:
-- 1A4060300030F35000007150 (FL26GV item) > 1A4060300030F35000007173, item Lifted Farms (FL26OH) - Super Buff Cherry -
-- OCAL Bucked Dry Flower, package date 10/21. 7150 finished at 0.
-- Also logs that Canal St Runtz OHR-CanalStRuntz-Frozen-100826 was finished (to-do #577, queued with 124).
update pallets set package_tag = '1A4060300030F35000007173', updated_at = now() where code = 'DN3' and status = 'in_freezer';
insert into events (user_email, type, pallet_id, note, details)
select 'aziz@lifted-organics.com', 'tag_audit', id, 'Repackaged in METRC to the FL26OH item (7150 > 7173)',
       jsonb_build_object('from', '1A4060300030F35000007150', 'tag', '1A4060300030F35000007173')
  from pallets where code = 'DN3';
select code, right(package_tag, 6) tag, current_weight from pallets where code = 'DN3';
