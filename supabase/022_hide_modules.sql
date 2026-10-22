-- Migration 022: Admins can hide modules per user (Settings > Users), including Distribution, which everyone has by default.
-- Run once in Supabase after 021_reserve_batches.sql: SQL Editor > New query > paste > Run. Safe to re-run.
-- Note: hiding a module takes it out of that person's menus. Production data is also locked on the server (has_module);
-- Distribution data isn't locked by module yet (roles still decide that). We'll tighten this when we revisit roles.
set client_min_messages = warning;

alter table app_users add column if not exists hidden_modules text[] not null default '{}';

-- a hidden module is off even if it's switched on
create or replace function has_module(m text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_staff() and exists (select 1 from app_users where email = jwt_email() and m = any(modules) and not (m = any(hidden_modules)))
$$;

create or replace function my_modules() returns text[]
language sql stable security definer set search_path = public as $$
  select case when is_staff() then coalesce((select array(select x from unnest(modules) x where not (x = any(hidden_modules))) from app_users where email = jwt_email()), '{}') else '{}' end
$$;

create or replace function my_hidden_modules() returns text[]
language sql stable security definer set search_path = public as $$
  select case when is_staff() then coalesce((select hidden_modules from app_users where email = jwt_email()), '{}') else '{}' end
$$;

create or replace function set_user_hidden_modules(p_email text, p_hidden text[]) returns void
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email)); was text[];
begin
  perform no_view_as();
  if not is_admin() then raise exception 'Only an admin can hide modules'; end if;
  select hidden_modules into was from app_users where email = e;
  if not found then raise exception 'No user %', e; end if;
  update app_users set hidden_modules = coalesce(p_hidden, '{}'), updated_at = now() where email = e;
  insert into events (user_email, type, note, details)
  values (current_email(), 'user_hidden_modules', e, jsonb_build_object('email', e, 'hidden', p_hidden, 'was', was));
end $$;

revoke execute on function my_hidden_modules(), set_user_hidden_modules(text, text[]) from public, anon;
grant execute on function my_hidden_modules(), set_user_hidden_modules(text, text[]) to authenticated;

select 'ok' as hide_modules;
