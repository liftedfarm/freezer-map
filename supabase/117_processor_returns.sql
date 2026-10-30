-- 117: processor returns (dry coming back). Replaces Processing "Back unbucked" (proc_receive).
--   Receive the processor's METRC delivery, not the lot: each package on the manifest becomes a dry package at the
--   manifest (dry) weight, linked to the wet lot it came from (METRC source package = our wet tag). The wet lot closes
--   with its yield unless "More coming". Every return goes onto our own tag: when the label is on, the Processing Admin
--   confirms the tag and METRC makes a new package from theirs (to-do kind 'retag'). Waiting on our tag more than 2 days
--   shows as overdue. Run after 116. Safe to re-run.
begin;

alter table pallets add column if not exists wet_lot_id bigint references pallets(id);
alter table pallets add column if not exists their_tag boolean not null default false;   -- still on the processor's tag (needs ours)
alter table pallets add column if not exists returned_at timestamptz;
create index if not exists pallets_wet_lot on pallets (wet_lot_id) where wet_lot_id is not null;
create index if not exists pallets_their_tag on pallets (their_tag) where their_tag;

-- ---------- METRC kind for the retag ----------
create or replace function metrc_kind(p_type text) returns text
language sql immutable as $$
  select case p_type
    when 'weight_adjust' then 'adjust'
    when 'split_from' then 'split'
    when 'merge' then 'combine'
    when 'removed' then 'finish'
    when 'tag_set' then 'tag'
    when 'created' then 'new_package'
    when 'stop_departed' then 'manifest'
    when 'proc_sent' then 'transfer'
    when 'move' then 'ship_check'
    when 'shipped' then 'ship_check'
    when 'received' then 'receive'
    when 'proc_received' then 'receive'
    when 'nursery_received' then 'receive'
    when 'harvest_plants' then 'harvest_plants'
    when 'harvested' then 'harvest_package'
    when 'pushed' then 'harvest_package'
    when 'proc_wet' then 'harvest_package'
    when 'proc_output' then 'proc_output'
    when 'proc_used' then 'proc_used'
    when 'proc_run_done' then 'run_waste'
    when 'harvest_waste' then 'harvest_waste'
    when 'harvest_finish' then 'harvest_finish'
    when 'nursery_cut' then 'nursery_clones'
    when 'nursery_mother_lot' then 'nursery_mothers'
    when 'nursery_loss' then 'nursery_loss'
    when 'planting_made' then 'planting'
    when 'planting_loss' then 'plant_loss'
    when 'receipt_loss' then 'plant_loss'
    when 'planting_flip' then 'flower'
    when 'nursery_shipped' then 'transfer'
    when 'proc_retag' then 'retag'
    else 'other' end
$$;

insert into metrc_push_kinds (kind, label, phase, sort, ready, mode)
select 'retag', 'Processor returns: new package on our tag', 1, 25, true, coalesce((select mode from metrc_push_kinds where kind = 'split'), 'off')
on conflict (kind) do update set label = excluded.label, ready = true;

-- the retag to-do also holds the processor's tag
create or replace function metrc_touch_tags(a comp_metrc_actions) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct upper(t)) filter (where nullif(trim(t), '') is not null), '{}') from (
    select a.tag as t
    union all select p.package_tag from pallets p where a.details ->> 'type' = 'split_from' and p.id = nullif(a.details ->> 'parent_id', '')::bigint
    union all select p.package_tag from pallets p where a.details ->> 'type' = 'merge' and p.merged_into = a.pallet_id
    union all select p.package_tag from events e join pallets p on p.id = e.pallet_id
               where a.details ->> 'type' = 'merge' and e.type = 'combine_part' and e.details ->> 'into_id' = a.pallet_id::text
    union all select p.package_tag from pallets p where a.details ->> 'type' = 'tag_set' and a.details ->> 'from' is not null and p.id = a.pallet_id
    union all select a.details ->> 'from' where a.details ->> 'type' in ('tag_set', 'proc_retag')
    union all select a.details ->> 'old_tag' where a.details ->> 'type' = 'proc_received'
    union all select jsonb_array_elements_text(case when jsonb_typeof(a.details -> 'tags') = 'array' then a.details -> 'tags' else '[]'::jsonb end)
  ) x
$$;

create or replace function proc_admin_check() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  perform proc_require();
  perform no_view_as();
  if not (is_mod_admin('processing') or is_owner()) then raise exception 'Only a Processing Admin can do this'; end if;
end $$;

-- ---------- match incoming packages to wet lots (server) ----------
-- p_rows: [{ tag, strain, item, source_labels: [...] }]. Exact: a source label (or the tag itself) is a wet lot out at a
-- processor. Otherwise: the only open wet lot of that strain at a processor.
create or replace function proc_returns_match(p_rows jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb; srcs text[]; w pallets; how text; res jsonb := '[]'; n int;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]')) loop
    w := null; how := null;
    srcs := array(select upper(trim(x)) from jsonb_array_elements_text(coalesce(r -> 'source_labels', '[]')) x) || upper(trim(r ->> 'tag'));
    select * into w from pallets where status = 'at_processor' and upper(package_tag) = any(srcs) order by id limit 1;
    if w.id is not null then how := 'source';
    else
      select count(*) into n from pallets where status = 'at_processor' and lower(strain) = lower(coalesce(r ->> 'strain', ''));
      if n = 1 then select * into w from pallets where status = 'at_processor' and lower(strain) = lower(r ->> 'strain'); how := 'strain'; end if;
    end if;
    res := res || jsonb_build_object('tag', upper(trim(r ->> 'tag')), 'wet_lot_id', w.id, 'how', how);
  end loop;
  return jsonb_build_object('rows', res,
    'lots', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'code', p.code, 'strain', p.strain, 'lbs', p.current_weight, 'tag', p.package_tag,
                                                         'processor', (select coalesce(short, name) from proc_processors where id = p.processor_id), 'sent_on', p.sent_on) order by p.strain, p.code)
                      from pallets p where p.status = 'at_processor'), '[]'),
    'processor_licenses', coalesce((select jsonb_agg(license) from proc_processors where license is not null), '[]'));
end $$;
revoke all on function proc_returns_match(jsonb) from public, anon, authenticated;
grant execute on function proc_returns_match(jsonb) to service_role;

-- close a wet lot: everything came back. Yield = dry returned / wet sent.
create or replace function _proc_close_lot(p_lot bigint, p_by text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare w pallets; dry numeric; y numeric;
begin
  select * into w from pallets where id = p_lot for update;
  if w.id is null or w.status <> 'at_processor' then return null; end if;
  select coalesce(sum(coalesce(og_weight, current_weight)), 0) into dry from pallets where wet_lot_id = w.id;
  y := case when coalesce(w.og_weight, w.current_weight, 0) > 0 then round(dry / coalesce(w.og_weight, w.current_weight) * 100, 1) end;
  update pallets set status = 'depleted', current_weight = 0, slot_id = null, updated_at = now() where id = w.id;
  insert into events (user_email, type, pallet_id, lbs, note, details)
  values (coalesce(p_by, current_email()), 'proc_lot_closed', w.id, dry, 'Back from ' || coalesce((select name from proc_processors where id = w.processor_id), 'the processor')
          || ': ' || dry || ' lb dry from ' || coalesce(w.og_weight, w.current_weight) || ' lb wet' || coalesce(' (' || y || '%)', ''),
          jsonb_build_object('code', w.code, 'wet', coalesce(w.og_weight, w.current_weight), 'dry', dry, 'yield_pct', y, 'processor_id', w.processor_id, 'tag', w.package_tag));
  return jsonb_build_object('code', w.code, 'wet', coalesce(w.og_weight, w.current_weight), 'dry', dry, 'yield_pct', y);
end $$;
revoke all on function _proc_close_lot(bigint, text) from public, anon, authenticated;

create or replace function proc_close_lot(p_lot bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  perform proc_admin_check();
  r := _proc_close_lot(p_lot, current_email());
  if r is null then raise exception 'That wet lot isn''t out at a processor'; end if;
  return r;
end $$;
revoke all on function proc_close_lot(bigint) from public, anon;
grant execute on function proc_close_lot(bigint) to authenticated;

-- the retag to-do (METRC: new package from the processor's package onto our tag)
create or replace function _proc_queue_retag(p pallets, p_from text, p_lic text, p_by text) returns void
language plpgsql security definer set search_path = public as $$
declare eid bigint; d jsonb;
begin
  d := jsonb_build_object('type', 'proc_retag', 'from', upper(p_from), 'to', upper(p.package_tag), 'code', p.code, 'strain', p.strain, 'product', p.product,
                          'wet_lot_id', p.wet_lot_id, 'by', p_by);
  insert into events (user_email, type, pallet_id, lbs, note, details)
  values (p_by, 'proc_retag', p.id, p.current_weight, 'On our tag ' || upper(p.package_tag) || ' (was ' || upper(p_from) || ')', d)
  returning id into eid;
  insert into comp_metrc_actions (event_id, at, license, action, pallet_id, code, tag, lbs, summary, details)
  values (eid, now(), p_lic, 'New package on our tag (processor return)', p.id, p.code, upper(p.package_tag), p.current_weight,
          concat_ws(' · ', p.code, p.strain, 'from ' || upper(p_from)), d)
  on conflict (event_id) do nothing;
end $$;
revoke all on function _proc_queue_retag(pallets, text, text, text) from public, anon, authenticated;

-- the license a returned package sits on in METRC (where it was received)
create or replace function _proc_return_license(p_pallet bigint) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select e.details ->> 'license' from events e where e.pallet_id = p_pallet and e.type in ('proc_return', 'processor_return_added', 'inbound_received')
                    and e.details ? 'license' order by e.id desc limit 1),
                  (select license from metrc_packages m join pallets p on upper(p.package_tag) = m.label where p.id = p_pallet and m.state = 'active' limit 1),
                  comp_pallet_license(p_pallet))
$$;

-- ---------- receive (server, after METRC took the delivery) ----------
-- p_rows: [{ tag, lbs, item, strain, wet_lot_id, our_tag, reweigh, more_coming }]
create or replace function proc_return_receive(p_site text, p_license text, p_manifest text, p_from text, p_rows jsonb, p_by text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; w pallets; p pallets; tg text; our text; code_ text; i int; lbs numeric; rw numeric; it text; prod text; res jsonb := '[]';
        lots bigint[] := '{}'; more bigint[] := '{}'; l bigint; closed jsonb := '[]'; c jsonb;
begin
  if upper(coalesce(p_site, '')) not in ('OHR', 'GVR') then raise exception 'Not a freezer site'; end if;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]')) loop
    tg := upper(trim(r ->> 'tag')); lbs := nullif(r ->> 'lbs', '')::numeric; it := r ->> 'item';
    our := nullif(upper(trim(coalesce(r ->> 'our_tag', ''))), '');
    rw := nullif(r ->> 'reweigh', '')::numeric;
    if tg is null or tg = '' or lbs is null then continue; end if;
    w := null;
    if nullif(r ->> 'wet_lot_id', '') is not null then select * into w from pallets where id = (r ->> 'wet_lot_id')::bigint; end if;
    prod := case when it ~* 'standard' then 'standards' when it ~* 'small' then 'smalls' when it ~* 'trim' then 'trim' when it ~* 'unbucked|whole plant' then 'unbucked'
                 when it ~* 'bucked' then 'bucked' else 'unbucked' end;
    code_ := (case when upper(p_site) = 'GVR' then 'G' else 'P' end) || right(tg, 4); i := 1;
    while exists (select 1 from pallets where code = code_) loop code_ := (case when upper(p_site) = 'GVR' then 'G' else 'P' end) || right(tg, 4) || '-R' || i; i := i + 1; end loop;
    insert into pallets (code, strain, zone, harvest_date, og_weight, current_weight, package_tag, status, received_site, origin_site, product, crop_year,
                         from_harvest, processor_id, lot_id, wet_lot_id, their_tag, returned_at, needs_review, notes, pushed, kind)
    values (code_, coalesce(w.strain, nullif(trim(r ->> 'strain'), '')), w.zone, w.harvest_date, lbs, lbs, coalesce(our, tg), 'unslotted', upper(p_site),
            coalesce(w.origin_site, upper(p_site)), prod, w.crop_year, w.from_harvest, w.processor_id, w.lot_id, w.id, our is null, now(),
            nullif(concat_ws('. ', case when w.id is null then 'Processor return with no wet lot: check strain and product' end,
                             case when rw is not null and abs(rw - lbs) > coalesce(nullif((select value from app_settings where key = 'comp.weight_tol'), '')::numeric, 0.5)
                                  then 'Reweighed ' || rw || ' lb, manifest says ' || lbs || ' lb' end), ''),
            concat_ws('. ', 'Back from ' || p_from || ' on manifest ' || p_manifest, 'METRC item: ' || coalesce(it, '?'),
                      case when w.id is null then 'No wet lot: check strain and product' end,
                      case when rw is not null then 'Reweighed ' || rw || ' lb (manifest ' || lbs || ' lb)' end),
            true, 'package')
    returning * into p;
    insert into events (user_email, type, pallet_id, lbs, note, details)
    values (p_by, 'proc_return', p.id, lbs, 'Back from ' || p_from || ' (manifest ' || p_manifest || ')',
            jsonb_build_object('code', p.code, 'tag', tg, 'our_tag', our, 'license', p_license, 'site', upper(p_site), 'manifest', p_manifest, 'from', p_from,
                               'item', it, 'wet_lot_id', w.id, 'wet_lot', w.code, 'reweigh', rw));
    if our is not null then perform _proc_queue_retag(p, tg, p_license, p_by); end if;
    if w.id is not null then
      if coalesce((r ->> 'more_coming')::boolean, false) then more := more || w.id; else lots := lots || w.id; end if;
    end if;
    res := res || jsonb_build_object('tag', tg, 'code', p.code, 'lbs', lbs, 'wet_lot', w.code, 'our_tag', our);
  end loop;
  foreach l in array (select array(select distinct x from unnest(lots) x where not x = any(more))) loop
    c := _proc_close_lot(l, p_by);
    if c is not null then closed := closed || c; end if;
  end loop;
  return jsonb_build_object('rows', res, 'closed', closed);
end $$;
revoke all on function proc_return_receive(text, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function proc_return_receive(text, text, text, text, jsonb, text) to service_role;

-- ---------- our label is on: confirm the tag (Processing Admin) ----------
create or replace function proc_retag(p_pallet bigint, p_tag text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p pallets; t text := upper(trim(coalesce(p_tag, ''))); old text; lic text;
begin
  perform proc_admin_check();
  if t = '' then raise exception 'Enter our tag'; end if;
  select * into p from pallets where id = p_pallet for update;
  if p.id is null then raise exception 'Package not found'; end if;
  if not p.their_tag then raise exception '% is already on our tag', p.code; end if;
  if p.status not in ('in_freezer', 'unslotted') then raise exception '% is %', p.code, replace(p.status, '_', ' '); end if;
  if exists (select 1 from pallets where upper(package_tag) = t and id <> p.id and status not in ('depleted', 'archived', 'merged')) then
    raise exception 'Tag % is already on another package in the app', t;
  end if;
  if tag_available(t) is false then raise exception 'Tag % isn''t one of our available METRC tags', t; end if;
  old := upper(p.package_tag);
  lic := _proc_return_license(p.id);
  update pallets set package_tag = t, their_tag = false, updated_at = now() where id = p.id returning * into p;
  perform _proc_queue_retag(p, old, lic, current_email());
  return jsonb_build_object('code', p.code, 'from', old, 'to', t, 'license', lic);
end $$;
revoke all on function proc_retag(bigint, text) from public, anon;
grant execute on function proc_retag(bigint, text) to authenticated;

-- link a package that came back to its wet lot (packages received before 117, or matched wrong)
create or replace function proc_link_return(p_pallet bigint, p_lot bigint) returns void
language plpgsql security definer set search_path = public as $$
declare w pallets;
begin
  perform proc_admin_check();
  select * into w from pallets where id = p_lot;
  if w.id is null then raise exception 'Wet lot not found'; end if;
  update pallets set wet_lot_id = w.id, from_harvest = coalesce(from_harvest, w.from_harvest), lot_id = coalesce(lot_id, w.lot_id),
         crop_year = coalesce(crop_year, w.crop_year), processor_id = coalesce(processor_id, w.processor_id), updated_at = now()
   where id = p_pallet;
  insert into events (user_email, type, pallet_id, details) values (current_email(), 'proc_return_linked', p_pallet, jsonb_build_object('wet_lot_id', w.id, 'wet_lot', w.code));
end $$;
revoke all on function proc_link_return(bigint, bigint) from public, anon;
grant execute on function proc_link_return(bigint, bigint) to authenticated;

-- ---------- 10/29: the three CCP returns on manifest 0011766908 (added by hand) ----------
update pallets r set wet_lot_id = w.id, their_tag = true, returned_at = coalesce(r.returned_at, '2026-10-29 21:00:00+00'), needs_review = null,
       from_harvest = coalesce(r.from_harvest, w.from_harvest), lot_id = coalesce(r.lot_id, w.lot_id)
  from (values ('G4028', 'DN16'), ('G4029', 'DN15'), ('G4030', 'DN14')) m(code, wet) join pallets w on w.code = m.wet
 where r.code = m.code and r.wet_lot_id is null and upper(r.package_tag) like '1A4060300063B51%';
update events e set details = e.details || jsonb_build_object('license', 'CCL21-0000679')
 where e.type = 'processor_return_added' and not (e.details ? 'license');

commit;

select '117 processor returns' as ok,
       (select count(*) from pallets where their_tag) as needs_our_tag,
       (select count(*) from metrc_push_kinds where kind = 'retag') as retag_kind;
