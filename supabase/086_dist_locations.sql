-- 086: Distribution > Settings > Locations: add, change, retire and delete freezers and reefer trailers at OHR and GVR.
-- Freezers and reefers are 2 columns x N spots deep (front to back). Freezer spots are <number><letter> (1A..1I, 1J..1R),
-- reefers R<n><letter>. Reefers are stored as number 100 + n (Reefer 1 = 101), like the four GVR reefers from 047.
-- A location that ever held anything can't be deleted, only retired (hidden from the map, history kept). Run after 085.

alter table freezers add column if not exists active boolean not null default true;

create or replace function _loc_letters() returns text language sql immutable as $$ select 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' $$;

-- does anything point at this location's spots (now or in history)?
create or replace function _loc_used(p_freezer int) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from slots s where s.freezer_id = p_freezer and (
           exists (select 1 from pallets p where p.slot_id = s.id or p.span_to_slot = s.id)
        or exists (select 1 from events e where e.from_slot_id = s.id or e.to_slot_id = s.id)
        or exists (select 1 from load_items li where li.from_slot = s.id)))
      or exists (select 1 from events e where e.freezer_id = p_freezer and e.type <> 'freezer_setup')
$$;

create or replace function _loc_full(p_freezer int) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from pallets p join slots s on s.id = p.slot_id or s.id = p.span_to_slot
                 where s.freezer_id = p_freezer and p.status not in ('archived', 'shipped'))
$$;

-- make sure a freezer has exactly p_rows rows of spots in both columns (adds the missing ones, removes unused extra ones)
create or replace function _loc_size(p_freezer int, p_rows int) returns void
language plpgsql security definer set search_path = public as $$
declare f freezers; pre text; c int; r int; free text; used_codes text[];
begin
  select * into f from freezers where id = p_freezer;
  pre := case when f.kind = 'trailer' then 'R' || (f.number - 100)::text else f.number::text end;
  -- extra rows: only if nothing ever used them
  if exists (select 1 from slots s where s.freezer_id = f.id and s.row > p_rows and (
       exists (select 1 from pallets p where p.slot_id = s.id or p.span_to_slot = s.id)
       or exists (select 1 from events e where e.from_slot_id = s.id or e.to_slot_id = s.id)
       or exists (select 1 from load_items li where li.from_slot = s.id))) then
    raise exception 'The back rows have been used. Move the pallets out first, or retire this location and add a new one.';
  end if;
  delete from slots where freezer_id = f.id and row > p_rows;
  for c in 1..2 loop
    for r in 1..p_rows loop
      if not exists (select 1 from slots where freezer_id = f.id and col = c and row = r) then
        select array_agg(code) into used_codes from slots where freezer_id = f.id;
        select pre || substr(_loc_letters(), i, 1) into free
          from generate_series(1, 26) i
         where not (pre || substr(_loc_letters(), i, 1) = any (coalesce(used_codes, '{}')))
         order by abs(i - ((c - 1) * p_rows + r)), i limit 1;
        if free is null then raise exception 'Out of spot letters (26 spots max)'; end if;
        insert into slots (freezer_id, code, col, row, front_rank) values (f.id, free, c, r, p_rows - r + 1);
      end if;
    end loop;
  end loop;
  update slots set front_rank = p_rows - row + 1 where freezer_id = f.id;
end $$;

-- {"id": null|int, "site": "OHR", "kind": "freezer"|"trailer", "number": 18, "rows": 9, "status": "On", "license": null, "notes": ""}
-- number for a reefer is the reefer number (5 = Reefer 5); it's stored as 105
create or replace function loc_freezer_save(p jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare v_id int := nullif(p ->> 'id', '')::int; f freezers; v_kind text; v_site text; v_num int; v_rows int; old_pre text; new_pre text;
begin
  perform no_view_as();
  if not (is_mod_admin('distribution') or is_owner()) then raise exception 'Only a Distribution Admin can change freezers and reefers'; end if;
  v_kind := coalesce(nullif(p ->> 'kind', ''), 'freezer');
  if v_kind not in ('freezer', 'trailer') then raise exception 'Only freezers and reefers can be set up here'; end if;
  v_site := upper(coalesce(nullif(p ->> 'site', ''), 'GVR'));
  v_num := nullif(p ->> 'number', '')::int;
  if v_num is null or v_num < 1 then raise exception 'Give it a number'; end if;
  if v_kind = 'trailer' then
    if v_num > 99 then raise exception 'Reefer numbers go 1 to 99'; end if;
    v_num := v_num + 100;
  elsif v_num > 99 then raise exception 'Freezer numbers go 1 to 99';
  end if;
  v_rows := coalesce(nullif(p ->> 'rows', '')::int, case when v_kind = 'trailer' then 13 else 9 end);
  if v_rows < 1 or v_rows > 13 then raise exception 'Spots deep: 1 to 13'; end if;
  if exists (select 1 from freezers where site = v_site and number = v_num and id is distinct from v_id) then
    raise exception '% % already exists at %', case when v_kind = 'trailer' then 'Reefer' else 'Freezer' end, case when v_kind = 'trailer' then v_num - 100 else v_num end, v_site;
  end if;

  if v_id is null then
    insert into freezers (site, number, kind, status, notes, license, active)
    values (v_site, v_num, v_kind, coalesce(nullif(p ->> 'status', ''), 'On'), nullif(trim(p ->> 'notes'), ''), nullif(p ->> 'license', ''), true)
    returning id into v_id;
  else
    select * into f from freezers where id = v_id for update;
    if f.id is null then raise exception 'Not found'; end if;
    if f.kind not in ('freezer', 'trailer') then raise exception 'Staging is set up by the app'; end if;
    if f.kind <> v_kind and _loc_used(f.id) then raise exception 'It has been used; it can''t switch between freezer and reefer'; end if;
    if f.site <> v_site and _loc_full(f.id) then raise exception 'Empty it before moving it to %', v_site; end if;
    update freezers set site = v_site, number = v_num, kind = v_kind,
      status = coalesce(nullif(p ->> 'status', ''), status),
      notes = case when p ? 'notes' then nullif(trim(p ->> 'notes'), '') else notes end,
      license = case when p ? 'license' then coalesce(nullif(p ->> 'license', ''), license) else license end
    where id = v_id;
    -- renumbered: the spot names follow (1A becomes 18A)
    old_pre := case when f.kind = 'trailer' then 'R' || (f.number - 100)::text else f.number::text end;
    new_pre := case when v_kind = 'trailer' then 'R' || (v_num - 100)::text else v_num::text end;
    if old_pre <> new_pre then
      update slots set code = new_pre || substr(code, length(old_pre) + 1) where freezer_id = v_id and left(code, length(old_pre)) = old_pre;
    end if;
  end if;
  perform _loc_size(v_id, v_rows);
  insert into events (user_email, type, freezer_id, note, details)
  values (current_email(), 'freezer_setup', v_id, case when v_kind = 'trailer' then 'Reefer ' || (v_num - 100) else 'Freezer ' || v_num end,
          jsonb_build_object('site', v_site, 'rows', v_rows, 'new', p ->> 'id' is null));
  return v_id;
end $$;

-- retire (hide from the map, keep history) or bring back
create or replace function loc_freezer_active(p_id int, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
declare f freezers;
begin
  perform no_view_as();
  if not (is_mod_admin('distribution') or is_owner()) then raise exception 'Only a Distribution Admin can change freezers and reefers'; end if;
  select * into f from freezers where id = p_id for update;
  if f.kind not in ('freezer', 'trailer') then raise exception 'Staging is set up by the app'; end if;
  if not p_active and _loc_full(p_id) then raise exception 'There are pallets in it. Move them out first.'; end if;
  update freezers set active = p_active where id = p_id;
  insert into events (user_email, type, freezer_id, note, details)
  values (current_email(), 'freezer_setup', p_id, case when f.kind = 'trailer' then 'Reefer ' || (f.number - 100) else 'Freezer ' || f.number end,
          jsonb_build_object('active', p_active));
end $$;

-- delete: only one that never held anything (added by mistake)
create or replace function loc_freezer_delete(p_id int) returns void
language plpgsql security definer set search_path = public as $$
declare f freezers;
begin
  perform no_view_as();
  if not (is_mod_admin('distribution') or is_owner()) then raise exception 'Only a Distribution Admin can change freezers and reefers'; end if;
  select * into f from freezers where id = p_id for update;
  if f.id is null then return; end if;
  if f.kind not in ('freezer', 'trailer') then raise exception 'Staging is set up by the app'; end if;
  if _loc_used(p_id) then raise exception 'It has history (pallets have been in it). Retire it instead.'; end if;
  update events set freezer_id = null, details = coalesce(details, '{}'::jsonb) || jsonb_build_object('deleted', true) where freezer_id = p_id and type = 'freezer_setup';
  delete from freezers where id = p_id;
end $$;

revoke execute on function loc_freezer_save(jsonb), loc_freezer_active(int, boolean), loc_freezer_delete(int), _loc_used(int), _loc_full(int), _loc_size(int, int) from public;
grant execute on function loc_freezer_save(jsonb), loc_freezer_active(int, boolean), loc_freezer_delete(int) to authenticated;

select 'ok' as dist_locations;
