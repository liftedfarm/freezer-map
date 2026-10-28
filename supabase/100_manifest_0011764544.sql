-- 100: catch the app up with two METRC manifests that were made and sent by hand, so the app still had the packages
-- at OHR, untagged, or not at all.
--  A. 0011764544: OHR CCL25-0000017 to the GVR hub CCL21-0000679, made 10/26 2:23pm, received 10/27 5:28pm, 17 packages.
--  B. 0011760842: OHR CCL25-0000017 to Ametrine Wellness DCC-10002243, left 10/26 9:49pm, 17 packages, 4,890 lb.
-- App only: no METRC to-dos are made (METRC is already right). Every change is logged as 'manifest_sync' in the history.
-- A (to GVR):
--  * split pieces the app already had (tag pending, at OHR): get their METRC tag and move to GVR, Needs a spot
--  * pieces already tagged in the app but still at OHR: move to GVR, Needs a spot
--  * pieces the app never had: made as new pallets at GVR, Needs a spot, split from their source pallet
--  * source pallets whose app weight still included the piece: reduced by it
--  * their split / tag to-dos are marked done (METRC already has them)
-- B (to Ametrine):
--  * the nine 10 lb pieces still shown in freezers at OHR are marked shipped
--  * the eight 600 lb packages the app never had are added as shipped (so the tag and where it went are in the history)
--  * their source pallets are set to METRC's weight, only if METRC still shows that weight (else left for a look)
--  * P287 is also set to METRC's 195.56: besides the 10 lb to Ametrine and the 100 lb to GVR (A), 100 lb (...329) went
--    to RMG Distribution and 20 lb (...357) to CLUB GREEN through the hub on 10/14 and 10/19
-- Run once in Supabase after 099_depart_time.sql. Safe to re-run (anything already done is skipped). The results list each package.
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

-- ===== B. 0011760842: OHR to Ametrine Wellness (DCC-10002243), 10/26 =====
create temp table mb (n int, tag text, lbs numeric, src_codes text[], piece text) on commit drop;
-- piece: the app pallet that is this package (null = the app never had it: added as shipped)
insert into mb values
 ( 1, 'ABC06030007AD3D000000403',  10, '{P401}',      'P401-1'),
 ( 2, 'ABC06030007AD3D000000404',  10, '{P92}',       'P92-1'),
 ( 3, 'ABC06030007AD3D000000424',  10, '{P174}',      'P174-1'),
 ( 4, 'ABC06030007AD3D000000427',  10, '{T027}',      'T033-1'),
 ( 5, 'ABC06030007AD3D000000446',  10, '{T015}',      'T015-1'),
 ( 6, 'ABC06030007AD3D000000447',  10, '{T016}',      'T016-1'),
 ( 7, 'ABC06030007AD3D000000448', 600, '{P437}',      null),
 ( 8, 'ABC06030007AD3D000000449', 600, '{P517}',      null),
 ( 9, 'ABC06030007AD3D000000450', 600, '{P409,P700}', null),
 (10, 'ABC06030007AD3D000000451', 600, '{P339}',      null),
 (11, 'ABC06030007AD3D000000452', 600, '{P617}',      null),
 (12, 'ABC06030007AD3D000000453', 600, '{P676}',      null),
 (13, 'ABC06030007AD3D000000454',  10, '{P603}',      'P603-1'),
 (14, 'ABC06030007AD3D000000455',  10, '{P287}',      'P287-1'),
 (15, 'ABC06030007AD3D000000457',  10, '{T001}',      'T001-1'),
 (16, 'ABC06030007AD3D000000458', 600, '{P799}',      null),
 (17, 'ABC06030007AD3D000000459', 600, '{P762,P763}', null);

-- sources set to METRC's weight (as of the 10/28 pull), only if METRC still shows it
create temp table mbs (code text, metrc numeric) on commit drop;
insert into mbs values ('P437', 10), ('P517', 50), ('P339', 50), ('P617', 50), ('P676', 50), ('P799', 50),
                       ('P762', 640), ('P763', 7.58), ('P287', 195.56);

create temp table mb_out (n int, tag text, result text) on commit drop;

do $$
declare r record; src pallets; pc pallets; other pallets; code_ text; k int; mq numeric;
        note text := 'Manifest 0011760842 (10/26, OHR to Ametrine Wellness DCC-10002243): app caught up with METRC';
begin
  for r in select * from mb order by n loop
    select * into other from pallets where upper(trim(package_tag)) = upper(r.tag) limit 1;
    if r.piece is not null then
      pc := other;
      if pc.id is null then select * into pc from pallets where code = r.piece; end if;
      if pc.id is null then insert into mb_out values (r.n, r.tag, r.piece || ' not found: skipped'); continue; end if;
      if pc.status = 'shipped' then insert into mb_out values (r.n, r.tag, pc.code || ': already shipped'); continue; end if;
      if pc.status not in ('in_freezer', 'unslotted', 'archived') then insert into mb_out values (r.n, r.tag, pc.code || ' is ' || pc.status || ': left as is'); continue; end if;
      if pallet_open_load(pc.id) is not null then insert into mb_out values (r.n, r.tag, pc.code || ' is on a load: left as is'); continue; end if;
      if pc.package_tag is not null and upper(trim(pc.package_tag)) <> upper(r.tag) then
        insert into mb_out values (r.n, r.tag, pc.code || ' has tag ' || right(pc.package_tag, 6) || ', not this one: skipped'); continue;
      end if;
      insert into events (user_email, type, pallet_id, from_slot_id, lbs, note, details)
      values (coalesce(current_email(), 'aziz@lifted-organics.com'), 'manifest_sync', pc.id, pc.slot_id, pc.current_weight, note,
              jsonb_build_object('manifest', '0011760842', 'tag', r.tag, 'shipped_to', 'Ametrine Wellness', 'was', pc.status));
      update pallets set package_tag = r.tag, tag_pending = false, status = 'shipped', slot_id = null, container_id = null, updated_at = now()
       where id = pc.id;
      insert into mb_out values (r.n, r.tag, pc.code || ': marked shipped');
    else
      if other.id is not null then insert into mb_out values (r.n, r.tag, 'already in the app as ' || other.code || ' (' || other.status || ')'); continue; end if;
      select * into src from pallets where code = r.src_codes[1];
      if src.id is null then insert into mb_out values (r.n, r.tag, 'source ' || r.src_codes[1] || ' not in the app: skipped'); continue; end if;
      select coalesce(max(nullif(substring(code from '-(\d+)$'), '')::int), 0) + 1 into k from pallets where parent_id = src.id or code like src.code || '-%';
      code_ := src.code || '-' || k;
      while exists (select 1 from pallets where code = code_) loop k := k + 1; code_ := src.code || '-' || k; end loop;
      insert into pallets (code, strain, zone, harvest_date, planting_date, og_weight, current_weight, package_tag, status, slot_id, received_site,
                           parent_id, product, crop_year, origin_site, harvest_id, from_harvest, notes)
      values (code_, src.strain, src.zone, src.harvest_date, src.planting_date, r.lbs, r.lbs, r.tag, 'shipped', null, null,
              src.id, src.product, src.crop_year, src.origin_site, src.harvest_id, src.from_harvest,
              'From ' || array_to_string(r.src_codes, ' + ') || ', shipped to Ametrine Wellness on manifest 0011760842')
      returning * into pc;
      insert into events (user_email, type, pallet_id, lbs, note, details)
      values (coalesce(current_email(), 'aziz@lifted-organics.com'), 'manifest_sync', pc.id, r.lbs, note,
              jsonb_build_object('manifest', '0011760842', 'tag', r.tag, 'from', array_to_string(r.src_codes, ' + '), 'shipped_to', 'Ametrine Wellness', 'new', true));
      insert into mb_out values (r.n, r.tag, 'added ' || code_ || ' as shipped');
    end if;
  end loop;

  -- sources to METRC's weight
  for r in select * from mbs loop
    select * into src from pallets where code = r.code;
    select qty into mq from metrc_packages where upper(trim(label)) = upper(trim(src.package_tag)) order by qty limit 1;
    if src.id is null then insert into mb_out values (100, r.code, 'source not found: skipped');
    elsif src.status not in ('in_freezer', 'unslotted') then insert into mb_out values (100, r.code, 'source is ' || src.status || ' at ' || src.current_weight || ': left as is');
    elsif mq is distinct from r.metrc then insert into mb_out values (100, r.code, 'METRC now shows ' || coalesce(mq::text, 'nothing') || ', not ' || r.metrc || ': left at ' || src.current_weight);
    elsif src.current_weight = r.metrc then insert into mb_out values (100, r.code, 'already ' || r.metrc);
    else
      insert into events (user_email, type, pallet_id, lbs, note, details)
      values (coalesce(current_email(), 'aziz@lifted-organics.com'), 'manifest_sync', src.id, r.metrc, note,
              jsonb_build_object('manifest', '0011760842', 'from', src.current_weight, 'to', r.metrc, 'metrc', r.metrc));
      update pallets set current_weight = r.metrc, updated_at = now() where id = src.id;
      insert into mb_out values (100, r.code, src.current_weight || ' -> ' || r.metrc);
    end if;
  end loop;
end $$;

-- one result table (Supabase shows only the last result)
select x.manifest, x."#", x.tag, x.lbs, x.result from (
  select '0011764544 to GVR' as manifest, 1 as part, o.n as ord, o.n::text as "#", right(o.tag, 6) as tag, mf.lbs,
         o.result || coalesce('  (source now ' || (select p.code || ' ' || p.current_weight from pallets p where upper(trim(p.package_tag)) = upper(mf.src_tag) limit 1) || ')', '') as result
    from mf_out o join mf on mf.n = o.n
  union all
  select '0011760842 to Ametrine', 2, o.n, case when o.n = 100 then 'source' else o.n::text end,
         case when o.n = 100 then o.tag else right(o.tag, 6) end, mb.lbs, o.result
    from mb_out o left join mb on mb.n = o.n
  union all
  select 'Ametrine order in the app?', 3, 0, '', '', null,
         coalesce((select string_agg('order #' || o.id || ' ' || o.status, ', ') from orders o join customers c on c.id = o.customer_id where c.name ilike '%ametrine%'),
                  'none found')
) x order by x.part, x.ord, x.tag;
commit;
