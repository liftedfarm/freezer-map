-- 133: D999-1 (Cadillac Rainbows, 36.75 lb, split off D999 by Rama 10/30) is trim, not bucked. App only (Aziz 10/30).
-- Its item was already set to Lifted Farms (FL26GV) - Cadillac Rainbows - OCAL Dry Trim (item 268) by the New package
-- button; only the product stayed "bucked". METRC to-do #639 (the split) is untouched: it's waiting on a trim item that
-- exists on GVR (CCL21-0000679) in METRC.
begin;
update pallets set product = 'trim', updated_at = now()
 where id = 2077 and code = 'D999-1' and product = 'bucked';
insert into events (user_email, type, pallet_id, note, details)
select 'aziz@lifted-organics.com', 'product_set', id, 'Product is trim (split off D999 as trim)', jsonb_build_object('from', 'bucked', 'to', 'trim')
  from pallets where id = 2077;
select code, strain, product, item_id, current_weight, right(package_tag, 6) tag from pallets where id = 2077;
commit;
