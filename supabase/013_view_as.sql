-- Migration 013: "View as" for Admins. An Admin can see the app exactly as another (non-admin) user sees it:
-- same database permissions, same data. It's read-only: nothing can be changed while viewing as someone.
-- Run once in Supabase after 012_customer_orders.sql. Safe to re-run.
set client_min_messages = warning;

create table if not exists view_as (
  admin_email  text primary key,
  target_email text not null references app_users(email) on delete cascade,
  started_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '2 hours'
);
alter table view_as enable row level security;   -- functions only

create or replace function real_email() returns text
language sql stable security definer set search_path = public as $$ select lower(trim(auth.jwt() ->> 'email')) $$;

-- the Admin's view-as target, if any (only a real Admin signed in with Microsoft can have one)
create or replace function view_as_target() returns text
language sql stable security definer set search_path = public as $$
  select v.target_email from view_as v
   where v.admin_email = real_email() and v.expires_at > now() and jwt_oauth()
     and exists (select 1 from app_users a where a.email = v.admin_email and a.role = 'admin')
     and exists (select 1 from app_users t where t.email = v.target_email and t.role <> 'admin')
$$;

create or replace function impersonating() returns boolean
language sql stable security definer set search_path = public as $$ select view_as_target() is not null $$;

-- everything that asks "who is this?" now answers with the view-as target
create or replace function jwt_email() returns text
language sql stable security definer set search_path = public as $$ select coalesce(view_as_target(), real_email()) $$;

create or replace function my_role() returns text
language sql stable security definer set search_path = public as $$
  select case
    when view_as_target() is not null then
      (select case when u.role = 'customer' and u.customer_id is null then 'none' else u.role end
         from app_users u where u.email = view_as_target())
    else coalesce(
      (select case
                when u.role in ('admin','sales','crew') then case when jwt_oauth() then u.role else 'none' end
                when u.role = 'customer' then case when u.auth_id is not null and u.auth_id = auth.uid() then 'customer' else 'none' end
                else u.role end
         from app_users u where u.email = real_email()),
      case when jwt_oauth() and split_part(real_email(), '@', 2) in (select domain from staff_domains) then 'crew' end,
      'none')
  end
$$;

create or replace function no_view_as() returns void
language plpgsql stable as $$
begin
  if impersonating() then raise exception 'You''re viewing as someone else. Nothing can be changed. Stop "View as" first.'; end if;
end $$;

create or replace function require_staff() returns void
language plpgsql stable as $$
begin
  perform no_view_as();
  if not is_staff() then
    raise exception 'Your account doesn''t have access to the freezer map. Ask an admin to set your role.';
  end if;
end $$;

create or replace function whoami() returns jsonb
language plpgsql security definer set search_path = public as $$
declare e text := jwt_email(); r text := my_role(); u app_users; v boolean := impersonating();
begin
  if e is null then return null; end if;
  if not v then
    if r = 'crew' and not exists (select 1 from app_users where email = e) then
      insert into app_users (email, role, display_name, added_by)
      values (e, 'crew', coalesce(auth.jwt() -> 'user_metadata' ->> 'full_name', auth.jwt() -> 'user_metadata' ->> 'name'), 'first sign-in');
    end if;
    update app_users set last_seen = now() where email = e and r <> 'none';
  end if;
  select * into u from app_users where email = e;
  return jsonb_build_object('email', e, 'role', r,
    'display_name', case when r <> 'none' then u.display_name end,
    'customer_id', case when r = 'customer' then u.customer_id end,
    'customer_name', case when r = 'customer' then (select name from customers where id = u.customer_id) end,
    'viewing_as', v, 'real_email', real_email());
end $$;

create or replace function start_view_as(p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare t app_users;
begin
  if not (jwt_oauth() and exists (select 1 from app_users where email = real_email() and role = 'admin')) then
    raise exception 'Only an Admin can use View as';
  end if;
  select * into t from app_users where email = lower(trim(p_email));
  if t.email is null then raise exception 'User not found'; end if;
  if t.role = 'admin' then raise exception 'You can''t view as another Admin'; end if;
  insert into view_as (admin_email, target_email) values (real_email(), t.email)
  on conflict (admin_email) do update set target_email = excluded.target_email, started_at = now(), expires_at = now() + interval '2 hours';
  insert into events (user_email, type, note, details)
  values (real_email(), 'view_as', t.email, jsonb_build_object('target', t.email, 'role', t.role));
end $$;

create or replace function stop_view_as() returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from view_as where admin_email = real_email();
end $$;

revoke execute on function start_view_as(text), stop_view_as() from public, anon;
grant execute on function start_view_as(text), stop_view_as() to authenticated;

-- every action that changes something refuses while viewing as someone
do $$
declare f record; def text; at int;
begin
  for f in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prolang = (select oid from pg_language where lanname = 'plpgsql') and p.proname = any(array[
       'set_user','remove_user','make_login_link','claim_invite','set_reserve','request_reserve_change','cancel_reserve_request',
       'decide_reserve_request','import_roshi_orders','place_order','cancel_my_order','set_order_status','set_order_line'])
  loop
    def := pg_get_functiondef(f.oid);
    continue when def like '%no_view_as()%';
    at := regexp_instr(def, '\mbegin\M', strpos(def, '$function$'), 1, 1, 'i');
    if at = 0 then raise exception 'could not guard %', f.oid::regprocedure; end if;
    execute substr(def, 1, at - 1) || E'\n  perform no_view_as();' || substr(def, at);
  end loop;
end $$;

-- settings lists: no edits while viewing as someone
drop policy if exists add_row on vehicles;  drop policy if exists edit_row on vehicles;
drop policy if exists add_row on strains;   drop policy if exists edit_row on strains;
drop policy if exists add_row on customers; drop policy if exists edit_row on customers;
create policy add_row  on vehicles  for insert to authenticated with check (is_staff() and not impersonating());
create policy edit_row on vehicles  for update to authenticated using (is_staff()) with check (is_staff() and not impersonating());
create policy add_row  on strains   for insert to authenticated with check (is_staff() and not impersonating());
create policy edit_row on strains   for update to authenticated using (is_staff()) with check (is_staff() and not impersonating());
create policy add_row  on customers for insert to authenticated with check (is_sales() and not impersonating());
create policy edit_row on customers for update to authenticated using (is_sales()) with check (is_sales() and not impersonating());
