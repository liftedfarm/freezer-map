-- 100: catch the app up with METRC manifest 0011764544 (OHR CCL25-0000017 to the GVR hub CCL21-0000679, made 10/26 2:23pm,
-- received 10/27 5:28pm, 17 packages, all accepted). The packages were made and sent in METRC by hand, so the app still had
-- most of them at OHR, untagged, or not at all.
-- App only: no METRC to-dos are made (METRC is already right). Every change is logged as 'manifest_sync' in the history.
--  * split pieces the app already had (tag pending, at OHR): get their METRC tag and move to GVR, Needs a spot
--  * pieces already tagged in the app but still at OHR: move to GVR, Needs a spot
--  * pieces the app never had: made as new pallets at GVR, Needs a spot, split from their source pallet
--  * source pallets whose app weight still included the piece: reduced by it
--  * their split / tag to-dos are marked done (METRC already has them)
-- Run once in Supabase after 099_depart_time.sql. Safe to re-run (anything already done is skipped). The result lists each package.
begin;

create temp table mf (n int, tag text, lbs numeric, src_tag text, piece text, src_cut boolean) on commit drop;
-- piece: the app pallet that is this package (null = make a new one). src_cut: take lbs off the source pallet in the app
insert into mf values
 ( 1, 'ABC06030007AD3D000000462', 300, '1A406030007AD3D000010141', 'P141-1', false),
 ( 2, 'ABC06030007AD3D000000463',  10, '1A406030007AD3D000010088', 'P88-1',  false),
 ( 3, 'ABC06030007AD3D000000464',  10, '1A406030007AD3D000010407', 'P407-1', false),
 ( 4, 'ABC06030007AD3D000000465', 300, '1A406030007AD3D000010658', 'P658-1', false),
 ( 5, 'ABC06030007AD3D000000466', 300, '1A406030007AD3D000010510', null,     true),
 ( 6, 'ABC06030007AD3D000000467',  20, '1A406030007AD3D000010658', null,     false),  -- P658 was reweighed 10/28 (130), already net of it
 ( 7, 'ABC06030007AD3D000000468',  20, '1A406030007AD3D000010567', null,     true),
 ( 8, 'ABC06030007AD3D000000469',  10, '1A406030007AD3D000010253', 'P253-2', false),  -- fixed 10/28
 ( 9, 'ABC06030007AD3D000000470',  40, '1A406030007AD3D000010437', null,     true),
 (10, 'ABC06030007AD3D000000471',  40, '1A406030007AD3D000010567', null,     true),
 (11, 'ABC06030007AD3D000000472', 100, '1A406030007AD3D000010287', 'P287-2', false),
 (12, 'ABC06030007AD3D000000473', 300, '1A406030007AD3D000010344', 'P344-1', false),
 (13, 'ABC06030007AD3D000000474',  10, '1A406030007AD3D000010399', null,     true),
 (14, 'ABC06030007AD3D000000475', 130, 'ABC06030007AD3D000000802', 'T003-1', false),
 (15, 'ABC06030007AD3D000000400',  20, '1A406030007AD3D000010253', null,     false),  -- P253 already net of it (10/24 audit)
 (16, 'ABC06030007AD3D000000401',  20, '1A406030007AD3D000010228', null,     false),  -- P228 already matches METRC
 (17, 'ABC06030007AD3D000000402',  20, '1A406030007AD3D000010379', null,     false);  -- P379 already matches METRC

create temp table mf_out (n int, tag text, result text) on commit drop;

do $$
declare r record; src pallets; pc pallets; other pallets; code_ text; k int; note text := 'Manifest 0011764544 (10/26, received at GVR 10/27): app caught up with METRC';
begin
  for r in select * from mf order by n loop
    select * into src from pallets where upper(trim(package_tag)) = upper(r.src_tag) order by id limit 1;
    select * into other from pallets where upper(trim(package_tag)) = upper(r.tag) limit 1;

    if r.piece is not null then
      select * into pc from pallets where code = r.piece;
      if pc.id is null then insert into mf_out values (r.n, r.tag, r.piece || ' not found: skipped'); continue; end if;
      if other.id is not null and other.id <> pc.id then insert into mf_out values (r.n, r.tag, 'tag already on ' || other.code || ': skipped'); continue; end if;
      if pc.status not in ('in_freezer', 'unslotted') then insert into mf_out values (r.n, r.tag, pc.code || ' is ' || pc.status || ': left as is'); continue; end if;
      if pallet_open_load(pc.id) is not null then insert into mf_out values (r.n, r.tag, pc.code || ' is on a load: left as is'); continue; end if;
      if pc.package_tag is distinct from r.tag or pc.status <> 'unslotted' or pc.received_site is distinct from 'GVR' then
        insert into events (user_email, type, pallet_id, from_slot_id, lbs, note, details)
        values (coalesce(current_email(), 'aziz@lifted-organics.com'), 'manifest_sync', pc.id, pc.slot_id, pc.current_weight, note,
                jsonb_build_object('manifest', '0011764544', 'tag_was', pc.package_tag, 'tag', r.tag, 'to_site', 'GVR'));
        update pallets set package_tag = r.tag, tag_pending = false, status = 'unslotted', slot_id = null, received_site = 'GVR', updated_at = now()
         where id = pc.id;
        insert into mf_out values (r.n, r.tag, pc.code || ': tag set, now at GVR (Needs a spot)');
      else
        insert into mf_out values (r.n, r.tag, pc.code || ': already right');
      end if;
    else
      if other.id is not null then insert into mf_out values (r.n, r.tag, 'already in the app as ' || other.code); continue; end if;
      if src.id is null then insert into mf_out values (r.n, r.tag, 'source ' || r.src_tag || ' not in the app: skipped'); continue; end if;
      select coalesce(max(nullif(substring(code from '-(\d+)$'), '')::int), 0) + 1 into k from pallets where parent_id = src.id or code like src.code || '-%';
      code_ := src.code || '-' || k;
      while exists (select 1 from pallets where code = code_) loop k := k + 1; code_ := src.code || '-' || k; end loop;
      insert into pallets (code, strain, zone, harvest_date, planting_date, og_weight, current_weight, package_tag, status, slot_id, received_site,
                           parent_id, product, crop_year, origin_site, harvest_id, from_harvest, notes)
      values (code_, src.strain, src.zone, src.harvest_date, src.planting_date, r.lbs, r.lbs, r.tag, 'unslotted', null, 'GVR',
              src.id, src.product, src.crop_year, src.origin_site, src.harvest_id, src.from_harvest, 'From ' || src.code || ' on manifest 0011764544')
      returning * into pc;
      insert into events (user_email, type, pallet_id, lbs, note, details)
      values (coalesce(current_email(), 'aziz@lifted-organics.com'), 'manifest_sync', pc.id, r.lbs, note, jsonb_build_object('manifest', '0011764544', 'tag', r.tag, 'from', src.code, 'to_site', 'GVR', 'new', true));
      if r.src_cut then
        insert into events (user_email, type, pallet_id, lbs, note, details)
        values (coalesce(current_email(), 'aziz@lifted-organics.com'), 'manifest_sync', src.id, greatest(coalesce(src.current_weight, 0) - r.lbs, 0), note,
                jsonb_build_object('manifest', '0011764544', 'from', src.current_weight, 'to', greatest(coalesce(src.current_weight, 0) - r.lbs, 0), 'piece', code_));
        update pallets set current_weight = greatest(coalesce(current_weight, 0) - r.lbs, 0), updated_at = now() where id = src.id;
      end if;
      insert into mf_out values (r.n, r.tag, 'new ' || code_ || ' at GVR (Needs a spot)' || case when r.src_cut then ', ' || src.code || ' -' || r.lbs || ' lb' else '' end);
    end if;
  end loop;

  -- their split / tag / new package to-dos: METRC already has these packages
  update comp_metrc_actions a set status = 'done', note = 'Already in METRC: manifest 0011764544 (made and sent by hand 10/26)', done_by = coalesce(current_email(), 'aziz@lifted-organics.com'), done_at = now()
   where a.status in ('todo', 'error') and coalesce(a.push_state, '') <> 'sending' and a.kind in ('split', 'tag', 'new_package')
     and a.pallet_id in (select p.id from pallets p join mf on upper(trim(p.package_tag)) = upper(mf.tag));
end $$;

select o.n as "#", right(o.tag, 6) as tag, mf.lbs, o.result,
       (select p.code || ' ' || p.current_weight from pallets p where upper(trim(p.package_tag)) = upper(mf.src_tag) limit 1) as source_now
  from mf_out o join mf on mf.n = o.n order by o.n;
commit;
