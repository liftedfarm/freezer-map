-- Lifted Freezer Map: database schema
-- Run once in Supabase: SQL Editor > New query > paste > Run

-- ---------- Tables ----------

create table if not exists freezers (
  id          serial primary key,
  site        text not null check (site in ('OHR','GVR')),
  number      int  not null,
  status      text not null default 'On'
              check (status in ('On','Off','Needs Attention','Not Working')),
  notes       text,
  unique (site, number)
);

-- 18 slots per freezer: 2 columns x 9 rows. Row 1 is the back, row 9 the door.
create table if not exists slots (
  id          serial primary key,
  freezer_id  int not null references freezers(id) on delete cascade,
  code        text not null,          -- e.g. 14C
  col         smallint not null check (col in (1,2)),
  row         smallint not null check (row between 1 and 9),
  front_rank  smallint not null,      -- 1 = closest to the door
  unique (freezer_id, code),
  unique (freezer_id, col, row)
);

create table if not exists pallets (
  id             bigserial primary key,
  code           text not null unique,     -- pallet number, uppercase (P412, W65, G238, T011)
  label          text,                     -- original text from the sheet if different
  strain         text,
  zone           text,
  harvest_date   date,
  planting_date  date,
  og_weight      numeric(10,2),
  current_weight numeric(10,2),
  package_tag    text,                     -- METRC package UID
  parent_id      bigint references pallets(id),
  status         text not null default 'unslotted'
                 check (status in ('in_freezer','unslotted','shipped','depleted','archived')),
  slot_id        int references slots(id),
  tag_pending    boolean not null default false,
  needs_review   text,                     -- reason, null when clean
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check ((status = 'in_freezer') = (slot_id is not null))
);
create index if not exists pallets_slot_idx   on pallets(slot_id);
create index if not exists pallets_status_idx on pallets(status);
create index if not exists pallets_strain_idx on pallets(strain);
create index if not exists pallets_tag_idx    on pallets(package_tag);

-- Every change is an event. Never updated or deleted.
create table if not exists events (
  id            bigserial primary key,
  at            timestamptz not null default now(),
  user_email    text,
  type          text not null,   -- import, move, unslot, freezer_status, review_cleared
  pallet_id     bigint references pallets(id),
  freezer_id    int references freezers(id),
  from_slot_id  int references slots(id),
  to_slot_id    int references slots(id),
  lbs           numeric(10,2),
  note          text,
  details       jsonb
);
create index if not exists events_pallet_idx on events(pallet_id, at desc);
create index if not exists events_at_idx     on events(at desc);

-- ---------- Helpers ----------

create or replace function current_email() returns text
language sql stable as $$
  select coalesce(auth.jwt() ->> 'email', 'unknown')
$$;

-- ---------- Actions (the only way to change data) ----------

-- Move a pallet to a slot. Pass null for p_to_slot to take it out of the
-- freezer to staging ("unslotted"). Set p_combine to share an occupied slot.
create or replace function move_pallet(
  p_pallet_id bigint,
  p_to_slot   int,
  p_combine   boolean default false,
  p_note      text default null
) returns pallets
language plpgsql security definer set search_path = public as $$
declare
  p        pallets;
  f        freezers;
  others   int;
begin
  select * into p from pallets where id = p_pallet_id for update;
  if not found then raise exception 'Pallet not found'; end if;
  if p.status not in ('in_freezer','unslotted') then
    raise exception 'Pallet % is %, it cannot be moved', p.code, p.status;
  end if;
  if p.slot_id is not distinct from p_to_slot then
    raise exception 'Pallet % is already there', p.code;
  end if;

  if p_to_slot is not null then
    select fz.* into f from slots s join freezers fz on fz.id = s.freezer_id
      where s.id = p_to_slot for update of fz;
    if not found then raise exception 'Slot not found'; end if;
    if f.status = 'Not Working' then
      raise exception 'Freezer % is marked Not Working', f.number;
    end if;
    select count(*) into others from pallets where slot_id = p_to_slot and id <> p.id;
    if others > 0 and not p_combine then
      raise exception 'That slot is occupied. Choose combine to share it.';
    end if;
  end if;

  insert into events(user_email, type, pallet_id, from_slot_id, to_slot_id, lbs, note)
  values (current_email(),
          case when p_to_slot is null then 'unslot' else 'move' end,
          p.id, p.slot_id, p_to_slot, p.current_weight, p_note);

  update pallets
     set slot_id = p_to_slot,
         status = case when p_to_slot is null then 'unslotted' else 'in_freezer' end,
         updated_at = now()
   where id = p.id
  returning * into p;
  return p;
end $$;

create or replace function set_freezer_status(
  p_freezer_id int,
  p_status     text,
  p_note       text default null
) returns freezers
language plpgsql security definer set search_path = public as $$
declare f freezers; old text;
begin
  select status into old from freezers where id = p_freezer_id for update;
  if not found then raise exception 'Freezer not found'; end if;
  update freezers set status = p_status where id = p_freezer_id returning * into f;
  insert into events(user_email, type, freezer_id, note, details)
  values (current_email(), 'freezer_status', p_freezer_id, p_note,
          jsonb_build_object('from', old, 'to', p_status));
  return f;
end $$;

create or replace function clear_review(
  p_pallet_id bigint,
  p_note      text default null
) returns pallets
language plpgsql security definer set search_path = public as $$
declare p pallets;
begin
  select * into p from pallets where id = p_pallet_id for update;
  if not found then raise exception 'Pallet not found'; end if;
  insert into events(user_email, type, pallet_id, note, details)
  values (current_email(), 'review_cleared', p.id, p_note,
          jsonb_build_object('reason', p.needs_review));
  update pallets set needs_review = null, updated_at = now()
   where id = p.id returning * into p;
  return p;
end $$;

-- ---------- Security ----------
-- Signed-in users can read everything. Writes only go through the
-- functions above, which log who did what.

alter table freezers enable row level security;
alter table slots    enable row level security;
alter table pallets  enable row level security;
alter table events   enable row level security;

drop policy if exists read_all on freezers;
drop policy if exists read_all on slots;
drop policy if exists read_all on pallets;
drop policy if exists read_all on events;
create policy read_all on freezers for select to authenticated using (true);
create policy read_all on slots    for select to authenticated using (true);
create policy read_all on pallets  for select to authenticated using (true);
create policy read_all on events   for select to authenticated using (true);

revoke all on function move_pallet(bigint,int,boolean,text)   from public, anon;
revoke all on function set_freezer_status(int,text,text)      from public, anon;
revoke all on function clear_review(bigint,text)              from public, anon;
grant execute on function move_pallet(bigint,int,boolean,text) to authenticated;
grant execute on function set_freezer_status(int,text,text)    to authenticated;
grant execute on function clear_review(bigint,text)            to authenticated;

-- Live updates so everyone sees moves as they happen
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table pallets, freezers;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
