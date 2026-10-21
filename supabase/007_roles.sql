-- Migration 007: user roles (Admin, Sales, Crew, Customer) and the database lockdown.
-- Run once in Supabase: SQL Editor > New query > paste > Run. Safe to re-run.
--
--   Admin    everything, plus Settings > Users
--   Sales    everything except Users
--   Crew     freezers, pallets, loads, vehicles, strains. Sees customer NAMES only (no contacts,
--            licenses, reserves, orders or prices)
--   Customer nothing in the freezer app. The order portal (coming next) gives them their own data only
--   None     blocked (use this to turn someone off)
--
-- New Microsoft sign-ins from a staff domain (lifted-organics.com) start as Crew.
-- Anyone else (other domains, email logins) has no access until an Admin adds them.

set client_min_messages = warning;

-- ---------- tables ----------
create table if not exists staff_domains (domain text primary key);
insert into staff_domains values ('lifted-organics.com') on conflict do nothing;

create table if not exists app_users (
  email        text primary key check (email = lower(trim(email)) and email like '%@%'),
  role         text not null check (role in ('admin','sales','crew','customer','none')),
  customer_id  int references customers(id),
  display_name text,
  added_by     text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  last_seen    timestamptz,
  constraint customer_needs_account check (role <> 'customer' or customer_id is not null)
);

insert into app_users (email, role, display_name, added_by)
values ('aziz@lifted-organics.com', 'admin', 'Aziz', 'setup')
on conflict (email) do update set role = 'admin';

-- ---------- who is asking ----------
create or replace function jwt_email() returns text
language sql stable security definer set search_path = public as $$ select lower(trim(auth.jwt() ->> 'email')) $$;

create or replace function my_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select role from app_users where email = jwt_email()),
    case when split_part(jwt_email(), '@', 2) in (select domain from staff_domains) then 'crew' end,
    'none')
$$;

create or replace function is_staff() returns boolean language sql stable as $$ select my_role() in ('admin','sales','crew') $$;
create or replace function is_sales() returns boolean language sql stable as $$ select my_role() in ('admin','sales') $$;
create or replace function is_admin() returns boolean language sql stable as $$ select my_role() = 'admin' $$;

create or replace function require_staff() returns void
language plpgsql stable as $$
begin
  if not is_staff() then
    raise exception 'Your account doesn''t have access to the freezer map. Ask an admin to set your role.';
  end if;
end $$;

-- called by the app on sign-in: records the visit and adds new staff to the Users list
create or replace function whoami() returns jsonb
language plpgsql security definer set search_path = public as $$
declare e text := jwt_email(); r text := my_role(); u app_users;
begin
  if e is null then return null; end if;
  if r = 'crew' and not exists (select 1 from app_users where email = e) then
    insert into app_users (email, role, display_name, added_by)
    values (e, 'crew', coalesce(auth.jwt() -> 'user_metadata' ->> 'full_name', auth.jwt() -> 'user_metadata' ->> 'name'), 'first sign-in');
  end if;
  update app_users set last_seen = now() where email = e returning * into u;
  return jsonb_build_object('email', e, 'role', r, 'display_name', u.display_name, 'customer_id', u.customer_id,
                            'customer_name', (select name from customers where id = u.customer_id));
end $$;

-- ---------- guard every freezer-app action ----------
-- adds "perform require_staff();" as the first line of each action, so only staff can change anything
do $$
declare f record; def text; at int;
begin
  for f in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = any(array[
       'move_pallet','set_freezer_status','clear_review','split_pallet','merge_pallets','set_tag','adjust_weight',
       'create_mixed_pallet','add_to_mixed','take_off_mixed','break_mixed','create_single_pallet',
       'create_load','update_load','set_stops','plan_pallet','move_item','arrange_load','remove_item',
       'load_pallet','unload_pallet','depart_load','deliver_stop','cancel_load'])
  loop
    def := pg_get_functiondef(f.oid);
    continue when def like '%require_staff()%';
    at := regexp_instr(def, '\mbegin\M', strpos(def, '$function$'), 1, 1, 'i');
    if at = 0 then raise exception 'could not guard %', f.oid::regprocedure; end if;
    execute substr(def, 1, at - 1) || E'\n  perform require_staff();' || substr(def, at);
  end loop;
end $$;

-- internal helpers are only used inside the actions above
do $$
declare f record;
begin
  for f in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = any(array[
       'check_destination','tag_in_use','slot_ok','pallet_open_load','position_check','load_open','assert_loose','mix_line'])
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.oid::regprocedure);
  end loop;
end $$;

-- ---------- who can read and edit what ----------
do $$
declare t text;
begin
  foreach t in array array['freezers','slots','pallets','events','loads','load_stops','load_items','vehicles','strains','customers'] loop
    execute format('drop policy if exists read_all on %I', t);
    execute format('drop policy if exists add_row on %I', t);
    execute format('drop policy if exists edit_row on %I', t);
  end loop;
  foreach t in array array['freezers','slots','pallets','events','loads','load_stops','load_items','vehicles','strains'] loop
    execute format('create policy read_all on %I for select to authenticated using (is_staff())', t);
  end loop;
  foreach t in array array['vehicles','strains'] loop
    execute format('create policy add_row  on %I for insert to authenticated with check (is_staff())', t);
    execute format('create policy edit_row on %I for update to authenticated using (is_staff()) with check (is_staff())', t);
  end loop;
end $$;

-- the activity log hides customer-detail edits from Crew (they hold contacts and licenses)
drop policy if exists read_all on events;
create policy read_all on events for select to authenticated
  using (is_staff() and (is_sales() or not (type = 'settings' and details ->> 'list' = 'customers')));

-- customer details: Admin and Sales only
create policy read_all on customers for select to authenticated using (is_sales());
create policy add_row  on customers for insert to authenticated with check (is_sales());
create policy edit_row on customers for update to authenticated using (is_sales()) with check (is_sales());

-- Crew still needs customer names for loads
create or replace view customer_names with (security_barrier) as
  select id, name, kind, active from customers where is_staff();
grant select on customer_names to authenticated;
revoke all on customer_names from anon;

-- ---------- Users (Admin only) ----------
alter table app_users enable row level security;
alter table staff_domains enable row level security;
drop policy if exists read_users on app_users;
create policy read_users on app_users for select to authenticated using (is_admin() or email = jwt_email());
drop policy if exists read_domains on staff_domains;
create policy read_domains on staff_domains for select to authenticated using (is_admin());
grant select on app_users, staff_domains to authenticated;

create or replace function set_user(p_email text, p_role text, p_customer int default null, p_name text default null)
returns app_users
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email)); was app_users; u app_users;
begin
  if not is_admin() then raise exception 'Only an admin can change users'; end if;
  if p_role not in ('admin','sales','crew','customer','none') then raise exception 'Unknown role %', p_role; end if;
  if p_role = 'customer' and p_customer is null then raise exception 'Pick which customer this login belongs to'; end if;
  select * into was from app_users where email = e;
  if was.role = 'admin' and p_role <> 'admin' and (select count(*) from app_users where role = 'admin') = 1 then
    raise exception 'There has to be at least one admin';
  end if;
  insert into app_users (email, role, customer_id, display_name, added_by)
  values (e, p_role, case when p_role = 'customer' then p_customer end, nullif(trim(p_name), ''), current_email())
  on conflict (email) do update
    set role = excluded.role, customer_id = excluded.customer_id,
        display_name = coalesce(excluded.display_name, app_users.display_name), updated_at = now()
  returning * into u;
  insert into events (user_email, type, note, details)
  values (current_email(), 'user_role', e,
          jsonb_build_object('email', e, 'role', p_role, 'was', was.role, 'customer_id', u.customer_id));
  return u;
end $$;

create or replace function remove_user(p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email)); was app_users;
begin
  if not is_admin() then raise exception 'Only an admin can change users'; end if;
  select * into was from app_users where email = e;
  if was.role = 'admin' and (select count(*) from app_users where role = 'admin') = 1 then
    raise exception 'There has to be at least one admin';
  end if;
  delete from app_users where email = e;
  insert into events (user_email, type, note, details)
  values (current_email(), 'user_removed', e, jsonb_build_object('email', e, 'was', was.role));
end $$;

revoke execute on function set_user(text,text,int,text), remove_user(text), whoami() from public, anon;
grant execute on function set_user(text,text,int,text), remove_user(text), whoami() to authenticated;

-- everyone who has already signed in shows up in Users (staff domains as Crew)
do $$
begin
  if to_regclass('auth.users') is not null then
    insert into app_users (email, role, display_name, added_by, last_seen)
    select lower(u.email), 'crew', coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name'), 'existing sign-in', u.last_sign_in_at
      from auth.users u
     where u.email is not null and split_part(lower(u.email), '@', 2) in (select domain from staff_domains)
    on conflict (email) do update set last_seen = excluded.last_seen,
      display_name = coalesce(app_users.display_name, excluded.display_name);
  end if;
end $$;

-- check: you should see yourself as admin
select email, role, display_name from app_users order by role, email;
