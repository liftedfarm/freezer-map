-- 105: 2025 Purple Churro, The Church, Wilson Zero #1 and Moonbow matched to METRC (for an order). METRC pull of 10/28.
-- All of these are active in METRC at the GVR hub. App only: nothing is sent to METRC. Everything lands at GVR, Needs a spot,
-- at METRC's weight. Logged as 'manifest_sync'. Safe to re-run.
--  * archived in the app (old workbook pallets), METRC still has some: restored at METRC's weight
--      G109 Purple Churro 30.36 · G240 The Church 29.94 · G26 Wilson Zero #1 30 · W220 Moonbow 10
--  * never in the app: added
--      ...0286 Moonbow 50 (split from W232 in METRC) · ...6629 Wilson Zero #1 160 · ...7027 Wilson Zero #1 50
--  * left alone: W234 Moonbow (METRC has 0.62 lb), 2024 and 2026 Wilson Zero, Wilson Zero clones
begin;

create temp table m105 (n int, tag text, lbs numeric, act text, piece text, tmpl text, parent text, code_ text) on commit drop;
insert into m105 values
 (1, '1A406030007C3E5000000109', 30.36, 'restore', 'G109', null,   null,   null),
 (2, '1A406030007C3E5000000240', 29.94, 'restore', 'G240', null,   null,   null),
 (3, '1A406030007C3E5000000026', 30,    'restore', 'G26',  null,   null,   null),
 (4, 'ABC06030007AD3D000002220', 10,    'restore', 'W220', null,   null,   null),
 (5, 'ABC06030007AD3D000000286', 50,    'new',     null,   'W232', 'W232', null),
 (6, '1A4060300030F35000006629', 160,   'new',     null,   'G26',  null,   'G6629'),
 (7, '1A4060300030F35000007027', 50,    'new',     null,   'G26',  null,   'G7027');

create temp table o105 (n int, result text) on commit drop;

do $$
declare r record; pc pallets; t pallets; other pallets; c text; k int; me text := coalesce(current_email(), 'aziz@lifted-organics.com');
begin
  for r in select * from m105 order by n loop
    select * into other from pallets where upper(trim(package_tag)) = upper(r.tag) limit 1;
    if r.act = 'restore' then
      select * into pc from pallets where code = r.piece;
      if pc.id is null then insert into o105 values (r.n, r.piece || ' not found: skipped'); continue; end if;
      if other.id is not null and other.id <> pc.id then insert into o105 values (r.n, 'tag is on ' || other.code || ': skipped'); continue; end if;
      if pc.status <> 'archived' then insert into o105 values (r.n, pc.code || ' is ' || pc.status || ' (' || pc.current_weight || ' lb): left as is'); continue; end if;
      insert into events (user_email, type, pallet_id, lbs, note, details)
      values (me, 'restored', pc.id, r.lbs, 'METRC has ' || r.lbs || ' lb active at the GVR hub',
              jsonb_build_object('from', pc.current_weight, 'to', r.lbs, 'to_site', 'GVR', 'was', 'archived'));
      update pallets set status = 'unslotted', slot_id = null, received_site = 'GVR', current_weight = r.lbs, updated_at = now() where id = pc.id;
      insert into o105 values (r.n, pc.code || ' ' || pc.strain || ': restored at GVR (Needs a spot), ' || pc.current_weight || ' -> ' || r.lbs || ' lb');
    else
      if other.id is not null then insert into o105 values (r.n, 'already in the app as ' || other.code || ' (' || other.status || ')'); continue; end if;
      select * into t from pallets where code = r.tmpl;
      if t.id is null then insert into o105 values (r.n, r.tmpl || ' not found: skipped'); continue; end if;
      if r.parent is not null then
        select coalesce(max(nullif(substring(code from '-(\d+)$'), '')::int), 0) + 1 into k from pallets where parent_id = t.id or code like t.code || '-%';
        c := t.code || '-' || k;
        while exists (select 1 from pallets where code = c) loop k := k + 1; c := t.code || '-' || k; end loop;
      else
        c := r.code_;
        k := 1;
        while exists (select 1 from pallets where code = c) loop c := r.code_ || '-' || k; k := k + 1; end loop;
      end if;
      insert into pallets (code, strain, zone, harvest_date, planting_date, og_weight, current_weight, package_tag, status, slot_id, received_site,
                           parent_id, product, crop_year, origin_site, harvest_id, from_harvest, item_id, pushed, notes)
      values (c, t.strain, t.zone, t.harvest_date, t.planting_date, r.lbs, r.lbs, r.tag, 'unslotted', null, 'GVR',
              case when r.parent is not null then t.id end, t.product, t.crop_year, t.origin_site, t.harvest_id, t.from_harvest, t.item_id, true,
              'Active in METRC at the GVR hub, not in the app before' || case when r.parent is not null then ' (from ' || t.code || ')' else '' end)
      returning * into pc;
      insert into events (user_email, type, pallet_id, lbs, note, details)
      values (me, 'manifest_sync', pc.id, r.lbs, 'Active in METRC at the GVR hub: app caught up with METRC',
              jsonb_build_object('tag', r.tag, 'from', coalesce(r.parent, 'METRC'), 'to_site', 'GVR', 'new', true));
      insert into o105 values (r.n, 'new ' || c || ' ' || t.strain || ' ' || r.lbs || ' lb at GVR (Needs a spot)');
    end if;
  end loop;
end $$;

select m.n as "#", right(m.tag, 6) as tag, m.lbs, o.result from o105 o join m105 m on m.n = o.n order by m.n;
commit;
