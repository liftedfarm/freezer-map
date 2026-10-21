-- Migration 002: split, merge, METRC tag entry, weight adjust
-- Run once in Supabase: SQL Editor > New query > paste > Run. Safe to re-run.

-- merged pallets leave inventory but stay for history
alter table pallets drop constraint if exists pallets_status_check;
alter table pallets add constraint pallets_status_check
  check (status in ('in_freezer','unslotted','shipped','depleted','archived','merged'));
alter table pallets add column if not exists merged_into bigint references pallets(id);
create index if not exists pallets_parent_idx on pallets(parent_id);
create index if not exists pallets_merged_idx on pallets(merged_into);

create sequence if not exists combined_pallet_seq start 1;

-- shared check: is this METRC tag already on another live pallet?
create or replace function tag_in_use(p_tag text, p_except bigint) returns text
language sql stable as $$
  select code from pallets
   where package_tag = p_tag and id is distinct from p_except
     and status in ('in_freezer','unslotted')
   limit 1
$$;

-- where can a new or merged pallet go? returns the slot, or raises
create or replace function check_destination(p_slot int, p_ignore bigint[]) returns int
language plpgsql as $$
declare f freezers; others int;
begin
  if p_slot is null then return null; end if;
  select fz.* into f from slots s join freezers fz on fz.id = s.freezer_id where s.id = p_slot;
  if not found then raise exception 'Slot not found'; end if;
  if f.status = 'Not Working' then raise exception 'Freezer % is marked Not Working', f.number; end if;
  return p_slot;
end $$;

-- Split p_lbs off a pallet into a new pallet (P90 -> P90-1).
-- p_dest: 'same' = same slot as the original, 'staging' = out of the freezer.
create or replace function split_pallet(
  p_pallet_id   bigint,
  p_lbs         numeric,
  p_new_tag     text,
  p_tag_pending boolean default false,
  p_dest        text default 'same',
  p_note        text default null
) returns pallets
language plpgsql security definer set search_path = public as $$
declare
  p pallets; child pallets; n int; dest int; used text; tag text := nullif(trim(p_new_tag), '');
begin
  select * into p from pallets where id = p_pallet_id for update;
  if not found then raise exception 'Pallet not found'; end if;
  if p.status not in ('in_freezer','unslotted') then raise exception 'Pallet % is %, it cannot be split', p.code, p.status; end if;
  if p.current_weight is null then raise exception 'Pallet % has no weight. Adjust its weight first.', p.code; end if;
  if p_lbs is null or p_lbs <= 0 then raise exception 'Enter how many lbs to split off'; end if;
  if p_lbs >= p.current_weight then raise exception 'Split must be less than the pallet weight (% lbs)', p.current_weight; end if;
  if tag is null and not p_tag_pending then raise exception 'Enter the new METRC tag, or mark it pending'; end if;
  if tag is not null then
    used := tag_in_use(tag, null);
    if used is not null then raise exception 'Tag % is already on pallet %', tag, used; end if;
  end if;

  select coalesce(max(substring(code from length(p.code) + 2)::int), 0) + 1 into n
    from pallets
   where left(code, length(p.code) + 1) = p.code || '-'
     and substring(code from length(p.code) + 2) ~ '^[0-9]+$';

  dest := case when p_dest = 'same' then p.slot_id else null end;
  dest := check_destination(dest, array[p.id]);

  insert into pallets (code, strain, zone, harvest_date, planting_date, og_weight, current_weight,
                       package_tag, parent_id, status, slot_id, tag_pending, notes)
  values (p.code || '-' || n, p.strain, p.zone, p.harvest_date, p.planting_date, p_lbs, p_lbs,
          tag, p.id, case when dest is null then 'unslotted' else 'in_freezer' end, dest,
          tag is null, null)
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

-- Merge 2+ pallets of the same strain into a new C pallet.
-- p_dest: a slot id, or null for staging.
create or replace function merge_pallets(
  p_ids         bigint[],
  p_new_tag     text,
  p_tag_pending boolean default false,
  p_dest        int default null,
  p_note        text default null
) returns pallets
language plpgsql security definer set search_path = public as $$
declare
  src pallets[]; s pallets; m pallets; strains int; total numeric := 0; codes text[] := '{}';
  tag text := nullif(trim(p_new_tag), ''); used text; dest int; others int;
begin
  if coalesce(array_length(p_ids, 1), 0) < 2 then raise exception 'Pick at least two pallets to merge'; end if;
  select array_agg(x order by x.code) into src from (select * from pallets where id = any(p_ids) for update) x;
  if coalesce(array_length(src, 1), 0) <> array_length(p_ids, 1) then raise exception 'Some pallets were not found'; end if;
  foreach s in array src loop
    if s.status not in ('in_freezer','unslotted') then raise exception 'Pallet % is %, it cannot be merged', s.code, s.status; end if;
    if s.strain is null then raise exception 'Pallet % has no strain', s.code; end if;
    if s.current_weight is null then raise exception 'Pallet % has no weight', s.code; end if;
    total := total + s.current_weight; codes := codes || s.code;
  end loop;
  select count(distinct lower(x.strain)) into strains from unnest(src) x;
  if strains > 1 then raise exception 'Only the same strain can be merged. Use share slot for different strains.'; end if;
  if tag is null and not p_tag_pending then raise exception 'Enter the new METRC tag, or mark it pending'; end if;
  if tag is not null then
    used := tag_in_use(tag, null);
    if used is not null and not (used = any(codes)) then raise exception 'Tag % is already on pallet %', tag, used; end if;
  end if;

  dest := check_destination(p_dest, p_ids);
  if dest is not null and not exists (select 1 from unnest(src) x where x.slot_id = dest) then
    select count(*) into others from pallets where slot_id = dest;
    if others > 0 then raise exception 'That slot has other pallets in it. Pick an empty slot or one the merged pallets are in.'; end if;
  end if;

  insert into pallets (code, strain, zone, harvest_date, planting_date, og_weight, current_weight,
                       package_tag, status, slot_id, tag_pending)
  select 'C' || nextval('combined_pallet_seq'), src[1].strain,
         case when count(distinct x.zone) = 1 then max(x.zone) else 'Mixed' end,
         min(x.harvest_date), min(x.planting_date), total, total, tag,
         case when dest is null then 'unslotted' else 'in_freezer' end, dest, tag is null
    from unnest(src) x
  returning * into m;

  update pallets set status = 'merged', slot_id = null, merged_into = m.id, updated_at = now()
   where id = any(p_ids);

  insert into events(user_email, type, pallet_id, to_slot_id, lbs, note, details)
  values (current_email(), 'merge', m.id, dest, total, p_note,
          jsonb_build_object('sources', to_jsonb(codes), 'tag', tag));
  foreach s in array src loop
    insert into events(user_email, type, pallet_id, from_slot_id, lbs, note, details)
    values (current_email(), 'merged_into', s.id, s.slot_id, s.current_weight, p_note,
            jsonb_build_object('into', m.code, 'into_id', m.id));
  end loop;
  return m;
end $$;

-- Enter or correct a pallet's METRC tag (clears "tag pending")
create or replace function set_tag(p_pallet_id bigint, p_tag text, p_note text default null) returns pallets
language plpgsql security definer set search_path = public as $$
declare p pallets; tag text := nullif(trim(p_tag), ''); used text;
begin
  select * into p from pallets where id = p_pallet_id for update;
  if not found then raise exception 'Pallet not found'; end if;
  if tag is null then raise exception 'Enter a tag'; end if;
  used := tag_in_use(tag, p.id);
  if used is not null then raise exception 'Tag % is already on pallet %', tag, used; end if;
  insert into events(user_email, type, pallet_id, note, details)
  values (current_email(), 'tag_set', p.id, p_note, jsonb_build_object('from', p.package_tag, 'to', tag));
  update pallets set package_tag = tag, tag_pending = false, updated_at = now() where id = p.id returning * into p;
  return p;
end $$;

-- Correct a pallet's weight (reweigh, data fix)
create or replace function adjust_weight(p_pallet_id bigint, p_weight numeric, p_note text default null) returns pallets
language plpgsql security definer set search_path = public as $$
declare p pallets;
begin
  select * into p from pallets where id = p_pallet_id for update;
  if not found then raise exception 'Pallet not found'; end if;
  if p_weight is null or p_weight < 0 then raise exception 'Enter a weight of 0 or more'; end if;
  insert into events(user_email, type, pallet_id, lbs, note, details)
  values (current_email(), 'weight_adjust', p.id, p_weight, p_note,
          jsonb_build_object('from', p.current_weight, 'to', p_weight));
  update pallets set current_weight = p_weight, og_weight = coalesce(og_weight, p_weight), updated_at = now()
   where id = p.id returning * into p;
  return p;
end $$;

revoke all on function split_pallet(bigint,numeric,text,boolean,text,text) from public, anon;
revoke all on function merge_pallets(bigint[],text,boolean,int,text)      from public, anon;
revoke all on function set_tag(bigint,text,text)                           from public, anon;
revoke all on function adjust_weight(bigint,numeric,text)                  from public, anon;
grant execute on function split_pallet(bigint,numeric,text,boolean,text,text) to authenticated;
grant execute on function merge_pallets(bigint[],text,boolean,int,text)      to authenticated;
grant execute on function set_tag(bigint,text,text)                           to authenticated;
grant execute on function adjust_weight(bigint,numeric,text)                  to authenticated;
