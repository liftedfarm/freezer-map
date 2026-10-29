-- 101: catch the app up with the rest of October's METRC manifests (checked every manifest since 10/3 against the app,
-- METRC pull of 10/28). App only: no METRC to-dos (METRC is already right). Every change is logged as 'manifest_sync'.
--  * 8 packages sent OHR to the GVR hub (0011701157 10/14, 0011724703 10/20) that the app never had: added at GVR,
--    Needs a spot, made from their source pallet (the sources already match METRC, so they aren't cut again)
--  * P300 (...369 Canal St Runtz 200 lb, 0011724703): moved from OHR to GVR, Needs a spot
--  * G319 (...319 Nam Wah, archived): METRC still has 50 lb of it at the hub. Restored at GVR, Needs a spot, 50 lb
--  * D7152 (...7152 Cadillac Rainbows trim): sold from the hub to Full Spectrum on 0011750164 (10/26). Marked shipped
-- Run once in Supabase after 100. Safe to re-run (anything already done is skipped). The result lists each package.
begin;

create temp table mc (n int, manifest text, tag text, lbs numeric, src text, piece text, act text) on commit drop;
-- act: new = add at GVR from src; move = piece to GVR; restore = archived piece back at GVR at lbs; ship = piece shipped
insert into mc values
 ( 1, '0011724703', 'ABC06030007AD3D000000365', 100, 'P211', null,    'new'),
 ( 2, '0011724703', 'ABC06030007AD3D000000366', 200, 'P253', null,    'new'),
 ( 3, '0011724703', 'ABC06030007AD3D000000367', 200, 'P329', null,    'new'),
 ( 4, '0011724703', 'ABC06030007AD3D000000368', 100, 'P343', null,    'new'),
 ( 5, '0011724703', 'ABC06030007AD3D000000370', 100, 'P99',  null,    'new'),
 ( 6, '0011724703', 'ABC06030007AD3D000000371',  40, 'P136', null,    'new'),
 ( 7, '0011724703', 'ABC06030007AD3D000000375', 200, 'P181', null,    'new'),
 ( 8, '0011701157', 'ABC06030007AD3D000000332', 200, 'P88',  null,    'new'),
 ( 9, '0011724703', 'ABC06030007AD3D000000369', 200, null,   'P300',  'move'),
 (10, '0011675355', '1A406030007C3E5000000319',  50, null,   'G319',  'restore'),
 (11, '0011750164', '1A4060300030F35000007152', 36.75, null, 'D7152', 'ship');

create temp table mc_out (n int, result text) on commit drop;

do $$
declare r record; src pallets; pc pallets; other pallets; code_ text; k int; me text := coalesce(current_email(), 'aziz@lifted-organics.com');
begin
  for r in select * from mc order by n loop
    select * into other from pallets where upper(trim(package_tag)) = upper(r.tag) limit 1;
    if r.act = 'new' then
      if other.id is not null then insert into mc_out values (r.n, 'already in the app as ' || other.code || ' (' || other.status || ')'); continue; end if;
      select * into src from pallets where code = r.src;
      if src.id is null then insert into mc_out values (r.n, 'source ' || r.src || ' not found: skipped'); continue; end if;
      select coalesce(max(nullif(substring(code from '-(\d+)$'), '')::int), 0) + 1 into k from pallets where parent_id = src.id or code like src.code || '-%';
      code_ := src.code || '-' || k;
      while exists (select 1 from pallets where code = code_) loop k := k + 1; code_ := src.code || '-' || k; end loop;
      insert into pallets (code, strain, zone, harvest_date, planting_date, og_weight, current_weight, package_tag, status, slot_id, received_site,
                           parent_id, product, crop_year, origin_site, harvest_id, from_harvest, notes)
      values (code_, src.strain, src.zone, src.harvest_date, src.planting_date, r.lbs, r.lbs, r.tag, 'unslotted', null, 'GVR',
              src.id, src.product, src.crop_year, src.origin_site, src.harvest_id, src.from_harvest, 'From ' || src.code || ' on manifest ' || r.manifest)
      returning * into pc;
      insert into events (user_email, type, pallet_id, lbs, note, details)
      values (me, 'manifest_sync', pc.id, r.lbs, 'Manifest ' || r.manifest || ' (OHR to the GVR hub): app caught up with METRC',
              jsonb_build_object('manifest', r.manifest, 'tag', r.tag, 'from', src.code, 'to_site', 'GVR', 'new', true));
      insert into mc_out values (r.n, 'new ' || code_ || ' at GVR (Needs a spot)');
      continue;
    end if;

    select * into pc from pallets where code = r.piece;
    if pc.id is null then insert into mc_out values (r.n, r.piece || ' not found: skipped'); continue; end if;
    if other.id is not null and other.id <> pc.id then insert into mc_out values (r.n, 'tag already on ' || other.code || ': skipped'); continue; end if;
    if pallet_open_load(pc.id) is not null then insert into mc_out values (r.n, pc.code || ' is on a load: left as is'); continue; end if;

    if r.act = 'move' then
      if pc.status not in ('in_freezer', 'unslotted') then insert into mc_out values (r.n, pc.code || ' is ' || pc.status || ': left as is'); continue; end if;
      if pc.status = 'unslotted' and pc.received_site = 'GVR' then insert into mc_out values (r.n, pc.code || ': already at GVR'); continue; end if;
      insert into events (user_email, type, pallet_id, from_slot_id, lbs, note, details)
      values (me, 'manifest_sync', pc.id, pc.slot_id, pc.current_weight, 'Manifest ' || r.manifest || ' (OHR to the GVR hub): app caught up with METRC',
              jsonb_build_object('manifest', r.manifest, 'tag', r.tag, 'to_site', 'GVR'));
      update pallets set status = 'unslotted', slot_id = null, container_id = null, received_site = 'GVR', updated_at = now() where id = pc.id;
      insert into mc_out values (r.n, pc.code || ': moved to GVR (Needs a spot)');

    elsif r.act = 'restore' then
      if pc.status <> 'archived' then insert into mc_out values (r.n, pc.code || ' is ' || pc.status || ': left as is'); continue; end if;
      insert into events (user_email, type, pallet_id, lbs, note, details)
      values (me, 'manifest_sync', pc.id, r.lbs, 'METRC still has ' || r.lbs || ' lb of this at the GVR hub: restored',
              jsonb_build_object('manifest', r.manifest, 'tag', r.tag, 'to_site', 'GVR', 'from', pc.current_weight, 'to', r.lbs));
      update pallets set status = 'unslotted', slot_id = null, received_site = 'GVR', current_weight = r.lbs, updated_at = now() where id = pc.id;
      insert into mc_out values (r.n, pc.code || ': restored at GVR (Needs a spot), ' || pc.current_weight || ' -> ' || r.lbs || ' lb');

    elsif r.act = 'ship' then
      if pc.status = 'shipped' then insert into mc_out values (r.n, pc.code || ': already shipped'); continue; end if;
      if pc.status not in ('in_freezer', 'unslotted') then insert into mc_out values (r.n, pc.code || ' is ' || pc.status || ': left as is'); continue; end if;
      insert into events (user_email, type, pallet_id, from_slot_id, lbs, note, details)
      values (me, 'manifest_sync', pc.id, pc.slot_id, pc.current_weight, 'Manifest ' || r.manifest || ' (GVR hub to Full Spectrum Group): app caught up with METRC',
              jsonb_build_object('manifest', r.manifest, 'tag', r.tag, 'shipped_to', 'Full Spectrum Group', 'was', pc.status));
      update pallets set status = 'shipped', slot_id = null, container_id = null, updated_at = now() where id = pc.id;
      insert into mc_out values (r.n, pc.code || ': marked shipped');
    end if;
  end loop;
end $$;

select mc.n as "#", mc.manifest, right(mc.tag, 6) as tag, mc.lbs, o.result
  from mc_out o join mc on mc.n = o.n order by mc.n;
commit;
