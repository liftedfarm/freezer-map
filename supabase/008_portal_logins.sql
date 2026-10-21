-- Migration 008: customer portal logins (email + password, invite links, reset links).
-- Run once in Supabase after 007_roles.sql: SQL Editor > New query > paste > Run. Safe to re-run.
--
-- Rules:
--   Staff roles (Admin, Sales, Crew) only count when signed in with Microsoft. Someone who makes a
--   password account with a Lifted email gets nothing.
--   A customer login only works after it's claimed with the invite link an admin sent.
set client_min_messages = warning;

alter table app_users add column if not exists auth_id uuid;

create table if not exists login_links (
  code        text primary key,
  kind        text not null check (kind in ('invite','reset')),
  email       text not null references app_users(email) on delete cascade,
  created_by  text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '14 days',
  used_at     timestamptz
);
alter table login_links enable row level security;   -- no direct access; functions only

-- signed in with Microsoft this session?
create or replace function jwt_oauth() returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when auth.jwt() ? 'amr' then exists (select 1 from jsonb_array_elements(auth.jwt() -> 'amr') a where a ->> 'method' = 'oauth')
    else auth.jwt() -> 'app_metadata' ->> 'provider' = 'azure'
  end
$$;

create or replace function my_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select case
              when u.role in ('admin','sales','crew') then case when jwt_oauth() then u.role else 'none' end
              when u.role = 'customer' then case when u.auth_id is not null and u.auth_id = auth.uid() then 'customer' else 'none' end
              else u.role end
       from app_users u where u.email = jwt_email()),
    case when jwt_oauth() and split_part(jwt_email(), '@', 2) in (select domain from staff_domains) then 'crew' end,
    'none')
$$;

-- whoami also says whether a customer login is waiting to be claimed
create or replace function whoami() returns jsonb
language plpgsql security definer set search_path = public as $$
declare e text := jwt_email(); r text := my_role(); u app_users;
begin
  if e is null then return null; end if;
  if r = 'crew' and not exists (select 1 from app_users where email = e) then
    insert into app_users (email, role, display_name, added_by)
    values (e, 'crew', coalesce(auth.jwt() -> 'user_metadata' ->> 'full_name', auth.jwt() -> 'user_metadata' ->> 'name'), 'first sign-in');
  end if;
  update app_users set last_seen = now() where email = e and r <> 'none' returning * into u;
  if u.email is null then select * into u from app_users where email = e; end if;
  return jsonb_build_object('email', e, 'role', r,
    'display_name', case when r <> 'none' then u.display_name end,
    'customer_id', case when r = 'customer' then u.customer_id end,
    'customer_name', case when r = 'customer' then (select name from customers where id = u.customer_id) end);
end $$;

-- Admin: make an invite or reset link for a customer login
create or replace function make_login_link(p_email text, p_kind text) returns text
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email)); u app_users; c text;
begin
  if not is_admin() then raise exception 'Only an admin can make login links'; end if;
  select * into u from app_users where email = e;
  if u.email is null then raise exception 'Add % as a user first', e; end if;
  if u.role <> 'customer' then raise exception 'Login links are for customer logins. Staff sign in with Microsoft.'; end if;
  if p_kind = 'reset' and u.auth_id is null then raise exception '% hasn''t set up their login yet. Send the invite link.', e; end if;
  if p_kind not in ('invite','reset') then raise exception 'Unknown link type'; end if;
  update login_links set expires_at = now() where email = e and used_at is null and expires_at > now();
  c := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into login_links (code, kind, email, created_by) values (c, p_kind, e, current_email());
  insert into events (user_email, type, note, details)
  values (current_email(), 'login_link', e, jsonb_build_object('email', e, 'kind', p_kind));
  return c;
end $$;

-- Anyone holding a link: what is it for?
create or replace function check_login_link(p_code text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('kind', l.kind, 'email', l.email, 'display_name', u.display_name,
                            'customer_name', (select name from customers where id = u.customer_id))
    from login_links l join app_users u on u.email = l.email
   where l.code = p_code and l.used_at is null and l.expires_at > now() and u.role = 'customer'
$$;

-- After signing up (or signing in) with the invited email: tie this login to the customer
create or replace function claim_invite(p_code text) returns void
language plpgsql security definer set search_path = public as $$
declare l login_links;
begin
  select * into l from login_links where code = p_code and kind = 'invite' for update;
  if l.code is null or l.used_at is not null or l.expires_at <= now() then
    raise exception 'This invite link has expired or was already used. Ask Lifted for a new one.';
  end if;
  if l.email <> jwt_email() then raise exception 'This invite is for %. Sign up with that email.', l.email; end if;
  update app_users set auth_id = auth.uid(), updated_at = now() where email = l.email and role = 'customer';
  update login_links set used_at = now() where code = l.code;
  insert into events (user_email, type, note, details) values (l.email, 'login_claimed', l.email, jsonb_build_object('email', l.email));
end $$;

-- Reset link: set a new password without being signed in
create or replace function reset_password(p_code text, p_password text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare l login_links; u app_users;
begin
  select * into l from login_links where code = p_code and kind = 'reset' for update;
  if l.code is null or l.used_at is not null or l.expires_at <= now() then
    raise exception 'This reset link has expired or was already used. Ask Lifted for a new one.';
  end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'Use at least 8 characters'; end if;
  select * into u from app_users where email = l.email;
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')) where id = u.auth_id;
  if not found then raise exception 'Login not found. Ask Lifted for a new invite.'; end if;
  update login_links set used_at = now() where code = l.code;
  insert into events (user_email, type, note, details) values (l.email, 'password_reset', l.email, jsonb_build_object('email', l.email));
  return l.email;
end $$;

-- Users list shows whether each customer login is set up
create or replace view user_logins with (security_barrier) as
  select u.email, u.auth_id is not null as claimed,
         (select max(created_at) from login_links l where l.email = u.email and l.kind = 'invite') as invited_at
    from app_users u where is_admin();
grant select on user_logins to authenticated;
revoke all on user_logins from anon;

revoke execute on function make_login_link(text,text), claim_invite(text) from public, anon;
grant execute on function make_login_link(text,text), claim_invite(text) to authenticated;
revoke execute on function check_login_link(text), reset_password(text,text) from public;
grant execute on function check_login_link(text), reset_password(text,text) to anon, authenticated;
revoke execute on function jwt_oauth() from public, anon;
grant execute on function jwt_oauth() to authenticated;
