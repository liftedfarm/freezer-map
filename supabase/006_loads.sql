-- Migration 006: Loads and Transit
-- Run once in Supabase: SQL Editor > New query > paste > Run. Safe to re-run.

-- ---------- vehicles get a pallet layout ----------
alter table vehicles add column if not exists spaces int not null default 8 check (spaces between 1 and 60);
alter table vehicles add column if not exists across int not null default 2 check (across between 1 and 4);
alter table vehicles add column if not exists owner text;   -- 'Lifted' or the carrier's name

insert into vehicles (name, kind, spaces, across, owner)
select v.name, v.kind, v.spaces, 2, v.owner
  from (values ('20'' Freezer Truck', 'Freezer truck', 8, 'Lifted'),
               ('14'' Freezer Truck', 'Freezer truck', 6, 'Lifted'),
               ('G & R Trucking 53'' Trailer', 'Trailer', 24, 'G & R Trucking (Outside Carrier)'),
               ('R & M Trucking 53'' Trailer', 'Trailer', 24, 'R & M Trucking (Outside Carrier)')) v(name, kind, spaces, owner)
 where not exists (select 1 from vehicles x where lower(x.name) = lower(v.name));

-- ---------- pallets can be on a truck ----------
alter table pallets drop constraint if exists pallets_status_check;
alter table pallets add constraint pallets_status_check
  check (status in ('in_freezer','unslotted','in_transit','shipped','depleted','archived','merged'));
alter table pallets add column if not exists received_site text;   -- set when delivered to OHR/GVR, cleared when slotted

-- ---------- loads ----------
create table if not exists loads (
  id          serial primary key,
  code        text not null,                        -- L-MMDD-# (unique per date)
  load_date   date not null,
  vehicle_id  int not null references vehicles(id),
  status      text not null default 'planning' check (status in ('planning','loading','in_transit','delivered','cancelled')),
  driver      text,
  notes       text,
  created_by  text,
  created_at  timestamptz not null default now(),
  departed_at timestamptz,
  closed_at   timestamptz
);
create unique index if not exists loads_code_date on loads (code, load_date);

create table if not exists load_stops (
  id           serial primary key,
  load_id      int not null references loads(id) on delete cascade,
  seq          int not null,                         -- delivery order, 1 = first stop
  customer_id  int not null references customers(id),
  manifest     text,
  status       text not null default 'pending' check (status in ('pending','delivered')),
  delivered_at timestamptz,
  delivered_by text
);
create table if not exists load_items (
  id         serial primary key,
  load_id    int not null references loads(id) on delete cascade,
  stop_id    int not null references load_stops(id),
  pallet_id  bigint not null references pallets(id),
  position   int not null,                           -- 1 = nose, counts toward the door
  loaded     boolean not null default false,         -- pulled from the freezer onto the truck
  from_slot  int references slots(id),
  created_at timestamptz not null default now()
);
create index if not exists load_items_pallet_idx on load_items(pallet_id);
create index if not exists load_items_load_idx on load_items(load_id);
alter table events add column if not exists load_id int references loads(id);

-- ---------- helpers ----------
create or replace function load_open(l loads) returns void language plpgsql as $$
begin
  if l.status in ('delivered','cancelled') then raise exception 'Load % is %', l.code, l.status; end if;
end $$;

create or replace function pallet_open_load(p_pallet bigint, p_except int default null) returns text
language sql stable as $$
  select l.code from load_items i join loads l on l.id = i.load_id
   where i.pallet_id = p_pallet and l.status in ('planning','loading','in_transit') and l.id is distinct from p_except
   limit 1
$$;

create or replace function position_check(p_load int, p_pos int, p_share boolean, p_ignore int default null) returns void
language plpgsql as $$
declare n int; cap int;
begin
  select v.spaces into cap from loads l join vehicles v on v.id = l.vehicle_id where l.id = p_load;
  if p_pos is null or p_pos < 1 or p_pos > cap then raise exception 'Position % is not on this truck (1 to %)', p_pos, cap; end if;
  select count(*) into n from load_items where load_id = p_load and position = p_pos and id is distinct from p_ignore;
  if n > 0 and not p_share then raise exception 'Position % is taken. Share it or pick another.', p_pos; end if;
end $$;

-- pallets planned on a load can't be merged or pulled for a mixed pallet
create or replace function assert_loose(p pallets, verb text) returns void
language plpgsql as $$
declare c text;
begin
  if p.status not in ('in_freezer','unslotted') then raise exception 'Pallet % is %, it cannot be %', p.code, replace(p.status, '_', ' '), verb; end if;
  if p.container_id is not null then
    select code into c from pallets where id = p.container_id;
    raise exception '% is on mixed pallet %. Take it off first.', p.code, c;
  end if;
  if verb in ('merged','added') then
    c := pallet_open_load(p.id);
    if c is not null then raise exception '% is planned on load %. Remove it from the load first.', p.code, c; end if;
  end if;
end $$;

-- ---------- create / edit ----------
-- p_stops: [{"customer_id": 3, "manifest": "0001234"}] in delivery order
create or replace function create_load(p_vehicle int, p_date date, p_stops jsonb, p_driver text default null, p_notes text default null) returns loads
language plpgsql security definer set search_path = public as $$
declare l loads; d date := coalesce(p_date, (now() at time zone 'America/Los_Angeles')::date); n int; s jsonb; i int := 0;
begin
  if not exists (select 1 from vehicles where id = p_vehicle and active) then raise exception 'Pick a vehicle'; end if;
  if jsonb_array_length(coalesce(p_stops, '[]')) = 0 then raise exception 'Add at least one stop'; end if;
  select coalesce(max(substring(code from 8)::int), 0) + 1 into n from loads where code like 'L-' || to_char(d, 'MMDD') || '-%' and load_date = d;
  insert into loads (code, load_date, vehicle_id, driver, notes, created_by)
  values ('L-' || to_char(d, 'MMDD') || '-' || n, d, p_vehicle, nullif(trim(p_driver), ''), nullif(trim(p_notes), ''), current_email())
  returning * into l;
  for s in select * from jsonb_array_elements(p_stops) loop
    i := i + 1;
    insert into load_stops (load_id, seq, customer_id, manifest) values (l.id, i, (s->>'customer_id')::int, nullif(trim(s->>'manifest'), ''));
  end loop;
  insert into events (user_email, type, load_id, details) values (current_email(), 'load_created', l.id, jsonb_build_object('load', l.code, 'stops', i));
  return l;
end $$;

create or replace function update_load(p_load int, p_vehicle int, p_date date, p_driver text, p_notes text) returns loads
language plpgsql security definer set search_path = public as $$
declare l loads; cap int; maxpos int;
begin
  select * into l from loads where id = p_load for update;
  if not found then raise exception 'Load not found'; end if;
  perform load_open(l);
  select spaces into cap from vehicles where id = p_vehicle;
  if cap is null then raise exception 'Pick a vehicle'; end if;
  select max(position) into maxpos from load_items where load_id = l.id;
  if maxpos > cap then raise exception 'That vehicle only has % spaces; pallets are planned up to position %. Rearrange first.', cap, maxpos; end if;
  update loads set vehicle_id = p_vehicle, load_date = coalesce(p_date, load_date), driver = nullif(trim(p_driver), ''), notes = nullif(trim(p_notes), '')
   where id = l.id returning * into l;
  insert into events (user_email, type, load_id, details) values (current_email(), 'load_updated', l.id, jsonb_build_object('load', l.code));
  return l;
end $$;

-- Replace the stop list. p_stops: [{"id": 5 (existing, optional), "customer_id": 3, "manifest": "..."}]
create or replace function set_stops(p_load int, p_stops jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare l loads; s jsonb; i int := 0; keep int[] := '{}'; sid int;
begin
  select * into l from loads where id = p_load for update;
  if not found then raise exception 'Load not found'; end if;
  perform load_open(l);
  if jsonb_array_length(coalesce(p_stops, '[]')) = 0 then raise exception 'A load needs at least one stop'; end if;
  for s in select * from jsonb_array_elements(p_stops) loop
    i := i + 1;
    if s ? 'id' and (s->>'id') is not null then
      update load_stops set seq = i + 1000, customer_id = (s->>'customer_id')::int, manifest = nullif(trim(s->>'manifest'), '')
       where id = (s->>'id')::int and load_id = l.id returning id into sid;
    else
      insert into load_stops (load_id, seq, customer_id, manifest) values (l.id, i + 1000, (s->>'customer_id')::int, nullif(trim(s->>'manifest'), ''))
      returning id into sid;
    end if;
    keep := keep || sid;
  end loop;
  if exists (select 1 from load_items where load_id = l.id and not (stop_id = any(keep))) then
    raise exception 'A stop you removed still has pallets. Move them to another stop first.';
  end if;
  if exists (select 1 from load_stops where load_id = l.id and not (id = any(keep)) and status = 'delivered') then
    raise exception 'Delivered stops can''t be removed';
  end if;
  delete from load_stops where load_id = l.id and not (id = any(keep));
  update load_stops set seq = seq - 1000 where load_id = l.id;
  insert into events (user_email, type, load_id, details) values (current_email(), 'load_updated', l.id, jsonb_build_object('load', l.code, 'stops', i));
end $$;

-- ---------- planning pallets onto the truck ----------
create or replace function plan_pallet(p_load int, p_stop int, p_pallet bigint, p_position int default null, p_share boolean default false) returns load_items
language plpgsql security definer set search_path = public as $$
declare l loads; p pallets; it load_items; other text; pos int; cap int;
begin
  select * into l from loads where id = p_load for update;
  if not found then raise exception 'Load not found'; end if;
  if l.status not in ('planning','loading') then raise exception 'Load % has already left', l.code; end if;
  if not exists (select 1 from load_stops where id = p_stop and load_id = l.id and status = 'pending') then raise exception 'Pick a stop on this load'; end if;
  select * into p from pallets where id = p_pallet for update;
  if not found then raise exception 'Pallet not found'; end if;
  perform assert_loose(p, 'loaded');
  if p.status <> 'in_freezer' then raise exception '% isn''t in a freezer', p.code; end if;
  other := pallet_open_load(p.id);
  if other is not null then raise exception '% is already on load %', p.code, other; end if;
  select spaces into cap from vehicles where id = l.vehicle_id;
  pos := p_position;
  if pos is null then
    select min(g) into pos from generate_series(1, cap) g where not exists (select 1 from load_items where load_id = l.id and position = g);
    if pos is null then raise exception 'The truck is full (% spaces). Share a position or use a bigger vehicle.', cap; end if;
  else
    perform position_check(l.id, pos, p_share);
  end if;
  insert into load_items (load_id, stop_id, pallet_id, position) values (l.id, p_stop, p.id, pos) returning * into it;
  insert into events (user_email, type, pallet_id, load_id, lbs, details)
  values (current_email(), 'load_planned', p.id, l.id, p.current_weight, jsonb_build_object('load', l.code, 'position', pos));
  return it;
end $$;

create or replace function move_item(p_item int, p_position int, p_stop int default null, p_share boolean default false) returns load_items
language plpgsql security definer set search_path = public as $$
declare it load_items; l loads;
begin
  select * into it from load_items where id = p_item for update;
  if not found then raise exception 'Not found'; end if;
  select * into l from loads where id = it.load_id;
  perform load_open(l);
  if p_stop is not null and not exists (select 1 from load_stops where id = p_stop and load_id = l.id and status = 'pending') then raise exception 'Pick a stop on this load'; end if;
  if p_position is not null and p_position <> it.position then perform position_check(l.id, p_position, p_share, it.id); end if;
  update load_items set position = coalesce(p_position, position), stop_id = coalesce(p_stop, stop_id) where id = it.id returning * into it;
  return it;
end $$;

-- Re-number unloaded pallets: last stop at the nose, first stop at the door. Shared positions stay together.
create or replace function arrange_load(p_load int) returns void
language plpgsql security definer set search_path = public as $$
declare l loads; cap int; free int[]; g record; k int := 0;
begin
  select * into l from loads where id = p_load for update;
  perform load_open(l);
  select spaces into cap from vehicles where id = l.vehicle_id;
  select array_agg(x order by x) into free from generate_series(1, cap) x
   where not exists (select 1 from load_items where load_id = l.id and loaded and position = x);
  for g in
    select i.position, max(s.seq) as last_seq, min(i.id) as first_id
      from load_items i join load_stops s on s.id = i.stop_id
     where i.load_id = l.id and not i.loaded
     group by i.position
     order by max(s.seq) desc, min(i.id)
  loop
    k := k + 1;
    if k > coalesce(array_length(free, 1), 0) then raise exception 'Not enough room on the truck to arrange'; end if;
    update load_items set position = -free[k] where load_id = l.id and not loaded and position = g.position;
  end loop;
  update load_items set position = -position where load_id = l.id and position < 0;
end $$;

create or replace function remove_item(p_item int) returns void
language plpgsql security definer set search_path = public as $$
declare it load_items; l loads; p pallets;
begin
  select * into it from load_items where id = p_item for update;
  if not found then raise exception 'Not found'; end if;
  select * into l from loads where id = it.load_id;
  perform load_open(l);
  select * into p from pallets where id = it.pallet_id;
  if it.loaded then raise exception '% is already on the truck. Put it back in a freezer first.', p.code; end if;
  delete from load_items where id = it.id;
  insert into events (user_email, type, pallet_id, load_id, details)
  values (current_email(), 'load_removed', p.id, l.id, jsonb_build_object('load', l.code));
end $$;

-- ---------- loading: pallet comes out of the freezer onto the truck ----------
create or replace function load_pallet(p_item int) returns void
language plpgsql security definer set search_path = public as $$
declare it load_items; l loads; p pallets;
begin
  select * into it from load_items where id = p_item for update;
  if not found then raise exception 'Not found'; end if;
  select * into l from loads where id = it.load_id for update;
  if l.status not in ('planning','loading') then raise exception 'Load % has already left', l.code; end if;
  if it.loaded then raise exception 'Already on the truck'; end if;
  select * into p from pallets where id = it.pallet_id for update;
  update load_items set loaded = true, from_slot = p.slot_id where id = it.id;
  update pallets set status = 'in_transit', slot_id = null, updated_at = now() where id = p.id or container_id = p.id;
  if l.status = 'planning' then update loads set status = 'loading' where id = l.id; end if;
  insert into events (user_email, type, pallet_id, load_id, from_slot_id, lbs, details)
  values (current_email(), 'loaded', p.id, l.id, p.slot_id, p.current_weight, jsonb_build_object('load', l.code, 'position', it.position));
end $$;

-- Take a loaded pallet off the truck and put it back in a freezer slot (drops it from the load)
create or replace function unload_pallet(p_item int, p_slot int, p_share boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare it load_items; l loads; p pallets;
begin
  select * into it from load_items where id = p_item for update;
  if not found then raise exception 'Not found'; end if;
  select * into l from loads where id = it.load_id;
  if l.status not in ('planning','loading') then raise exception 'Load % has already left', l.code; end if;
  select * into p from pallets where id = it.pallet_id for update;
  perform slot_ok(p_slot, p_share);
  update pallets set status = 'in_freezer', slot_id = p_slot, updated_at = now() where id = p.id or container_id = p.id;
  delete from load_items where id = it.id;
  insert into events (user_email, type, pallet_id, load_id, to_slot_id, details)
  values (current_email(), 'unloaded', p.id, l.id, p_slot, jsonb_build_object('load', l.code));
end $$;

-- ---------- status changes ----------
create or replace function depart_load(p_load int) returns void
language plpgsql security definer set search_path = public as $$
declare l loads; n int;
begin
  select * into l from loads where id = p_load for update;
  if l.status not in ('planning','loading') then raise exception 'Load % is %', l.code, l.status; end if;
  select count(*) into n from load_items where load_id = l.id and not loaded;
  if n > 0 then raise exception '% pallet(s) planned but not loaded yet. Load them or remove them first.', n; end if;
  if not exists (select 1 from load_items where load_id = l.id) then raise exception 'Nothing is on this load'; end if;
  update loads set status = 'in_transit', departed_at = now() where id = l.id;
  insert into events (user_email, type, load_id, details) values (current_email(), 'load_departed', l.id, jsonb_build_object('load', l.code));
end $$;

-- Deliver one stop. External (and internal non-site) customers: pallets leave inventory.
-- OHR / GVR: pallets arrive unslotted at that site and show in Review until put in a slot.
create or replace function deliver_stop(p_stop int) returns void
language plpgsql security definer set search_path = public as $$
declare s load_stops; l loads; c customers; site text; it record;
begin
  select * into s from load_stops where id = p_stop for update;
  if not found then raise exception 'Stop not found'; end if;
  select * into l from loads where id = s.load_id for update;
  if l.status <> 'in_transit' then raise exception 'Load % hasn''t left yet', l.code; end if;
  if s.status = 'delivered' then raise exception 'Already delivered'; end if;
  select * into c from customers where id = s.customer_id;
  site := case when c.kind = 'internal' and upper(c.name) in ('OHR','GVR') then upper(c.name) end;
  for it in select i.*, p.code, p.current_weight from load_items i join pallets p on p.id = i.pallet_id where i.stop_id = s.id loop
    if site is not null then
      update pallets set status = 'unslotted', received_site = site, updated_at = now() where id = it.pallet_id or container_id = it.pallet_id;
    else
      update pallets set status = 'shipped', updated_at = now() where id = it.pallet_id or container_id = it.pallet_id;
    end if;
    insert into events (user_email, type, pallet_id, load_id, lbs, details)
    values (current_email(), case when site is null then 'shipped' else 'received' end, it.pallet_id, l.id, it.current_weight,
            jsonb_build_object('load', l.code, 'customer', c.name, 'manifest', s.manifest));
  end loop;
  update load_stops set status = 'delivered', delivered_at = now(), delivered_by = current_email() where id = s.id;
  insert into events (user_email, type, load_id, details)
  values (current_email(), 'stop_delivered', l.id, jsonb_build_object('load', l.code, 'customer', c.name, 'seq', s.seq));
  if not exists (select 1 from load_stops where load_id = l.id and status = 'pending') then
    update loads set status = 'delivered', closed_at = now() where id = l.id;
  end if;
end $$;

create or replace function cancel_load(p_load int) returns void
language plpgsql security definer set search_path = public as $$
declare l loads;
begin
  select * into l from loads where id = p_load for update;
  if l.status not in ('planning','loading') then raise exception 'Load % is %', l.code, l.status; end if;
  if exists (select 1 from load_items where load_id = l.id and loaded) then raise exception 'Some pallets are already on the truck. Put them back first.'; end if;
  delete from load_items where load_id = l.id;
  update loads set status = 'cancelled', closed_at = now() where id = l.id;
  insert into events (user_email, type, load_id, details) values (current_email(), 'load_cancelled', l.id, jsonb_build_object('load', l.code));
end $$;

-- moving a pallet into a slot clears "received at" (Review list)
create or replace function clear_received() returns trigger language plpgsql as $$
begin
  if new.slot_id is not null and new.received_site is not null then new.received_site := null; end if;
  return new;
end $$;
drop trigger if exists pallets_clear_received on pallets;
create trigger pallets_clear_received before update on pallets for each row execute function clear_received();

-- ---------- security ----------
alter table loads enable row level security;
alter table load_stops enable row level security;
alter table load_items enable row level security;
drop policy if exists read_all on loads;
drop policy if exists read_all on load_stops;
drop policy if exists read_all on load_items;
create policy read_all on loads for select to authenticated using (true);
create policy read_all on load_stops for select to authenticated using (true);
create policy read_all on load_items for select to authenticated using (true);
grant select on loads, load_stops, load_items to authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'create_load(int,date,jsonb,text,text)', 'update_load(int,int,date,text,text)', 'set_stops(int,jsonb)',
    'plan_pallet(int,int,bigint,int,boolean)', 'move_item(int,int,int,boolean)', 'arrange_load(int)', 'remove_item(int)',
    'load_pallet(int)', 'unload_pallet(int,int,boolean)', 'depart_load(int)', 'deliver_stop(int)', 'cancel_load(int)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table loads, load_stops, load_items;
    exception when duplicate_object then null; end;
  end if;
end $$;
