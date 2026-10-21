-- Migration 005: mixed pallets (M1, M2...), new single pallets, no staging
-- Run once in Supabase: SQL Editor > New query > paste > Run. Safe to re-run.

alter table pallets add column if not exists kind text not null default 'package';
alter table pallets drop constraint if exists pallets_kind_check;
alter table pallets add constraint pallets_kind_check check (kind in ('package','mixed'));
-- a package sitting on a mixed pallet points at it (and shares its slot)
alter table pallets add column if not exists container_id bigint references pallets(id);
create index if not exists pallets_container_idx on pallets(container_id);

create sequence if not exists mixed_pallet_seq start 1;
create sequence if not exists single_pallet_seq start 1;

-- ---------- helpers ----------

-- A slot that can receive a pallet: exists, freezer working, and (unless sharing) empty
create or replace function slot_ok(p_slot int, p_share boolean, p_ignore bigint[] default '{}') returns int
language plpgsql as $$
declare f freezers; n int;
begin
  if p_slot is null then raise exception 'Pick a slot'; end if;
  select fz.* into f from slots s join freezers fz on fz.id = s.freezer_id where s.id = p_slot;
  if not found then raise exception 'Slot not found'; end if;
  if f.status = 'Not Working' then raise exception 'Freezer % is marked Not Working', f.number; end if;
  select count(*) into n from pallets where slot_id = p_slot and container_id is null and not (id = any(p_ignore));
  if n > 0 and not p_share then raise exception 'That slot is occupied. Choose share slot or pick an empty one.'; end if;
  return p_slot;
end $$;

-- Live package that can be moved, split, merged or mixed on its own
create or replace function assert_loose(p pallets, verb text) returns void
language plpgsql as $$
declare c text;
begin
  if p.status not in ('in_freezer','unslotted') then raise exception 'Pallet % is %, it cannot be %', p.code, p.status, verb; end if;
  if p.container_id is not null then
    select code into c from pallets where id = p.container_id;
    raise exception '% is on mixed pallet %. Take it off first.', p.code, c;
  end if;
end $$;

-- ---------- moving (now carries a mixed pallet's contents) ----------

create or replace function move_pallet(
  p_pallet_id bigint, p_to_slot int, p_combine boolean default false, p_note text default null
) returns pallets
language plpgsql security definer set search_path = public as $$
declare p pallets;
begin
  select * into p from pallets where id = p_pallet_id for update;
  if not found then raise exception 'Pallet not found'; end if;
  perform assert_loose(p, 'moved');
  if p.slot_id is not distinct from p_to_slot then raise exception 'Pallet % is already there', p.code; end if;
  perform slot_ok(p_to_slot, p_combine, array[p.id]);

  insert into events(user_email, type, pallet_id, from_slot_id, to_slot_id, lbs, note)
  values (current_email(), 'move', p.id, p.slot_id, p_to_slot, p.current_weight, p_note);
  update pallets set slot_id = p_to_slot, status = 'in_freezer', updated_at = now() where id = p.id returning * into p;
  if p.kind = 'mixed' then
    update pallets set slot_id = p_to_slot, status = 'in_freezer', updated_at = now() where container_id = p.id;
  end if;
  return p;
end $$;

-- ---------- split now takes a destination slot ----------

drop function if exists split_pallet(bigint,numeric,text,boolean,text,text);
create or replace function split_pallet(
  p_pallet_id bigint, p_lbs numeric, p_new_tag text, p_tag_pending boolean default false,
  p_dest_slot int default null, p_note text default null, p_share boolean default true
) returns pallets
language plpgsql security definer set search_path = public as $$
declare p pallets; child pallets; n int; dest int; used text; tag text := nullif(trim(p_new_tag), '');
begin
  select * into p from pallets where id = p_pallet_id for update;
  if not found then raise exception 'Pallet not found'; end if;
  perform assert_loose(p, 'split');
  if p.kind = 'mixed' then raise exception '% is a mixed pallet. Split one of the packages on it instead.', p.code; end if;
  if p.current_weight is null then raise exception 'Pallet % has no weight. Adjust its weight first.', p.code; end if;
  if p_lbs is null or p_lbs <= 0 then raise exception 'Enter how many lbs to split off'; end if;
  if p_lbs >= p.current_weight then raise exception 'Split must be less than the pallet weight (% lbs)', p.current_weight; end if;
  if tag is null and not p_tag_pending then raise exception 'Enter the new METRC tag, or mark it pending'; end if;
  if tag is not null then
    used := tag_in_use(tag, null);
    if used is not null then raise exception 'Tag % is already on pallet %', tag, used; end if;
  end if;
  dest := coalesce(p_dest_slot, p.slot_id);
  perform slot_ok(dest, p_share or dest = p.slot_id, array[p.id]);

  select coalesce(max(substring(code from length(p.code) + 2)::int), 0) + 1 into n
    from pallets where left(code, length(p.code) + 1) = p.code || '-' and substring(code from length(p.code) + 2) ~ '^[0-9]+$';

  insert into pallets (code, strain, zone, harvest_date, planting_date, og_weight, current_weight,
                       package_tag, parent_id, status, slot_id, tag_pending)
  values (p.code || '-' || n, p.strain, p.zone, p.harvest_date, p.planting_date, p_lbs, p_lbs,
          tag, p.id, 'in_freezer', dest, tag is null)
  returning * into child;
  update pallets set current_weight = current_weight - p_lbs, updated_at = now() where id = p.id;

  insert into events(user_email, type, pallet_id, from_slot_id, lbs, note, details)
  values (current_email(), 'split', p.id, p.slot_id, p_lbs, p_note,
          jsonb_build_object('child', child.code, 'child_id', child.id, 'remaining', p.current_weight - p_lbs));
  insert into events(user_email, type, pallet_id, to_slot_id, lbs, note, details)
  values (current_email(), 'split_from', child.id, dest, p_lbs, p_note,
          jsonb_build_object('parent', p.code, 'parent_id', p.id, 'tag', tag));
  return child;
end $$;

-- ---------- merge: block mixed pallets and their contents ----------

create or replace function merge_pallets(
  p_ids bigint[], p_new_tag text, p_tag_pending boolean default false, p_dest int default null, p_note text default null
) returns pallets
language plpgsql security definer set search_path = public as $$
declare
  src pallets[]; s pallets; m pallets; strains int; total numeric := 0; codes text[] := '{}';
  tag text := nullif(trim(p_new_tag), ''); used text; dest int;
begin
  if coalesce(array_length(p_ids, 1), 0) < 2 then raise exception 'Pick at least two pallets to merge'; end if;
  select array_agg(x order by x.code) into src from (select * from pallets where id = any(p_ids) for update) x;
  if coalesce(array_length(src, 1), 0) <> array_length(p_ids, 1) then raise exception 'Some pallets were not found'; end if;
  foreach s in array src loop
    perform assert_loose(s, 'merged');
    if s.kind = 'mixed' then raise exception '% is a mixed pallet and can''t be merged', s.code; end if;
    if s.strain is null then raise exception 'Pallet % has no strain', s.code; end if;
    if s.current_weight is null then raise exception 'Pallet % has no weight', s.code; end if;
    total := total + s.current_weight; codes := codes || s.code;
  end loop;
  select count(distinct lower(x.strain)) into strains from unnest(src) x;
  if strains > 1 then raise exception 'Only the same strain can be merged. Use a mixed pallet for different strains.'; end if;
  if tag is null and not p_tag_pending then raise exception 'Enter the new METRC tag, or mark it pending'; end if;
  if tag is not null then
    used := tag_in_use(tag, null);
    if used is not null and not (used = any(codes)) then raise exception 'Tag % is already on pallet %', tag, used; end if;
  end if;
  dest := coalesce(p_dest, src[1].slot_id);
  if not exists (select 1 from unnest(src) x where x.slot_id = dest) then perform slot_ok(dest, false, p_ids); end if;

  insert into pallets (code, strain, zone, harvest_date, planting_date, og_weight, current_weight, package_tag, status, slot_id, tag_pending)
  select 'C' || nextval('combined_pallet_seq'), src[1].strain,
         case when count(distinct x.zone) = 1 then max(x.zone) else 'Mixed' end,
         min(x.harvest_date), min(x.planting_date), total, total, tag, 'in_freezer', dest, tag is null
    from unnest(src) x
  returning * into m;
  update pallets set status = 'merged', slot_id = null, merged_into = m.id, updated_at = now() where id = any(p_ids);

  insert into events(user_email, type, pallet_id, to_slot_id, lbs, note, details)
  values (current_email(), 'merge', m.id, dest, total, p_note, jsonb_build_object('sources', to_jsonb(codes), 'tag', tag));
  foreach s in array src loop
    insert into events(user_email, type, pallet_id, from_slot_id, lbs, note, details)
    values (current_email(), 'merged_into', s.id, s.slot_id, s.current_weight, p_note, jsonb_build_object('into', m.code, 'into_id', m.id));
  end loop;
  return m;
end $$;

-- ---------- mixed pallets ----------

-- put one line onto a mixed pallet: whole package (keeps its tag) or split lbs off (new tag)
create or replace function mix_line(m pallets, line jsonb, p_note text) returns text
language plpgsql as $$
declare p pallets; lbs numeric := (line->>'lbs')::numeric; tag text := nullif(trim(line->>'tag'), '');
        pending boolean := coalesce((line->>'tag_pending')::boolean, false); child pallets; n int; used text;
begin
  select * into p from pallets where id = (line->>'pallet_id')::bigint for update;
  if not found then raise exception 'Pallet not found'; end if;
  perform assert_loose(p, 'added');
  if p.kind = 'mixed' then raise exception '% is already a mixed pallet', p.code; end if;

  if lbs is null or lbs >= coalesce(p.current_weight, 0) then
    -- whole package goes on as-is
    insert into events(user_email, type, pallet_id, from_slot_id, to_slot_id, lbs, note, details)
    values (current_email(), 'mixed_on', p.id, p.slot_id, m.slot_id, p.current_weight, p_note,
            jsonb_build_object('mixed', m.code, 'mixed_id', m.id, 'whole', true));
    update pallets set container_id = m.id, slot_id = m.slot_id, status = 'in_freezer', updated_at = now() where id = p.id;
    return p.code;
  end if;

  if lbs <= 0 then raise exception 'Enter lbs for %', p.code; end if;
  if tag is null and not pending then raise exception 'Enter the new METRC tag for the % lbs from %, or mark it pending', lbs, p.code; end if;
  if tag is not null then
    used := tag_in_use(tag, null);
    if used is not null then raise exception 'Tag % is already on pallet %', tag, used; end if;
  end if;
  select coalesce(max(substring(code from length(p.code) + 2)::int), 0) + 1 into n
    from pallets where left(code, length(p.code) + 1) = p.code || '-' and substring(code from length(p.code) + 2) ~ '^[0-9]+$';
  insert into pallets (code, strain, zone, harvest_date, planting_date, og_weight, current_weight,
                       package_tag, parent_id, status, slot_id, tag_pending, container_id)
  values (p.code || '-' || n, p.strain, p.zone, p.harvest_date, p.planting_date, lbs, lbs,
          tag, p.id, 'in_freezer', m.slot_id, tag is null, m.id)
  returning * into child;
  update pallets set current_weight = current_weight - lbs, updated_at = now() where id = p.id;
  insert into events(user_email, type, pallet_id, from_slot_id, lbs, note, details)
  values (current_email(), 'split', p.id, p.slot_id, lbs, p_note,
          jsonb_build_object('child', child.code, 'child_id', child.id, 'remaining', p.current_weight - lbs, 'mixed', m.code));
  insert into events(user_email, type, pallet_id, to_slot_id, lbs, note, details)
  values (current_email(), 'split_from', child.id, m.slot_id, lbs, p_note,
          jsonb_build_object('parent', p.code, 'parent_id', p.id, 'tag', tag, 'mixed', m.code));
  return child.code;
end $$;

-- New mixed pallet in an empty slot, built from lines:
-- [{"pallet_id": 12, "lbs": null}, {"pallet_id": 40, "lbs": 50, "tag": "1A4...", "tag_pending": false}]
create or replace function create_mixed_pallet(p_slot int, p_lines jsonb, p_note text default null) returns pallets
language plpgsql security definer set search_path = public as $$
declare m pallets; l jsonb; codes text[] := '{}';
begin
  if jsonb_array_length(coalesce(p_lines, '[]')) = 0 then raise exception 'Add at least one package'; end if;
  perform slot_ok(p_slot, false);
  insert into pallets (code, kind, label, status, slot_id)
  values ('M' || nextval('mixed_pallet_seq'), 'mixed', 'Mixed pallet', 'in_freezer', p_slot)
  returning * into m;
  for l in select * from jsonb_array_elements(p_lines) loop codes := codes || mix_line(m, l, p_note); end loop;
  insert into events(user_email, type, pallet_id, to_slot_id, note, details)
  values (current_email(), 'mixed_created', m.id, p_slot, p_note, jsonb_build_object('packages', to_jsonb(codes)));
  return m;
end $$;

create or replace function add_to_mixed(p_mixed_id bigint, p_lines jsonb, p_note text default null) returns pallets
language plpgsql security definer set search_path = public as $$
declare m pallets; l jsonb; codes text[] := '{}';
begin
  select * into m from pallets where id = p_mixed_id and kind = 'mixed' for update;
  if not found then raise exception 'Mixed pallet not found'; end if;
  if m.status not in ('in_freezer','unslotted') then raise exception '% is %', m.code, m.status; end if;
  for l in select * from jsonb_array_elements(p_lines) loop codes := codes || mix_line(m, l, p_note); end loop;
  insert into events(user_email, type, pallet_id, note, details)
  values (current_email(), 'mixed_added', m.id, p_note, jsonb_build_object('packages', to_jsonb(codes)));
  return m;
end $$;

-- Take one package off a mixed pallet into a slot
create or replace function take_off_mixed(p_pallet_id bigint, p_slot int, p_share boolean default false, p_note text default null) returns pallets
language plpgsql security definer set search_path = public as $$
declare p pallets; m pallets;
begin
  select * into p from pallets where id = p_pallet_id for update;
  if not found or p.container_id is null then raise exception 'That package is not on a mixed pallet'; end if;
  select * into m from pallets where id = p.container_id for update;
  perform slot_ok(p_slot, p_share or p_slot = m.slot_id, array[p.id]);
  insert into events(user_email, type, pallet_id, from_slot_id, to_slot_id, lbs, note, details)
  values (current_email(), 'mixed_off', p.id, m.slot_id, p_slot, p.current_weight, p_note, jsonb_build_object('mixed', m.code, 'mixed_id', m.id));
  update pallets set container_id = null, slot_id = p_slot, updated_at = now() where id = p.id returning * into p;
  return p;
end $$;

-- Break a mixed pallet apart: every package stays in the same slot as its own pallet
create or replace function break_mixed(p_mixed_id bigint, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare m pallets; codes text[];
begin
  select * into m from pallets where id = p_mixed_id and kind = 'mixed' for update;
  if not found then raise exception 'Mixed pallet not found'; end if;
  select array_agg(code order by code) into codes from pallets where container_id = m.id;
  insert into events(user_email, type, pallet_id, from_slot_id, lbs, note, details)
  select current_email(), 'mixed_off', id, m.slot_id, current_weight, p_note, jsonb_build_object('mixed', m.code, 'mixed_id', m.id, 'broken', true)
    from pallets where container_id = m.id;
  update pallets set container_id = null, updated_at = now() where container_id = m.id;
  insert into events(user_email, type, pallet_id, from_slot_id, note, details)
  values (current_email(), 'mixed_broken', m.id, m.slot_id, p_note, jsonb_build_object('packages', to_jsonb(coalesce(codes, '{}'))));
  update pallets set status = 'depleted', slot_id = null, updated_at = now() where id = m.id;
end $$;

-- ---------- new single pallet typed in by hand ----------

create or replace function create_single_pallet(
  p_slot int, p_code text, p_strain text, p_lbs numeric, p_tag text, p_tag_pending boolean default false,
  p_harvest_date date default null, p_note text default null, p_share boolean default false
) returns pallets
language plpgsql security definer set search_path = public as $$
declare p pallets; v_code text := upper(nullif(trim(p_code), '')); tag text := nullif(trim(p_tag), ''); used text;
begin
  perform slot_ok(p_slot, p_share);
  if nullif(trim(p_strain), '') is null then raise exception 'Pick a strain'; end if;
  if p_lbs is null or p_lbs <= 0 then raise exception 'Enter the weight'; end if;
  if tag is null and not p_tag_pending then raise exception 'Enter the METRC tag, or mark it pending'; end if;
  if tag is not null then
    used := tag_in_use(tag, null);
    if used is not null then raise exception 'Tag % is already on pallet %', tag, used; end if;
  end if;
  if v_code is null then v_code := 'S' || nextval('single_pallet_seq'); end if;
  if exists (select 1 from pallets where pallets.code = v_code) then
    raise exception 'Pallet % already exists. Search for it instead.', v_code;
  end if;
  insert into pallets (code, strain, harvest_date, og_weight, current_weight, package_tag, tag_pending, status, slot_id, notes)
  values (v_code, trim(p_strain), p_harvest_date, p_lbs, p_lbs, tag, tag is null, 'in_freezer', p_slot, p_note)
  returning * into p;
  insert into events(user_email, type, pallet_id, to_slot_id, lbs, note, details)
  values (current_email(), 'created', p.id, p_slot, p_lbs, p_note, jsonb_build_object('tag', tag));
  return p;
end $$;

-- ---------- permissions ----------
revoke all on function split_pallet(bigint,numeric,text,boolean,int,text,boolean) from public, anon;
revoke all on function create_mixed_pallet(int,jsonb,text) from public, anon;
revoke all on function add_to_mixed(bigint,jsonb,text) from public, anon;
revoke all on function take_off_mixed(bigint,int,boolean,text) from public, anon;
revoke all on function break_mixed(bigint,text) from public, anon;
revoke all on function create_single_pallet(int,text,text,numeric,text,boolean,date,text,boolean) from public, anon;
grant execute on function split_pallet(bigint,numeric,text,boolean,int,text,boolean) to authenticated;
grant execute on function create_mixed_pallet(int,jsonb,text) to authenticated;
grant execute on function add_to_mixed(bigint,jsonb,text) to authenticated;
grant execute on function take_off_mixed(bigint,int,boolean,text) to authenticated;
grant execute on function break_mixed(bigint,text) to authenticated;
grant execute on function create_single_pallet(int,text,text,numeric,text,boolean,date,text,boolean) to authenticated;
