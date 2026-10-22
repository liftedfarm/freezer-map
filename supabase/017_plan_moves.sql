-- Migration 017: staging areas, moving many pallets at once (with swaps and shuffles), undo, and removing
-- a pallet with a reason. Run after 016. Safe to re-run.
--
--  * Staging: one per site, 26 positions. Not a physical place, it's where orders get built. It's a
--    "freezer" with kind = 'staging' so moves, loads and history all work the same way.
--  * apply_moves: a whole plan saves at once. Each step says where the pallet was when the plan was made;
--    if someone moved it since, nothing saves. Every move is logged with the same batch id.
--  * undo_batch: puts a batch back, within 15 minutes, if none of those pallets moved again since.
--  * remove_pallet: used up (to 0), shipped outside the app, or entered by mistake. Never a real delete.
set client_min_messages = warning;

-- ---------- staging ----------
alter table freezers add column if not exists kind text not null default 'freezer';
alter table freezers drop constraint if exists freezers_kind_check;
alter table freezers add constraint freezers_kind_check check (kind in ('freezer','staging'));
alter table slots drop constraint if exists slots_row_check;
alter table slots add constraint slots_row_check check (row between 1 and 30);

insert into freezers (site, number, status, kind, notes)
select s, 0, 'On', 'staging', 'Staging: where orders get built'
  from (values ('OHR'), ('GVR')) v(s)
 where not exists (select 1 from freezers where site = v.s and kind = 'staging');

insert into slots (freezer_id, code, col, row, front_rank)
select f.id, 'S' || g, 1, g, g
  from freezers f cross join generate_series(1, 26) g
 where f.kind = 'staging'
   and not exists (select 1 from slots s where s.freezer_id = f.id and s.row = g);

-- ---------- batch moves ----------
alter table events add column if not exists batch_id uuid;
create index if not exists events_batch_idx on events(batch_id) where batch_id is not null;

-- p_moves: [{ "pallet_id": 1, "from_slot": 12 | null, "to_slot": 40, "kind": "move" | "swap" | "shuffle" }]
create or replace function apply_moves(p_moves jsonb, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare m jsonb; p pallets; b uuid := gen_random_uuid(); dest int; f freezers; n int := 0; ids bigint[] := '{}';
begin
  perform require_staff();
  if jsonb_typeof(p_moves) <> 'array' or jsonb_array_length(p_moves) = 0 then raise exception 'Nothing to move'; end if;
  -- check everything first
  for m in select * from jsonb_array_elements(p_moves) loop
    select * into p from pallets where id = (m ->> 'pallet_id')::bigint for update;
    if p.id is null then raise exception 'Pallet not found'; end if;
    if p.id = any(ids) then raise exception '% is in the plan twice', p.code; end if;
    ids := ids || p.id;
    perform assert_loose_or_mixed(p);
    if p.slot_id is distinct from nullif(m ->> 'from_slot', '')::int then
      raise exception '% was moved by someone else since you started. Nothing was saved, check the map and try again.', p.code;
    end if;
    dest := (m ->> 'to_slot')::int;
    select fz.* into f from slots s join freezers fz on fz.id = s.freezer_id where s.id = dest;
    if f.id is null then raise exception 'Slot not found for %', p.code; end if;
    if f.status = 'Not Working' then raise exception 'Freezer % is marked Not Working (%)', f.number, p.code; end if;
  end loop;
  -- then move
  for m in select * from jsonb_array_elements(p_moves) loop
    select * into p from pallets where id = (m ->> 'pallet_id')::bigint;
    dest := (m ->> 'to_slot')::int;
    continue when p.slot_id is not distinct from dest;
    insert into events (user_email, type, pallet_id, from_slot_id, to_slot_id, lbs, note, batch_id, details)
    values (current_email(), 'move', p.id, p.slot_id, dest, p.current_weight, p_note, b,
            jsonb_build_object('kind', coalesce(m ->> 'kind', 'move'), 'batch', b));
    update pallets set slot_id = dest, status = 'in_freezer', updated_at = now() where id = p.id;
    if p.kind = 'mixed' then update pallets set slot_id = dest, status = 'in_freezer', updated_at = now() where container_id = p.id; end if;
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'Nothing changed'; end if;
  return b;
end $$;

-- top-level pallet that can move (a loose package or a whole mixed pallet)
create or replace function assert_loose_or_mixed(p pallets) returns void
language plpgsql as $$
begin
  if p.status not in ('in_freezer','unslotted') then raise exception 'Pallet % is %, it can''t be moved', p.code, p.status; end if;
  if p.container_id is not null then raise exception '% is on a mixed pallet. Move the mixed pallet, or take it off first.', p.code; end if;
end $$;
revoke execute on function assert_loose_or_mixed(pallets) from public, anon, authenticated;

create or replace function undo_batch(p_batch uuid) returns int
language plpgsql security definer set search_path = public as $$
declare e record; p pallets; b uuid := gen_random_uuid(); n int := 0;
begin
  perform require_staff();
  if not exists (select 1 from events where batch_id = p_batch) then raise exception 'Nothing to undo'; end if;
  if (select min(at) from events where batch_id = p_batch) < now() - interval '15 minutes' then
    raise exception 'Undo only works for 15 minutes. Move them back by hand.';
  end if;
  if exists (select 1 from events where details ->> 'undo_of' = p_batch::text) then raise exception 'Already undone'; end if;
  for e in select * from events where batch_id = p_batch and type = 'move' order by id desc loop
    select * into p from pallets where id = e.pallet_id for update;
    if p.slot_id is distinct from e.to_slot_id then
      raise exception '% has moved again since. Undo stopped, nothing was changed.', p.code;
    end if;
  end loop;
  for e in select * from events where batch_id = p_batch and type = 'move' order by id desc loop
    select * into p from pallets where id = e.pallet_id;
    insert into events (user_email, type, pallet_id, from_slot_id, to_slot_id, lbs, note, batch_id, details)
    values (current_email(), case when e.from_slot_id is null then 'unslot' else 'move' end, p.id, p.slot_id, e.from_slot_id,
            p.current_weight, 'Undo', b, jsonb_build_object('kind', 'undo', 'undo_of', p_batch));
    update pallets set slot_id = e.from_slot_id, status = case when e.from_slot_id is null then 'unslotted' else 'in_freezer' end,
           updated_at = now() where id = p.id;
    if p.kind = 'mixed' then
      update pallets set slot_id = e.from_slot_id, status = case when e.from_slot_id is null then 'unslotted' else 'in_freezer' end
       where container_id = p.id;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- remove a pallet ----------
-- p_reason: 'used' (adjusted to 0), 'shipped' (left outside the app), 'mistake' (entered by mistake)
create or replace function remove_pallet(p_pallet_id bigint, p_reason text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare p pallets; lo text;
begin
  perform require_staff();
  select * into p from pallets where id = p_pallet_id for update;
  if p.id is null then raise exception 'Pallet not found'; end if;
  if p.status not in ('in_freezer','unslotted') then raise exception '% isn''t in inventory', p.code; end if;
  if p.kind = 'mixed' and exists (select 1 from pallets where container_id = p.id and status in ('in_freezer','unslotted')) then
    raise exception '% still has packages on it. Remove those first, or break it apart.', p.code;
  end if;
  lo := pallet_open_load(p.id);
  if lo is not null then raise exception '% is on load %. Take it off the load first.', p.code, lo; end if;
  if p_reason not in ('used','shipped','mistake') then raise exception 'Pick a reason'; end if;
  if p_reason = 'mistake' and nullif(trim(p_note), '') is null then raise exception 'Say what the mistake was'; end if;
  insert into events (user_email, type, pallet_id, from_slot_id, lbs, note, details)
  values (current_email(), 'removed', p.id, p.slot_id, p.current_weight, p_note,
          jsonb_build_object('reason', p_reason, 'weight', p.current_weight, 'tag', p.package_tag));
  update pallets set
    status = case p_reason when 'used' then 'depleted' when 'shipped' then 'shipped' else 'archived' end,
    current_weight = case when p_reason = 'used' then 0 else current_weight end,
    slot_id = null, container_id = null,
    needs_review = case when p_reason = 'mistake' then 'Entered by mistake: ' || trim(p_note) else needs_review end,
    updated_at = now()
   where id = p.id;
  if p.package_tag is not null and p_reason = 'shipped' then perform ack_shipped_tag(p.package_tag); end if;
end $$;

revoke execute on function apply_moves(jsonb, text), undo_batch(uuid), remove_pallet(bigint, text, text) from public, anon;
grant execute on function apply_moves(jsonb, text), undo_batch(uuid), remove_pallet(bigint, text, text) to authenticated;

-- view-as stays read-only for these too (no_view_as runs inside require_staff)

-- check
select f.site, f.kind, count(s.id) as positions from freezers f join slots s on s.freezer_id = f.id where f.kind = 'staging' group by 1, 2;
