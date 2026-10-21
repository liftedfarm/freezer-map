-- Migration 003: Settings lists (vehicles, customers, strains)
-- Run once in Supabase: SQL Editor > New query > paste > Run. Safe to re-run.

create table if not exists vehicles (
  id         serial primary key,
  name       text not null,
  plate      text,
  kind       text,            -- Reefer truck, Box truck, Van, Trailer...
  notes      text,
  active     boolean not null default true,
  updated_at timestamptz not null default now()
);
create unique index if not exists vehicles_name_uq on vehicles (lower(name));

create table if not exists customers (
  id         serial primary key,
  name       text not null,
  kind       text not null default 'external' check (kind in ('internal','external')),
  license    text,            -- state license #
  address    text,
  contact    text,            -- name / phone / email
  notes      text,
  active     boolean not null default true,
  updated_at timestamptz not null default now()
);
create unique index if not exists customers_name_uq on customers (lower(name));

create table if not exists strains (
  id         serial primary key,
  name       text not null,
  aliases    text[] not null default '{}',   -- other spellings that should match this strain
  color      text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  notes      text,
  active     boolean not null default true,
  updated_at timestamptz not null default now()
);
create unique index if not exists strains_name_uq on strains (lower(name));

-- built-in internal destinations
insert into customers (name, kind, notes)
select v.name, 'internal', 'Lifted site' from (values ('OHR'), ('GVR')) v(name)
 where not exists (select 1 from customers c where lower(c.name) = lower(v.name));

-- start the strain list from every strain already on a pallet (most common spelling wins)
insert into strains (name)
select name from (
  select distinct on (lower(trim(strain))) trim(strain) as name
    from (select strain, count(*) n from pallets where strain is not null and trim(strain) <> '' group by strain) x
   order by lower(trim(strain)), n desc) s
 where not exists (select 1 from strains t where lower(t.name) = lower(s.name));

-- every change to a settings list is logged in the activity log
create or replace function log_settings_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  insert into events(user_email, type, note, details)
  values (current_email(), 'settings',
          case when tg_op = 'INSERT' then 'added' else 'updated' end,
          jsonb_build_object('list', tg_table_name, 'name', new.name,
                             'active', new.active,
                             'was', case when tg_op = 'UPDATE' then to_jsonb(old) - 'updated_at' else null end));
  return new;
end $$;

drop trigger if exists vehicles_log on vehicles;
drop trigger if exists customers_log on customers;
drop trigger if exists strains_log on strains;
create trigger vehicles_log  before insert or update on vehicles  for each row execute function log_settings_change();
create trigger customers_log before insert or update on customers for each row execute function log_settings_change();
create trigger strains_log   before insert or update on strains   for each row execute function log_settings_change();

-- everyone signed in can read and edit these lists (no deleting: retire instead)
alter table vehicles  enable row level security;
alter table customers enable row level security;
alter table strains   enable row level security;
do $$
declare t text;
begin
  foreach t in array array['vehicles','customers','strains'] loop
    execute format('drop policy if exists read_all on %I', t);
    execute format('drop policy if exists add_row on %I', t);
    execute format('drop policy if exists edit_row on %I', t);
    execute format('create policy read_all on %I for select to authenticated using (true)', t);
    execute format('create policy add_row  on %I for insert to authenticated with check (true)', t);
    execute format('create policy edit_row on %I for update to authenticated using (true) with check (true)', t);
    execute format('grant select, insert, update on %I to authenticated', t);
    execute format('grant usage on sequence %I to authenticated', t || '_id_seq');
  end loop;
end $$;

-- the internal sites can't be renamed or switched to external
create or replace function protect_internal() returns trigger language plpgsql as $$
begin
  if old.kind = 'internal' and old.name in ('OHR','GVR') and (new.name <> old.name or new.kind <> 'internal' or not new.active) then
    raise exception '% is a Lifted site and can''t be renamed, retired or made external', old.name;
  end if;
  return new;
end $$;
drop trigger if exists customers_protect on customers;
create trigger customers_protect before update on customers for each row execute function protect_internal();
