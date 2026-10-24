-- Migration 058: access. Run once in Supabase after 057_harvest_push.sql: SQL Editor > New query > paste > Run. Safe to re-run.
--
--  * Module Admins run their own module: add people to it, make Admins in it, change other Admins' access to it.
--    Owners stay above everyone; nobody but an Owner touches an Owner.
--  * Email code login: people without a Lifted Microsoft account sign in with a 6-digit code sent to their email.
--    They can be Users (or View) in modules, never Admins. Owners and module Admins add them.
--  * Permissions: Admin > Settings > Permissions sets, per module, which level can do each action, plus
--    per-person exceptions. It starts out matching how the app worked before.
set client_min_messages = warning;

-- =====================================================================================================
-- 1. email code login
-- =====================================================================================================
alter table app_users add column if not exists login_kind text not null default 'microsoft';
alter table app_users drop constraint if exists app_users_login_kind_check;
alter table app_users add constraint app_users_login_kind_check check (login_kind in ('microsoft','email'));

-- signed in with an email code (Supabase email OTP / magic link)
create or replace function jwt_email_code() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(exists (select 1 from jsonb_array_elements(case when jsonb_typeof(auth.jwt() -> 'amr') = 'array' then auth.jwt() -> 'amr' else '[]' end) a
                          where a ->> 'method' in ('otp','magiclink','email')), false)
$$;

create or replace function my_role() returns text
language sql stable security definer set search_path = public as $$
  select case
    when view_as_target() is not null then
      (select case when u.role = 'customer' and u.customer_id is null then 'none' else u.role end
         from app_users u where u.email = view_as_target())
    else coalesce(
      (select case
                when u.role in ('admin','sales','crew') then
                  case when jwt_oauth() and u.login_kind = 'microsoft' then u.role
                       when jwt_oauth() then u.role
                       when u.login_kind = 'email' and jwt_email_code() then u.role
                       else 'none' end
                when u.role = 'customer' then case when u.auth_id is not null and u.auth_id = auth.uid() then 'customer' else 'none' end
                else u.role end
         from app_users u where u.email = real_email()),
      case when jwt_oauth() and split_part(real_email(), '@', 2) in (select domain from staff_domains) then 'crew' end,
      'none')
  end
$$;

-- an email-login person can't be an Admin of anything (the database refuses it)
create or replace function email_login_no_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.level = 'admin' or new.module = 'admin' then
    if exists (select 1 from app_users where email = new.email and login_kind = 'email') then
      raise exception '% signs in with an email code, so they can''t be an Admin', new.email;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists email_login_no_admin on module_access;
create trigger email_login_no_admin before insert or update on module_access for each row execute function email_login_no_admin();

-- =====================================================================================================
-- 2. permissions grid
-- =====================================================================================================
create table if not exists perm_rules (
  module    text not null,
  action    text not null,
  label     text not null,
  min_level text not null check (min_level in ('view','user','admin','owner')),
  sort      int not null default 0,
  updated_by text, updated_at timestamptz not null default now(),
  primary key (module, action)
);
create table if not exists perm_overrides (
  email   text not null references app_users(email) on update cascade on delete cascade,
  module  text not null,
  action  text not null,
  allow   boolean not null,
  set_by  text, set_at timestamptz not null default now(),
  primary key (email, module, action)
);
alter table perm_rules enable row level security;
alter table perm_overrides enable row level security;
drop policy if exists read_staff on perm_rules;
create policy read_staff on perm_rules for select to authenticated using (is_staff());
drop policy if exists read_own on perm_overrides;
create policy read_own on perm_overrides for select to authenticated using (email = jwt_email() or is_owner() or is_admin() or manages(module));
grant select on perm_rules, perm_overrides to authenticated;

-- defaults = how the app already works
insert into perm_rules (module, action, label, min_level, sort) values
  ('cultivation','push',           'Push harvest pallets to packages',              'user',  10),
  ('cultivation','rename_harvest', 'Rename a harvest''s strain',                     'user',  20),
  ('cultivation','unpush',         'Un-push a pallet',                               'admin', 30),
  ('cultivation','edit_finished',  'Change or reopen a finished harvest',            'admin', 40),
  ('cultivation','tag_rules',      'Change METRC tag rules',                         'admin', 50),
  ('cultivation','people',         'Add people and set their Production access',     'admin', 90),
  ('cultivation','make_admins',    'Make Production Admins',                         'admin', 95),
  ('distribution','people',        'Add people and set their Distribution access',   'admin', 90),
  ('distribution','make_admins',   'Make Distribution Admins',                       'admin', 95),
  ('sales','people',               'Add people and set their Sales access',          'admin', 90),
  ('sales','make_admins',          'Make Sales Admins',                              'admin', 95),
  ('nursery','people',             'Add people and set their Nursery access',        'admin', 90),
  ('nursery','make_admins',        'Make Nursery Admins',                            'admin', 95),
  ('processing','people',          'Add people and set their Processing access',     'admin', 90),
  ('processing','make_admins',     'Make Processing Admins',                         'admin', 95),
  ('accounting','people',          'Add people and set their Accounting access',     'admin', 90),
  ('accounting','make_admins',     'Make Accounting Admins',                         'admin', 95),
  ('compliance','people',          'Add people and set their Compliance access',     'admin', 90),
  ('compliance','make_admins',     'Make Compliance Admins',                         'admin', 95)
on conflict (module, action) do nothing;

create or replace function _lv_rank(l text) returns int language sql immutable as $$
  select case l when 'view' then 1 when 'user' then 2 when 'admin' then 3 when 'owner' then 4 else 0 end
$$;

-- can the signed-in person do this? Owners always; a per-person exception wins; else their level vs the rule
create or replace function can_do(m text, a text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when not coalesce(is_staff(), false) then false
    when is_owner() then true
    when exists (select 1 from perm_overrides o where o.email = jwt_email() and o.module = m and o.action = a)
      then (select o.allow from perm_overrides o where o.email = jwt_email() and o.module = m and o.action = a)
    else _lv_rank(mod_level(m)) >= _lv_rank(coalesce((select r.min_level from perm_rules r where r.module = m and r.action = a), 'admin'))
         and mod_level(m) is not null
  end
$$;

-- what the app needs to show buttons: {"cultivation": {"push": true, ...}, ...}
create or replace function my_perms() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(module, acts), '{}') from (
    select r.module, jsonb_object_agg(r.action, can_do(r.module, r.action)) acts from perm_rules r group by r.module) x
$$;

create or replace function save_perm_rule(p_module text, p_action text, p_min text) returns void
language plpgsql security definer set search_path = public as $$
declare was text;
begin
  perform no_view_as();
  if not (is_owner() or is_admin()) then raise exception 'Only an Owner or someone with the Admin module can change permissions'; end if;
  if p_min not in ('view','user','admin','owner') then raise exception 'Pick View, User, Admin or Owner'; end if;
  if p_action = 'make_admins' and p_min in ('view','user') then raise exception 'Only Admins (or Owners) can make Admins'; end if;
  select min_level into was from perm_rules where module = p_module and action = p_action;
  if was is null then raise exception 'Unknown permission'; end if;
  update perm_rules set min_level = p_min, updated_by = current_email(), updated_at = now() where module = p_module and action = p_action;
  insert into events (user_email, type, note, details) values (current_email(), 'perm_rule', p_module || '.' || p_action,
         jsonb_build_object('module', p_module, 'action', p_action, 'from', was, 'to', p_min));
end $$;

create or replace function save_perm_override(p_email text, p_module text, p_action text, p_allow boolean) returns void
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email));
begin
  perform no_view_as();
  if not (is_owner() or is_admin()) then raise exception 'Only an Owner or someone with the Admin module can set exceptions'; end if;
  if not exists (select 1 from perm_rules where module = p_module and action = p_action) then raise exception 'Unknown permission'; end if;
  if p_allow and p_action = 'make_admins' and exists (select 1 from app_users where email = e and login_kind = 'email') then
    raise exception 'Email-login people can''t make Admins';
  end if;
  if p_allow is null then
    delete from perm_overrides where email = e and module = p_module and action = p_action;
  else
    insert into perm_overrides (email, module, action, allow, set_by) values (e, p_module, p_action, p_allow, current_email())
    on conflict (email, module, action) do update set allow = excluded.allow, set_by = excluded.set_by, set_at = now();
  end if;
  insert into events (user_email, type, note, details) values (current_email(), 'perm_override', e,
         jsonb_build_object('email', e, 'module', p_module, 'action', p_action, 'allow', p_allow));
end $$;

-- =====================================================================================================
-- 3. who manages whom
-- =====================================================================================================
-- manage a module's people: Owners, or anyone the grid lets (by default that module's Admins)
create or replace function manages(m text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_owner() or (m <> 'admin' and can_do(m, 'people'))
$$;

create or replace function save_user(p_email text, p_name text, p_kind text, p_customer int default null,
                                     p_access jsonb default '{}', p_owner boolean default null, p_login text default null)
returns app_users
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email)); was app_users; u app_users; m text; before jsonb; want text; have text; own boolean := is_owner();
        lk text; mine int := 0;
begin
  perform no_view_as();
  if not (own or is_admin() or exists (select 1 from perm_rules r where r.action = 'people' and can_do(r.module, 'people'))) then
    raise exception 'Only Owners and module Admins can change access';
  end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'That email doesn''t look right'; end if;
  if p_kind not in ('staff','customer','none') then raise exception 'Unknown kind %', p_kind; end if;
  if p_kind = 'customer' and p_customer is null then raise exception 'Pick which customer this login belongs to'; end if;
  if p_login is not null and p_login not in ('microsoft','email') then raise exception 'Unknown login %', p_login; end if;
  select * into was from app_users where email = e;
  lk := coalesce(p_login, was.login_kind, case when split_part(e, '@', 2) in (select domain from staff_domains) then 'microsoft' else 'email' end);
  if not own then
    if coalesce(was.owner, false) then raise exception 'Only an Owner can change an Owner'; end if;
    if p_owner is not null and p_owner is distinct from coalesce(was.owner, false) then raise exception 'Only an Owner can make or remove Owners'; end if;
    -- customer logins and blocking people: the Admin module
    if (p_kind <> 'staff' or (was.email is not null and was.role not in ('admin','sales','crew'))) and not is_admin() then
      raise exception 'Only someone with the Admin module can set up customer logins or block people';
    end if;
    -- a module Admin adding someone has to give them one of their modules
    if was.email is null and not is_admin() then
      select count(*) into mine from jsonb_each_text(coalesce(p_access, '{}')) x where nullif(x.value, '') is not null and manages(x.key);
      if mine = 0 then raise exception 'Give them access to one of your modules'; end if;
    end if;
    if was.email is not null and p_login is not null and p_login is distinct from was.login_kind and not is_admin() then
      raise exception 'Only someone with the Admin module can change how a person signs in';
    end if;
  end if;
  if p_owner is not null and p_owner is distinct from coalesce(was.owner, false) then
    if not p_owner and (select count(*) from app_users where owner) = 1 then raise exception 'There has to be at least one Owner'; end if;
    if p_owner and lk = 'email' then raise exception 'Email-login people can''t be Owners'; end if;
  end if;
  if coalesce(was.owner, false) and p_kind <> 'staff' and (select count(*) from app_users where owner) = 1 then
    raise exception 'There has to be at least one Owner';
  end if;
  if e = current_email() and p_kind <> 'staff' then raise exception 'You can''t take away your own access'; end if;
  if e = current_email() and not own then raise exception 'Ask an Owner to change your own access'; end if;
  select coalesce(jsonb_object_agg(module, level), '{}') into before from module_access where email = e;
  insert into app_users (email, role, customer_id, display_name, added_by, owner, login_kind)
  values (e, case p_kind when 'staff' then 'crew' when 'customer' then 'customer' else 'none' end,
          case when p_kind = 'customer' then p_customer end, nullif(trim(p_name), ''), current_email(),
          p_kind = 'staff' and own and coalesce(p_owner, false), lk)
  on conflict (email) do update
    set role = case p_kind when 'staff' then case when app_users.role in ('admin','sales','crew') then app_users.role else 'crew' end
                           when 'customer' then 'customer' else 'none' end,
        customer_id = excluded.customer_id,
        display_name = coalesce(excluded.display_name, app_users.display_name),
        owner = case when p_kind <> 'staff' then false when own then coalesce(p_owner, app_users.owner) else app_users.owner end,
        login_kind = lk,
        updated_at = now();
  if p_kind <> 'staff' then
    delete from module_access where email = e;
  else
    for m in select unnest(array['distribution','sales','cultivation','nursery','processing','accounting','compliance','admin']) loop
      want := nullif(coalesce(p_access, '{}') ->> m, '');
      if want is not null and want not in ('view','user','admin') then raise exception 'Unknown level %', want; end if;
      if want = 'view' and m = 'admin' then want := null; end if;
      if m = 'admin' and not (own or is_admin()) then continue; end if;      -- the Admin module: Owners and Admin-module people only
      if m <> 'admin' and not manages(m) then continue; end if;             -- not theirs: leave it as it was
      select level into have from module_access where email = e and module = m;
      if want is not distinct from have then continue; end if;
      if not own and (want = 'admin' or have = 'admin') and m <> 'admin' and not can_do(m, 'make_admins') then
        raise exception 'Only an Admin who can make % Admins can change that', initcap(replace(m, 'cultivation', 'production'));
      end if;
      if lk = 'email' and (want = 'admin' or (m = 'admin' and want is not null)) then
        raise exception '% signs in with an email code, so they can''t be an Admin', e;
      end if;
      delete from module_access where email = e and module = m;
      if want is not null then insert into module_access values (e, m, want); end if;
    end loop;
  end if;
  perform sync_role(e);
  select * into u from app_users where email = e;
  insert into events (user_email, type, note, details)
  values (current_email(), 'user_access', e, jsonb_build_object('email', e, 'kind', p_kind, 'owner', u.owner, 'customer_id', u.customer_id, 'login', u.login_kind,
          'access', coalesce((select jsonb_object_agg(module, level) from module_access where email = e), '{}'), 'was', before, 'was_role', was.role));
  return u;
end $$;
drop function if exists save_user(text, text, text, int, jsonb, boolean);

create or replace function set_module_level(p_email text, p_module text, p_level text) returns void
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email)); was text; t app_users;
begin
  perform no_view_as();
  if p_module not in ('distribution','sales','cultivation','nursery','processing','accounting','compliance') then raise exception 'Unknown module %', p_module; end if;
  if nullif(p_level, '') is not null and p_level not in ('view','user','admin') then raise exception 'Unknown level %', p_level; end if;
  if not manages(p_module) then raise exception 'Only an Admin of this module can change who has it'; end if;
  select * into t from app_users where email = e and role in ('admin','sales','crew');
  if t.email is null then raise exception 'No staff member with that email'; end if;
  select level into was from module_access where email = e and module = p_module;
  if not is_owner() then
    if t.owner then raise exception 'Only an Owner can change an Owner'; end if;
    if (p_level = 'admin' or was = 'admin') and not can_do(p_module, 'make_admins') then raise exception 'You can''t make or change Admins of this module'; end if;
    if e = current_email() then raise exception 'Ask an Owner to change your own access'; end if;
  end if;
  delete from module_access where email = e and module = p_module;
  if nullif(p_level, '') is not null then insert into module_access values (e, p_module, p_level); end if;
  perform sync_role(e);
  insert into events (user_email, type, note, details)
  values (current_email(), 'user_access', e, jsonb_build_object('email', e, 'module', p_module, 'level', nullif(p_level, ''), 'was', was));
end $$;

-- add someone straight from a module's Settings > People (Lifted Microsoft account or email code)
create or replace function add_module_person(p_email text, p_name text, p_module text, p_level text, p_login text default null) returns void
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email)); u app_users;
begin
  perform no_view_as();
  if not manages(p_module) then raise exception 'Only an Admin of this module can add people to it'; end if;
  select * into u from app_users where email = e;
  if u.email is not null and u.role in ('admin','sales','crew') then
    perform set_module_level(e, p_module, p_level);
    return;
  end if;
  if u.email is not null then raise exception '% already has a % login. Ask someone with the Admin module.', e, u.role; end if;
  perform save_user(e, p_name, 'staff', null, jsonb_build_object(p_module, p_level), null, p_login);
end $$;

-- =====================================================================================================
-- 4. the grid applied: Production actions
-- =====================================================================================================
create or replace function cult_guard_done(p_harvest bigint) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if exists (select 1 from cult_harvests where id = p_harvest and status = 'done') and not can_do('cultivation', 'edit_finished') then
    raise exception 'This harvest is finished. Ask a Production Admin to change it.';
  end if;
end $$;

do $$
declare d text;
begin
  select pg_get_functiondef('cult_reopen(bigint)'::regprocedure) into d;
  d := replace(d, 'if not is_mod_admin(''cultivation'') then raise exception ''Only a Production Admin can reopen a finished harvest''; end if;',
                  'if not can_do(''cultivation'', ''edit_finished'') then raise exception ''You can''''t reopen finished harvests''; end if;');
  execute d;
  select pg_get_functiondef('cult_unpush(bigint)'::regprocedure) into d;
  d := replace(d, 'if not is_mod_admin(''cultivation'') then raise exception ''Only a Production Admin can un-push''; end if;',
                  'if not can_do(''cultivation'', ''unpush'') then raise exception ''You can''''t un-push pallets''; end if;');
  execute d;
  select pg_get_functiondef('cult_push(bigint,bigint[],boolean)'::regprocedure) into d;
  if d not like '%can_do(%' then
    d := replace(d, '  perform cult_guard_done(p_harvest);', '  perform cult_guard_done(p_harvest);
  if not can_do(''cultivation'', ''push'') then raise exception ''You can''''t push pallets. Ask a Production Admin.''; end if;');
    execute d;
  end if;
  select pg_get_functiondef('cult_rename(bigint,text)'::regprocedure) into d;
  if d not like '%can_do(%' then
    d := replace(d, '  perform cult_guard_done(p_harvest);', '  perform cult_guard_done(p_harvest);
  if not can_do(''cultivation'', ''rename_harvest'') then raise exception ''You can''''t rename harvests''; end if;');
    execute d;
  end if;
  select pg_get_functiondef('save_tag_rule(jsonb)'::regprocedure) into d;
  d := replace(d, 'if not (is_mod_admin(''cultivation'') or is_mod_admin(''distribution'') or is_owner()) then raise exception ''Only a Production or Distribution Admin can change tag rules''; end if;',
                  'if not can_do(''cultivation'', ''tag_rules'') then raise exception ''You can''''t change tag rules''; end if;');
  execute d;
  select pg_get_functiondef('cult_remove_weight(bigint)'::regprocedure) into d;
  d := replace(d, 'if w.pushed and not is_mod_admin(''cultivation'')', 'if w.pushed and not can_do(''cultivation'', ''edit_finished'')');
  execute d;
  -- package tag ranges: whoever can change tag rules (Production Admins by default) and Compliance Admins too
  select pg_get_functiondef('save_tag_range(jsonb)'::regprocedure) into d;
  d := replace(d, 'if not (is_admin() or is_mod_admin(''nursery'')) then raise exception ''Only an Admin can add tag ranges''; end if;',
                  'if not (is_admin() or is_mod_admin(''nursery'') or can_do(''cultivation'', ''tag_rules'') or is_mod_admin(''compliance'')) then raise exception ''Only an Admin can add tag ranges''; end if;');
  d := replace(d, 'if lic.kind <> ''nursery'' and not is_admin() then raise exception ''Only someone with the Admin module can add these tags''; end if;',
                  'if lic.kind <> ''nursery'' and not (is_admin() or can_do(''cultivation'', ''tag_rules'') or is_mod_admin(''compliance'')) then raise exception ''Only a Production or Compliance Admin can add these tags''; end if;');
  execute d;
end $$;

-- the app reads permissions with the rest of "who am I"
create or replace function my_access() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'owner', is_owner(),
    'modules', coalesce((select jsonb_object_agg(m, mod_level(m)) from unnest(array['distribution','sales','cultivation','nursery','processing','accounting','compliance','admin']) m where mod_level(m) is not null), '{}'),
    'prefs', coalesce((select prefs from app_users where email = jwt_email()), '{}'),
    'perms', my_perms(),
    'login', (select login_kind from app_users where email = jwt_email()))
$$;

do $$
declare f text;
begin
  foreach f in array array['jwt_email_code()','can_do(text,text)','my_perms()','save_perm_rule(text,text,text)','save_perm_override(text,text,text,boolean)',
    'manages(text)','save_user(text,text,text,int,jsonb,boolean,text)','set_module_level(text,text,text)','add_module_person(text,text,text,text,text)','my_access()'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

select (select count(*) from perm_rules) as permissions, (select count(*) from app_users where login_kind = 'email') as email_logins,
       (select count(*) from module_access where level = 'admin') as module_admins;
