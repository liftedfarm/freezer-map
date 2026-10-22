-- Migration 018: modules (features only some users can see), sites, fields, and more strain details.
-- Run once in Supabase after 017_plan_moves.sql: SQL Editor > New query > paste > Run. Safe to re-run.
--
--  * Modules: each user has a list of extra modules switched on (Settings > Users, Admin only).
--    A module's screens, tables and actions only work for users who have it. Starts with
--    'cultivation', switched on for Aziz only while it's being built.
--  * Sites (OHR, GVR) get their own settings: license, row feet per acre, dry ice per box, truck size,
--    work day, default crew rates.
--  * Fields: the growing areas on each site (OHR 1A..8B, GVR 1..6). Pallet zones, harvest log fields and
--    planting zones all match to these, whatever way they were typed ("Block 1- A", "1A", "Field 8A").
--  * Strains get a Roshi name, lineage and breeder.
set client_min_messages = warning;

-- ---------- modules ----------
alter table app_users add column if not exists modules text[] not null default '{}';
update app_users set modules = array_append(modules, 'cultivation')
 where email = 'aziz@lifted-organics.com' and not ('cultivation' = any(modules));

create or replace function has_module(m text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_staff() and exists (select 1 from app_users where email = jwt_email() and m = any(modules))
$$;

create or replace function my_modules() returns text[]
language sql stable security definer set search_path = public as $$
  select case when is_staff() then coalesce((select modules from app_users where email = jwt_email()), '{}') else '{}' end
$$;

create or replace function require_module(m text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  perform no_view_as();
  if not has_module(m) then raise exception 'The % module isn''t switched on for your account', m; end if;
end $$;

create or replace function set_user_modules(p_email text, p_modules text[]) returns void
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email)); was text[];
begin
  perform no_view_as();
  if not is_admin() then raise exception 'Only an admin can change modules'; end if;
  select modules into was from app_users where email = e;
  if not found then raise exception 'User not found'; end if;
  update app_users set modules = coalesce(p_modules, '{}'), updated_at = now() where email = e;
  insert into events (user_email, type, note, details)
  values (current_email(), 'user_modules', e, jsonb_build_object('email', e, 'modules', p_modules, 'was', was));
end $$;

revoke execute on function has_module(text), my_modules(), require_module(text), set_user_modules(text, text[]) from public, anon;
grant execute on function has_module(text), my_modules(), set_user_modules(text, text[]) to authenticated;

-- ---------- strains ----------
alter table strains add column if not exists roshi_name text;
alter table strains add column if not exists lineage text;
alter table strains add column if not exists breeder text;

-- ---------- sites ----------
create table if not exists sites (
  code               text primary key,
  name               text not null,
  license            text,
  row_feet_per_acre  numeric not null default 13068,   -- 40" beds = 13,068 row ft per acre, 60" beds = 17,424
  dry_ice_per_10lb   numeric not null default 3,       -- lbs of dry ice per 10 lb box of fresh frozen
  truck_raw_lbs      numeric not null default 10000,   -- raw weight per truck (dry harvests)
  workday_hours      numeric not null default 8,
  deleaf_rate        numeric,                          -- default plants per man-hour
  buck_rate          numeric,                          -- default lbs per man-hour
  dry_conversion     numeric not null default 0.075,   -- wet to dry flower
  sort               int not null default 0,
  updated_at         timestamptz not null default now()
);
insert into sites (code, name, license, row_feet_per_acre, dry_ice_per_10lb, truck_raw_lbs, workday_hours, sort)
values ('OHR', 'Oak Hill Ranch', 'CCL25-0000017', 13068, 3, 10000, 7.5, 1),
       ('GVR', '1363 GV', 'CCL25-0000175', 17424, 2, 10000, 8, 2)
on conflict (code) do nothing;

-- ---------- fields ----------
create table if not exists fields (
  id       serial primary key,
  site     text not null references sites(code),
  code     text not null,                 -- 1A, 2, 8B
  name     text not null,                 -- Block 1- A
  aliases  text[] not null default '{}',  -- other ways it gets written
  acres    numeric,                       -- net planted acres
  kind     text not null default 'flower' check (kind in ('flower','biomass','both','trials','nursery')),
  active   boolean not null default true,
  notes    text,
  sort     int not null default 0,
  updated_at timestamptz not null default now()
);
create unique index if not exists fields_site_code_uq on fields (site, lower(code));

insert into fields (site, code, name, acres, kind, sort) values
  ('OHR', '1A', 'Block 1- A', 7.33, 'flower', 1), ('OHR', '1B', 'Block 1- B', 8.42, 'flower', 2),
  ('OHR', '1C', 'Block 1- C', 8.00, 'flower', 3), ('OHR', '1D', 'Block 1- D', 7.86, 'flower', 4),
  ('OHR', '2',  'Block 2',    10.47, 'flower', 5), ('OHR', '3',  'Block 3',    1.04, 'trials', 6),
  ('OHR', '6',  'Block 6',    15.2,  'biomass', 7), ('OHR', '7',  'Block 7',    9.14, 'flower', 8),
  ('OHR', '8A', 'Block 8- A', 8.6,   'biomass', 9), ('OHR', '8B', 'Block 8- B', null, 'biomass', 10),
  ('GVR', '1', 'Field 1', null, 'flower', 1), ('GVR', '2', 'Field 2', null, 'flower', 2), ('GVR', '3', 'Field 3', null, 'flower', 3),
  ('GVR', '4', 'Field 4', null, 'flower', 4), ('GVR', '5', 'Field 5', null, 'flower', 5), ('GVR', '6', 'Field 6', null, 'flower', 6)
on conflict do nothing;
update fields set aliases = array['Block 1- C/D'] where site = 'OHR' and code = '1C' and aliases = '{}';

-- "Block 1- A", "Field 8A", "1a", "Block 2" -> the field id on that site
create or replace function norm_field(p text) returns text
language sql immutable as $$
  select regexp_replace(lower(coalesce(p, '')), '(block|field|zone|[^a-z0-9/])', '', 'g')
$$;

create or replace function field_id(p_site text, p_text text) returns int
language sql stable security definer set search_path = public as $$
  select f.id from fields f
   where f.site = upper(trim(p_site)) and norm_field(p_text) <> ''
     and (norm_field(f.code) = norm_field(p_text) or norm_field(f.name) = norm_field(p_text)
          or norm_field(p_text) = any(select norm_field(a) from unnest(f.aliases) a))
   order by f.id limit 1
$$;

-- settings changes are logged like the other lists
create or replace function log_site_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  insert into events(user_email, type, note, details)
  values (current_email(), 'settings', case when tg_op = 'INSERT' then 'added' else 'updated' end,
          jsonb_build_object('list', tg_table_name, 'name', coalesce(to_jsonb(new) ->> 'name', to_jsonb(new) ->> 'code'),
                             'was', case when tg_op = 'UPDATE' then to_jsonb(old) - 'updated_at' end));
  return new;
end $$;
drop trigger if exists sites_log on sites;
drop trigger if exists fields_log on fields;
create trigger sites_log  before insert or update on sites  for each row execute function log_site_change();
create trigger fields_log before insert or update on fields for each row execute function log_site_change();

alter table sites  enable row level security;
alter table fields enable row level security;
drop policy if exists read_all on sites;   drop policy if exists edit_row on sites;
drop policy if exists read_all on fields;  drop policy if exists add_row on fields;  drop policy if exists edit_row on fields;
create policy read_all on sites  for select to authenticated using (is_staff());
create policy edit_row on sites  for update to authenticated using (has_module('cultivation')) with check (has_module('cultivation') and not impersonating());
create policy read_all on fields for select to authenticated using (is_staff());
create policy add_row  on fields for insert to authenticated with check (has_module('cultivation') and not impersonating());
create policy edit_row on fields for update to authenticated using (has_module('cultivation')) with check (has_module('cultivation') and not impersonating());
grant select, update on sites to authenticated;
grant select, insert, update on fields to authenticated;
grant usage on sequence fields_id_seq to authenticated;
revoke execute on function field_id(text, text) from public, anon;
grant execute on function field_id(text, text), norm_field(text) to authenticated;

-- check: your modules
select email, role, modules from app_users where modules <> '{}';
