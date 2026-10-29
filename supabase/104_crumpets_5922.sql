-- 104: Crumpets ...5922 (1A4060300030F35000005922) into the app.
-- METRC made it at the GVR hub by combining what was left of W161, W242, W243, W244 and W247 (all finished in METRC,
-- archived in the app). The app never had the new package. METRC has 50.4 lb of it active at the hub.
-- Added as W161-N at GVR, Needs a spot, 50.4 lb, Crumpets 2025 OHR (details from W161). App only. Safe to re-run.
begin;

do $$
declare src pallets; pc pallets; tag text := '1A4060300030F35000005922'; k int; code_ text;
begin
  if exists (select 1 from pallets where upper(trim(package_tag)) = tag) then
    raise notice '...5922 is already in the app as %', (select code from pallets where upper(trim(package_tag)) = tag); return;
  end if;
  select * into src from pallets where code = 'W161';
  if src.id is null then raise exception 'W161 not found: tell Claude (nothing was changed)'; end if;
  select coalesce(max(nullif(substring(code from '-(\d+)$'), '')::int), 0) + 1 into k from pallets where parent_id = src.id or code like src.code || '-%';
  code_ := src.code || '-' || k;
  while exists (select 1 from pallets where code = code_) loop k := k + 1; code_ := src.code || '-' || k; end loop;
  insert into pallets (code, strain, zone, harvest_date, planting_date, og_weight, current_weight, package_tag, status, slot_id, received_site,
                       parent_id, product, crop_year, origin_site, harvest_id, from_harvest, item_id, pushed, notes)
  values (code_, src.strain, src.zone, src.harvest_date, src.planting_date, 50.4, 50.4, tag, 'unslotted', null, 'GVR',
          src.id, src.product, src.crop_year, src.origin_site, src.harvest_id, src.from_harvest, src.item_id, true,
          'Combined in METRC at the GVR hub from W161, W242, W243, W244, W247')
  returning * into pc;
  insert into events (user_email, type, pallet_id, lbs, note, details)
  values (coalesce(current_email(), 'aziz@lifted-organics.com'), 'manifest_sync', pc.id, 50.4,
          'Made in METRC at the GVR hub (combined W161, W242, W243, W244, W247): app caught up with METRC',
          jsonb_build_object('tag', tag, 'from', 'W161 + W242 + W243 + W244 + W247', 'to_site', 'GVR', 'new', true));
  raise notice '% Crumpets added at GVR (Needs a spot), 50.4 lb', code_;
end $$;

commit;

select code, strain, crop_year, status, received_site, current_weight, package_tag from pallets where upper(trim(package_tag)) = '1A4060300030F35000005922';
