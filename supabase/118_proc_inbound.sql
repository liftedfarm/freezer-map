-- 118: Processing > Inbound is the only place processor returns are received in METRC; Drying is lot accounting only.
--   Inbound: every package needs a spot (required); our tag and reweigh optional. The wet lot is linked only on an exact
--   METRC source match (our wet tag); receiving no longer closes lots.
--   Drying: per wet lot, Receive back (link / unlink packages that came back) and Close lot (yield).
-- Run after 117. Safe to re-run.
begin;

-- open spots in the site's reefer trailers (dry flower), 2 high
create or replace function proc_open_spots(p_site text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x.ko, x.num, x.code) filter (where x.used < x.cap), '[]') from (
    select s.id, s.code, f.kind, f.number num, f.id freezer_id,
           case f.kind when 'trailer' then 0 when 'freezer' then 1 else 2 end ko,
           case when f.kind = 'trailer' then 2 else 3 end cap,
           case f.kind when 'trailer' then 'Reefer ' || (f.number - 100) || ' · ' || substr(s.code, 3) when 'staging' then 'Staging · ' || s.row else 'F' || f.number || ' · ' || s.code end label,
           (select count(*) from pallets p where p.slot_id = s.id and p.status = 'in_freezer' and p.container_id is null)::int used,
           (select string_agg(p.code, ' + ') from pallets p where p.slot_id = s.id and p.status = 'in_freezer' and p.container_id is null) holds
      from slots s join freezers f on f.id = s.freezer_id
     where upper(f.site) = upper(p_site) and f.kind = 'trailer' and coalesce(f.active, true) and is_staff()
  ) x
$$;
revoke all on function proc_open_spots(text) from public, anon;
grant execute on function proc_open_spots(text) to authenticated;

-- the server checks the spots before it receives anything in METRC
create or replace function proc_spots_check(p_site text, p_slots bigint[]) returns text
language plpgsql stable security definer set search_path = public as $$
declare s bigint; f freezers; used int; mine int;
begin
  if coalesce(array_length(p_slots, 1), 0) = 0 then return 'Pick a spot for every package'; end if;
  foreach s in array p_slots loop
    if s is null then return 'Pick a spot for every package'; end if;
    select fz.* into f from slots x join freezers fz on fz.id = x.freezer_id where x.id = s;
    if f.id is null then return 'A spot isn''t on the map any more'; end if;
    if upper(f.site) <> upper(p_site) then return 'A spot is at ' || f.site || ', not ' || upper(p_site); end if;
    select count(*) into used from pallets where slot_id = s and status = 'in_freezer' and container_id is null;
    select count(*) into mine from unnest(p_slots) y where y = s;
    if used + mine > (case when f.kind = 'trailer' then 2 else 3 end) then
      return (select case when f.kind = 'trailer' then 'Reefer ' || (f.number - 100) || ' ' || substr(code, 3) else code end from slots where id = s) || ' is full';
    end if;
  end loop;
  return null;
end $$;
revoke all on function proc_spots_check(text, bigint[]) from public, anon, authenticated;
grant execute on function proc_spots_check(text, bigint[]) to service_role;

-- receive: spot required, wet lot only on an exact match, no closing
-- p_rows: [{ tag, lbs, item, strain, wet_lot_id, slot_id, our_tag, reweigh }]
create or replace function proc_return_receive(p_site text, p_license text, p_manifest text, p_from text, p_rows jsonb, p_by text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; w pallets; p pallets; tg text; our text; code_ text; i int; lbs numeric; rw numeric; it text; prod text; res jsonb := '[]'; sl bigint; err text;
begin
  if upper(coalesce(p_site, '')) not in ('OHR', 'GVR') then raise exception 'Not a freezer site'; end if;
  err := proc_spots_check(p_site, array(select nullif(x ->> 'slot_id', '')::bigint from jsonb_array_elements(coalesce(p_rows, '[]')) x));
  if err is not null then raise exception '%', err; end if;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]')) loop
    tg := upper(trim(r ->> 'tag')); lbs := nullif(r ->> 'lbs', '')::numeric; it := r ->> 'item';
    our := nullif(upper(trim(coalesce(r ->> 'our_tag', ''))), '');
    rw := nullif(r ->> 'reweigh', '')::numeric;
    sl := nullif(r ->> 'slot_id', '')::bigint;
    if tg is null or tg = '' or lbs is null then continue; end if;
    w := null;
    if nullif(r ->> 'wet_lot_id', '') is not null then select * into w from pallets where id = (r ->> 'wet_lot_id')::bigint and status = 'at_processor'; end if;
    prod := case when it ~* 'standard' then 'standards' when it ~* 'small' then 'smalls' when it ~* 'trim' then 'trim' when it ~* 'unbucked|whole plant' then 'unbucked'
                 when it ~* 'bucked' then 'bucked' else 'unbucked' end;
    code_ := (case when upper(p_site) = 'GVR' then 'G' else 'P' end) || right(tg, 4); i := 1;
    while exists (select 1 from pallets where code = code_) loop code_ := (case when upper(p_site) = 'GVR' then 'G' else 'P' end) || right(tg, 4) || '-R' || i; i := i + 1; end loop;
    insert into pallets (code, strain, zone, harvest_date, og_weight, current_weight, package_tag, status, slot_id, received_site, origin_site, product, crop_year,
                         from_harvest, processor_id, lot_id, wet_lot_id, their_tag, returned_at, needs_review, notes, pushed, kind)
    values (code_, coalesce(w.strain, nullif(trim(r ->> 'strain'), '')), w.zone, w.harvest_date, lbs, lbs, coalesce(our, tg), 'in_freezer', sl, upper(p_site),
            coalesce(w.origin_site, upper(p_site)), prod, w.crop_year, w.from_harvest, w.processor_id, w.lot_id, w.id, our is null, now(),
            nullif(concat_ws('. ', case when rw is not null and abs(rw - lbs) > coalesce(nullif((select value from app_settings where key = 'comp.weight_tol'), '')::numeric, 0.5)
                                        then 'Reweighed ' || rw || ' lb, manifest says ' || lbs || ' lb' end), ''),
            concat_ws('. ', 'Back from ' || p_from || ' on manifest ' || p_manifest, 'METRC item: ' || coalesce(it, '?'),
                      case when rw is not null then 'Reweighed ' || rw || ' lb (manifest ' || lbs || ' lb)' end),
            true, 'package')
    returning * into p;
    insert into events (user_email, type, pallet_id, to_slot_id, lbs, note, details)
    values (p_by, 'proc_return', p.id, sl, lbs, 'Back from ' || p_from || ' (manifest ' || p_manifest || ')',
            jsonb_build_object('code', p.code, 'tag', tg, 'our_tag', our, 'license', p_license, 'site', upper(p_site), 'manifest', p_manifest, 'from', p_from,
                               'item', it, 'wet_lot_id', w.id, 'wet_lot', w.code, 'reweigh', rw));
    if our is not null then perform _proc_queue_retag(p, tg, p_license, p_by); end if;
    res := res || jsonb_build_object('tag', tg, 'code', p.code, 'lbs', lbs, 'wet_lot', w.code, 'our_tag', our);
  end loop;
  return jsonb_build_object('rows', res);
end $$;
revoke all on function proc_return_receive(text, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function proc_return_receive(text, text, text, text, jsonb, text) to service_role;

-- Drying > Receive back: link packages that came back to a wet lot, or take one off
create or replace function proc_link_return(p_pallet bigint, p_lot bigint) returns void
language plpgsql security definer set search_path = public as $$
declare w pallets; p pallets;
begin
  perform proc_admin_check();
  select * into p from pallets where id = p_pallet for update;
  if p.id is null then raise exception 'Package not found'; end if;
  if p_lot is null then
    update pallets set wet_lot_id = null, updated_at = now() where id = p.id;
    insert into events (user_email, type, pallet_id, details) values (current_email(), 'proc_return_unlinked', p.id, jsonb_build_object('code', p.code, 'was', p.wet_lot_id));
    return;
  end if;
  select * into w from pallets where id = p_lot;
  if w.id is null or w.status <> 'at_processor' then raise exception 'That wet lot isn''t open at a processor'; end if;
  update pallets set wet_lot_id = w.id, returned_at = coalesce(returned_at, now()),
         from_harvest = coalesce(from_harvest, w.from_harvest), lot_id = coalesce(lot_id, w.lot_id), crop_year = coalesce(crop_year, w.crop_year),
         processor_id = coalesce(processor_id, w.processor_id), zone = coalesce(zone, w.zone), harvest_date = coalesce(harvest_date, w.harvest_date), updated_at = now()
   where id = p.id;
  insert into events (user_email, type, pallet_id, details) values (current_email(), 'proc_return_linked', p.id, jsonb_build_object('code', p.code, 'wet_lot_id', w.id, 'wet_lot', w.code));
end $$;
revoke all on function proc_link_return(bigint, bigint) from public, anon;
grant execute on function proc_link_return(bigint, bigint) to authenticated;

commit;

select '118 processor inbound' as ok, jsonb_array_length(proc_open_spots('GVR')) as gvr_open_spots_as_staff;
