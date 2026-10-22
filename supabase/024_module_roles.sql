-- Migration 024: roles per module, Owners, personal settings, app settings, company overview.
-- Run once in Supabase after 023_tag_ranges.sql: SQL Editor > New query > paste > Run. Safe to re-run.
-- (This replaces 022_hide_modules.sql: skip 022. If you already ran it, that's fine too.)
--
-- How access works now:
--  * Owners (Aziz, Matt): everything, every module as Admin. Only an Owner can make or remove Owners.
--  * Everyone else on staff gets a level per module: off, User or Admin.
--      distribution  User = freezers, transit, review          Admin = + Distribution settings (vehicles, strains)
--      sales         User = reserves, menu, orders, prices      Admin = + approve requests, deadlines, customers, terms
--      cultivation   (Production) User = harvests, fields, plan Admin = + Production settings (sites, fields, labs...)
--      admin         company dashboard, users and access, app settings (a level of User or Admin both mean full access)
--  * Customers and No access work as before.
--  The old role column is kept in step automatically (admin = Admin module, sales = Sales, crew = other staff)
--  so older parts of the database keep working.
set client_min_messages = warning;

alter table app_users add column if not exists owner boolean not null default false;
alter table app_users add column if not exists prefs jsonb not null default '{}';

create table if not exists module_access (
  email  text not null references app_users(email) on update cascade on delete cascade,
  module text not null check (module in ('distribution','sales','cultivation','admin')),
  level  text not null check (level in ('user','admin')),
  primary key (email, module)
);
alter table module_access enable row level security;
drop policy if exists read_access on module_access;

-- ---------- who can do what ----------
create or replace function is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(is_staff(), false) and coalesce((select owner from app_users where email = jwt_email()), false)
$$;

-- 'admin', 'user' or null (off) for the signed-in person (or the person an Admin is viewing as)
create or replace function mod_level(m text) returns text
language sql stable security definer set search_path = public as $$
  select case when not coalesce(is_staff(), false) then null
              when coalesce((select owner from app_users where email = jwt_email()), false) then 'admin'
              else (select level from module_access where email = jwt_email() and module = m) end
$$;

create or replace function has_module(m text) returns boolean
language sql stable security definer set search_path = public as $$ select mod_level(m) is not null $$;
create or replace function is_mod_admin(m text) returns boolean
language sql stable security definer set search_path = public as $$ select coalesce(mod_level(m) = 'admin', false) $$;
create or replace function is_sales() returns boolean
language sql stable security definer set search_path = public as $$ select mod_level('sales') is not null $$;
create or replace function is_sales_admin() returns boolean
language sql stable security definer set search_path = public as $$ select coalesce(mod_level('sales') = 'admin', false) $$;
-- "admin" in the older functions (users, login links, view as) = has the Admin module
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$ select mod_level('admin') is not null $$;
create or replace function is_any_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(mod_level('distribution') = 'admin', false) or coalesce(mod_level('sales') = 'admin', false)
      or coalesce(mod_level('cultivation') = 'admin', false) or mod_level('admin') is not null
$$;

create policy read_access on module_access for select to authenticated using (is_admin() or email = jwt_email());
grant select on module_access to authenticated;

create or replace function my_modules() returns text[]
language sql stable security definer set search_path = public as $$
  select case when not coalesce(is_staff(), false) then '{}'
              when coalesce((select owner from app_users where email = jwt_email()), false) then array['distribution','sales','cultivation','admin']
              else coalesce((select array_agg(module order by module) from module_access where email = jwt_email()), '{}') end
$$;

-- what the app needs to draw menus: owner flag, level per module, personal settings
create or replace function my_access() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'owner', is_owner(),
    'modules', coalesce((select jsonb_object_agg(m, mod_level(m)) from unnest(array['distribution','sales','cultivation','admin']) m where mod_level(m) is not null), '{}'),
    'prefs', coalesce((select prefs from app_users where email = jwt_email()), '{}'))
$$;

-- keep the old role column in step with the levels (admin > sales > crew)
create or replace function sync_role(p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare u app_users; r text;
begin
  select * into u from app_users where email = p_email;
  if u.email is null or u.role not in ('admin','sales','crew') then return; end if;
  r := case when u.owner or exists (select 1 from module_access where email = u.email and module = 'admin') then 'admin'
            when exists (select 1 from module_access where email = u.email and module = 'sales') then 'sales'
            else 'crew' end;
  if r <> u.role then update app_users set role = r, updated_at = now() where email = u.email; end if;
end $$;

-- new staff (first Microsoft sign-in, or added in Users) start with Distribution as a User
create or replace function new_staff_access() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.role in ('admin','sales','crew') and not exists (select 1 from module_access where email = new.email) then
    insert into module_access values (new.email, 'distribution', 'user') on conflict do nothing;
  end if;
  return new;
end $$;
drop trigger if exists new_staff_access on app_users;
create trigger new_staff_access after insert on app_users for each row execute function new_staff_access();

-- ---------- one-time move from the old roles ----------
do $$
begin
  if not exists (select 1 from module_access) then
    update app_users set owner = true where email in ('aziz@lifted-organics.com', 'matt@lifted-organics.com');
    -- everyone on staff keeps what they had: Distribution (unless hidden by 022), Sales for admin/sales, Production if switched on
    insert into module_access
    select email, 'distribution', case when role = 'admin' then 'admin' else 'user' end from app_users
     where role in ('admin','sales','crew') and not owner
       and not (coalesce(to_jsonb(app_users) -> 'hidden_modules', '[]') ? 'distribution');
    insert into module_access
    select email, 'cultivation', case when role = 'admin' then 'admin' else 'user' end from app_users
     where role in ('admin','sales','crew') and not owner and 'cultivation' = any(modules);
    insert into module_access
    select email, 'sales', 'user' from app_users where role = 'sales' and not owner;
    -- as asked: Rama = Admin of Production and Distribution; Leland = Admin of Distribution (and Sales, which he runs today)
    insert into module_access values ('ramananda@lifted-organics.com', 'distribution', 'admin'), ('ramananda@lifted-organics.com', 'cultivation', 'admin'),
                                     ('leland@lifted-organics.com', 'distribution', 'admin'), ('leland@lifted-organics.com', 'sales', 'admin')
    on conflict (email, module) do update set level = excluded.level;
    delete from module_access a where not exists (select 1 from app_users u where u.email = a.email);
    perform sync_role(email) from app_users;
  end if;
end $$;

-- ---------- saving a person (Settings > Users in the Admin module) ----------
-- p_kind: 'staff', 'customer' or 'none'. p_access: {"distribution": "user", "sales": "admin", "cultivation": null, "admin": "user"}
create or replace function save_user(p_email text, p_name text, p_kind text, p_customer int default null,
                                     p_access jsonb default '{}', p_owner boolean default null)
returns app_users
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email)); was app_users; u app_users; m text; lv text; before jsonb;
begin
  perform no_view_as();
  if not is_admin() then raise exception 'Only someone with the Admin module can change users'; end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'That email doesn''t look right'; end if;
  if p_kind not in ('staff','customer','none') then raise exception 'Unknown kind %', p_kind; end if;
  if p_kind = 'customer' and p_customer is null then raise exception 'Pick which customer this login belongs to'; end if;
  select * into was from app_users where email = e;
  if coalesce(was.owner, false) and not is_owner() then raise exception 'Only an Owner can change an Owner'; end if;
  if p_owner is not null and p_owner is distinct from coalesce(was.owner, false) then
    if not is_owner() then raise exception 'Only an Owner can make or remove Owners'; end if;
    if not p_owner and (select count(*) from app_users where owner) = 1 then raise exception 'There has to be at least one Owner'; end if;
  end if;
  if coalesce(was.owner, false) and p_kind <> 'staff' and (select count(*) from app_users where owner) = 1 then
    raise exception 'There has to be at least one Owner';
  end if;
  if e = current_email() and p_kind <> 'staff' then raise exception 'You can''t take away your own access'; end if;
  if e = current_email() and not is_owner() and coalesce(p_access ->> 'admin', '') = '' then
    raise exception 'You can''t take away your own Admin module';
  end if;
  select coalesce(jsonb_object_agg(module, level), '{}') into before from module_access where email = e;

  insert into app_users (email, role, customer_id, display_name, added_by, owner)
  values (e, case p_kind when 'staff' then 'crew' when 'customer' then 'customer' else 'none' end,
          case when p_kind = 'customer' then p_customer end, nullif(trim(p_name), ''), current_email(),
          p_kind = 'staff' and coalesce(p_owner, false))
  on conflict (email) do update
    set role = case p_kind when 'staff' then case when app_users.role in ('admin','sales','crew') then app_users.role else 'crew' end
                           when 'customer' then 'customer' else 'none' end,
        customer_id = excluded.customer_id,
        display_name = coalesce(excluded.display_name, app_users.display_name),
        owner = case when p_kind <> 'staff' then false else coalesce(p_owner, app_users.owner) end,
        updated_at = now();

  delete from module_access where email = e;
  if p_kind = 'staff' then
    for m, lv in select key, value #>> '{}' from jsonb_each(coalesce(p_access, '{}')) loop
      if m not in ('distribution','sales','cultivation','admin') then raise exception 'Unknown module %', m; end if;
      if lv in ('user','admin') then insert into module_access values (e, m, lv); end if;
    end loop;
  end if;
  perform sync_role(e);
  select * into u from app_users where email = e;
  insert into events (user_email, type, note, details)
  values (current_email(), 'user_access', e, jsonb_build_object('email', e, 'kind', p_kind, 'owner', u.owner, 'customer_id', u.customer_id,
          'access', coalesce((select jsonb_object_agg(module, level) from module_access where email = e), '{}'), 'was', before, 'was_role', was.role));
  return u;
end $$;

create or replace function remove_user(p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email)); was app_users;
begin
  perform no_view_as();
  if not is_admin() then raise exception 'Only someone with the Admin module can change users'; end if;
  select * into was from app_users where email = e;
  if was.owner and not is_owner() then raise exception 'Only an Owner can remove an Owner'; end if;
  if was.owner and (select count(*) from app_users where owner) = 1 then raise exception 'There has to be at least one Owner'; end if;
  if e = current_email() then raise exception 'You can''t remove yourself'; end if;
  delete from app_users where email = e;
  insert into events (user_email, type, note, details)
  values (current_email(), 'user_removed', e, jsonb_build_object('email', e, 'was', was.role));
end $$;

-- the old Users form calls (kept for older app versions; now only the Admin module can use them)
create or replace function set_user_modules(p_email text, p_modules text[]) returns void
language plpgsql security definer set search_path = public as $$
begin raise exception 'Refresh the app: modules are now set per person with a level (Admin > Users)'; end $$;

create or replace function set_user(p_email text, p_role text, p_customer int default null, p_name text default null)
returns app_users
language plpgsql security definer set search_path = public as $$
begin raise exception 'Refresh the app: people are now set up in Admin > Settings > Users'; end $$;

-- ---------- personal settings (top bar ⚙) ----------
create or replace function set_my_prefs(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare k text; out jsonb;
begin
  perform no_view_as();
  for k in select jsonb_object_keys(coalesce(p, '{}')) loop
    if k not in ('theme','start_module','start_site','notify') then raise exception 'Unknown setting %', k; end if;
  end loop;
  update app_users set prefs = prefs || coalesce(p, '{}'), updated_at = now() where email = jwt_email() returning prefs into out;
  return out;
end $$;

create or replace function set_my_name(p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform no_view_as();
  update app_users set display_name = nullif(trim(p_name), ''), updated_at = now() where email = jwt_email();
end $$;

-- who gets an email: people with the module (only its Admins when p_admins), who haven't switched that email off
create or replace function notify_list(p_module text, p_admins boolean, p_kind text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(u.email), '[]') from app_users u
   where u.role in ('admin','sales','crew')
     and (u.owner or exists (select 1 from module_access a where a.email = u.email and a.module = p_module and (not p_admins or a.level = 'admin')))
     and coalesce((u.prefs -> 'notify' ->> p_kind)::boolean, true)
$$;

-- ---------- app settings (Admin module > Settings) ----------
create or replace function set_app_setting(p_key text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
declare was text;
begin
  perform no_view_as();
  if not is_admin() then raise exception 'Only someone with the Admin module can change app settings'; end if;
  if p_key not in ('crop_year','company.name','company.address','company.phone','company.email','company.license','app.email_from') then
    raise exception 'Unknown setting %', p_key;
  end if;
  if p_key = 'crop_year' and (p_value !~ '^\d{4}$') then raise exception 'Crop year should be like 2026'; end if;
  select value into was from app_settings where key = p_key;
  insert into app_settings values (p_key, coalesce(p_value, '')) on conflict (key) do update set value = excluded.value;
  insert into events (user_email, type, note, details)
  values (current_email(), 'app_setting', p_key, jsonb_build_object('key', p_key, 'value', p_value, 'was', was));
end $$;

-- ---------- module settings: only that module's Admins ----------
drop policy if exists add_row on vehicles;  drop policy if exists edit_row on vehicles;
create policy add_row  on vehicles for insert to authenticated with check (is_mod_admin('distribution') and not impersonating());
create policy edit_row on vehicles for update to authenticated using (is_mod_admin('distribution')) with check (is_mod_admin('distribution') and not impersonating());
-- strains: anyone on staff can add a new name as they work; editing is for module Admins
drop policy if exists edit_row on strains;
create policy edit_row on strains for update to authenticated using (is_any_admin()) with check (is_any_admin() and not impersonating());
drop policy if exists add_row on customers; drop policy if exists edit_row on customers;
create policy add_row  on customers for insert to authenticated with check (is_sales_admin() and not impersonating());
create policy edit_row on customers for update to authenticated using (is_sales_admin()) with check (is_sales_admin() and not impersonating());
drop policy if exists edit_row on sites; drop policy if exists edit_row on fields;
create policy edit_row on sites  for update to authenticated using (is_mod_admin('cultivation')) with check (is_mod_admin('cultivation') and not impersonating());
create policy edit_row on fields for update to authenticated using (is_mod_admin('cultivation')) with check (is_mod_admin('cultivation') and not impersonating());

create or replace function set_cult_setting(p_key text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_module('cultivation');
  if p_key not like 'cult.%' then raise exception 'Not a cultivation setting'; end if;
  -- the plan buffer is set on the Plan screen; everything else is Production settings
  if p_key <> 'cult.buffer_pct' and not is_mod_admin('cultivation') then raise exception 'Only a Production Admin can change Production settings'; end if;
  insert into app_settings values (p_key, coalesce(p_value, '')) on conflict (key) do update set value = excluded.value;
  insert into cult_log (user_email, tbl, op, data) values (current_email(), 'app_settings', 'update', jsonb_build_object(p_key, p_value));
end $$;

-- ---------- company overview (Admin dashboard) ----------
create or replace function admin_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare yr int := crop_year(); mo date := date_trunc('month', current_date)::date; r jsonb;
begin
  if not is_admin() then raise exception 'Only someone with the Admin module can see the company overview'; end if;
  select jsonb_build_object(
    'crop_year', yr,
    'freezers', (select jsonb_build_object(
        'lbs', coalesce(sum(p.current_weight), 0), 'pallets', count(*))
      from pallets p where p.status = 'in_freezer' and p.container_id is null),
    'open_spaces', (select count(*) from slots s join freezers f on f.id = s.freezer_id
      where f.kind is distinct from 'staging' and f.status <> 'Not Working'
        and not exists (select 1 from pallets p where p.slot_id = s.id and p.status = 'in_freezer' and p.container_id is null)),
    'needs_spot', (select count(*) from pallets where status = 'unslotted' and container_id is null),
    'loads', (select jsonb_build_object('active', count(*) filter (where status in ('planning','loading','in_transit')),
                                        'in_transit', count(*) filter (where status = 'in_transit')) from loads),
    'season', (select jsonb_build_object(
        'harvests', count(*), 'done', count(*) filter (where h.status = 'done'),
        'est', coalesce(sum(h.plants * h.est_lbs_per_plant), 0),
        'done_est', coalesce(sum(h.plants * h.est_lbs_per_plant) filter (where h.status = 'done'), 0),
        'actual', coalesce(sum(coalesce(h.ff_lbs, (select sum(p.og_weight) from pallets p where p.harvest_id = h.id and p.parent_id is null))) filter (where h.status = 'done'), 0),
        'unlogged', count(*) filter (where h.status = 'planned' and h.planned_on < current_date))
      from cult_harvests h where h.crop_year = yr and h.kind = 'ff' and h.status <> 'cancelled'),
    'reserves', (select jsonb_build_object('reserved', coalesce(sum(reserved), 0), 'shipped', coalesce(sum(shipped), 0),
        'pending', coalesce(sum(pending), 0), 'remaining', coalesce(sum(remaining), 0), 'customers', count(distinct customer_id))
      from reserve_balances where crop_year = yr),
    'next', (select jsonb_build_object('year', yr + 1, 'deadline', reserve_deadline(yr + 1),
        'reserved', coalesce((select sum(lbs) from reserves where crop_year = yr + 1), 0),
        'customers', (select count(distinct customer_id) from reserves where crop_year = yr + 1 and lbs > 0),
        'requested', coalesce((select sum(requested_lbs) from reserve_requests where crop_year = yr + 1 and status = 'pending'), 0))),
    'sales', jsonb_build_object(
        'requests', (select count(*) from reserve_requests where status = 'pending'),
        'to_confirm', (select count(*) from orders where status = 'submitted'),
        'orders_month', (select count(*) from orders where status not in ('draft','cancelled') and coalesce(order_date, created_at::date) >= mo),
        'lbs_ordered_month', coalesce((select sum(l.lbs) from order_lines l join orders o on o.id = l.order_id
            where o.status not in ('draft','cancelled') and coalesce(o.order_date, o.created_at::date) >= mo), 0),
        'lbs_shipped_month', coalesce((select sum(l.lbs) from order_lines l join orders o on o.id = l.order_id
            where o.status = 'shipped' and o.shipped_date >= mo), 0),
        'value_month', coalesce((select sum(l.lbs * l.price_per_lb) from order_lines l join orders o on o.id = l.order_id
            where o.status not in ('draft','cancelled') and coalesce(o.order_date, o.created_at::date) >= mo), 0)),
    'people', jsonb_build_object(
        'staff', (select count(*) from app_users where role in ('admin','sales','crew')),
        'staff_week', (select count(*) from app_users where role in ('admin','sales','crew') and last_seen > now() - interval '7 days'),
        'customers', (select count(*) from app_users where role = 'customer'),
        'customers_month', (select count(*) from app_users where role = 'customer' and last_seen > now() - interval '30 days'),
        'by_module', (select jsonb_object_agg(module, n) from (select module, count(*) n from module_access group by module) x),
        'owners', (select count(*) from app_users where owner))
  ) into r;
  return r;
end $$;

-- new sign-ins / who am I: also tell the app what this person can see
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
    'viewing_as', v, 'real_email', real_email(),
    'access', my_access());
end $$;

-- ---------- reserve approvals, deadlines, terms: Sales Admins; emails follow personal settings ----------
CREATE OR REPLACE FUNCTION public.decide_reserve_request(p_id integer, p_approve boolean, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q reserve_requests; b reserve_balances;
begin
  perform no_view_as();
  if not is_sales_admin() then raise exception 'Only a Sales Admin can approve reserve changes'; end if;
  select * into q from reserve_requests where id = p_id for update;
  if q.id is null or q.status <> 'pending' then raise exception 'This request was already handled'; end if;
  if p_approve then
    select * into b from reserve_balances where customer_id = q.customer_id and lower(strain) = lower(q.strain) and crop_year = q.crop_year;
    if q.requested_lbs < coalesce(b.shipped, 0) + coalesce(b.pending, 0) then
      raise exception 'They''ve shipped or ordered % lbs since asking, more than the requested reserve', coalesce(b.shipped, 0) + coalesce(b.pending, 0);
    end if;
    perform _apply_reserve(q.customer_id, q.strain, q.requested_lbs, coalesce(p_note, q.note), current_email(), 'request', q.crop_year);
  end if;
  update reserve_requests set status = case when p_approve then 'approved' else 'declined' end,
         decided_by = current_email(), decided_at = now(), decision_note = nullif(trim(p_note), '')
   where id = q.id;
  insert into events (user_email, type, note, details)
  values (current_email(), case when p_approve then 'reserve_approved' else 'reserve_declined' end, p_note,
          jsonb_build_object('customer_id', q.customer_id, 'customer', (select name from customers where id = q.customer_id),
                             'strain', q.strain, 'from', q.current_lbs, 'to', q.requested_lbs, 'request_id', q.id, 'crop_year', q.crop_year));
end $function$;

CREATE OR REPLACE FUNCTION public.decide_reserve_requests(p_items jsonb, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare it jsonb; q reserve_requests; b reserve_balances; amt numeric; ok int := 0; no int := 0;
begin
  perform no_view_as();
  if not is_sales_admin() then raise exception 'Only a Sales Admin can approve reserve changes'; end if;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    select * into q from reserve_requests where id = (it ->> 'id')::int for update;
    if q.id is null or q.status <> 'pending' then continue; end if;
    if coalesce((it ->> 'approve')::boolean, false) then
      amt := coalesce(nullif(it ->> 'lbs', '')::numeric, q.requested_lbs);
      if amt < 0 then raise exception '%: amount can''t be negative', q.strain; end if;
      select * into b from reserve_balances where customer_id = q.customer_id and lower(strain) = lower(q.strain) and crop_year = q.crop_year;
      if amt < coalesce(b.shipped, 0) + coalesce(b.pending, 0) then
        raise exception '%: they''ve shipped or ordered % lbs, more than %', q.strain, coalesce(b.shipped, 0) + coalesce(b.pending, 0), amt;
      end if;
      perform _apply_reserve(q.customer_id, q.strain, amt, coalesce(p_note, q.note), current_email(), 'request', q.crop_year);
      update reserve_requests set status = 'approved', approved_lbs = amt, decided_by = current_email(), decided_at = now(),
             decision_note = coalesce(nullif(trim(p_note), ''), case when amt <> q.requested_lbs then 'Approved at ' || amt || ' lbs' end)
       where id = q.id;
      ok := ok + 1;
    else
      update reserve_requests set status = 'declined', decided_by = current_email(), decided_at = now(), decision_note = nullif(trim(p_note), '')
       where id = q.id;
      no := no + 1;
    end if;
    insert into events (user_email, type, note, details)
    values (current_email(), case when coalesce((it ->> 'approve')::boolean, false) then 'reserve_approved' else 'reserve_declined' end, p_note,
            jsonb_build_object('customer_id', q.customer_id, 'customer', (select name from customers where id = q.customer_id),
                               'strain', q.strain, 'from', q.current_lbs, 'to', case when coalesce((it ->> 'approve')::boolean, false) then amt else q.requested_lbs end,
                               'asked', q.requested_lbs, 'request_id', q.id, 'crop_year', q.crop_year));
  end loop;
  return jsonb_build_object('approved', ok, 'declined', no);
end $function$;

CREATE OR REPLACE FUNCTION public.set_reserve(p_customer integer, p_strain text, p_lbs numeric, p_note text DEFAULT NULL::text, p_year integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform no_view_as();
  if not is_sales_admin() then raise exception 'Only a Sales Admin can change reserves'; end if;
  perform _apply_reserve(p_customer, p_strain, p_lbs, p_note, current_email(), 'edit', p_year);
end $function$;

CREATE OR REPLACE FUNCTION public.set_reserve_deadline(p_year integer, p_date date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform no_view_as();
  if not is_sales_admin() then raise exception 'Only a Sales Admin can change reserve deadlines'; end if;
  if p_year <= crop_year() then raise exception 'Deadlines are for future crops'; end if;
  if p_date is null then delete from app_settings where key = 'reserves.deadline.' || p_year;
  else insert into app_settings values ('reserves.deadline.' || p_year, p_date::text) on conflict (key) do update set value = excluded.value;
  end if;
  insert into events (user_email, type, note, details)
  values (current_email(), 'settings', 'updated', jsonb_build_object('list', 'reserve deadlines', 'name', p_year::text, 'deadline', p_date));
end $function$;

CREATE OR REPLACE FUNCTION public.set_customer_terms(p_customer integer, p_year integer, p_price numeric, p_contract numeric, p_min numeric, p_deposit numeric, p_storage numeric, p_clear boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c customers;
begin
  perform no_view_as();
  if not is_sales_admin() then raise exception 'Only a Sales Admin can change contract terms'; end if;
  select * into c from customers where id = p_customer;
  if c.id is null then raise exception 'Customer not found'; end if;
  if p_clear then
    delete from customer_terms where customer_id = p_customer and crop_year = p_year;
  else
    insert into customer_terms (customer_id, crop_year, price_per_lb, contract_lbs, monthly_min_lbs, deposit_usd, storage_fee, updated_by)
    values (p_customer, p_year, p_price, p_contract, p_min, p_deposit, p_storage, current_email())
    on conflict (customer_id, crop_year) do update set price_per_lb = excluded.price_per_lb, contract_lbs = excluded.contract_lbs,
      monthly_min_lbs = excluded.monthly_min_lbs, deposit_usd = excluded.deposit_usd, storage_fee = excluded.storage_fee,
      updated_by = excluded.updated_by, updated_at = now();
  end if;
  insert into events (user_email, type, note, details)
  values (current_email(), 'settings', 'updated', jsonb_build_object('list', 'customer terms', 'name', c.name || ' ' || p_year,
          'customer_id', c.id, 'crop_year', p_year, 'price_per_lb', p_price, 'cleared', p_clear));
end $function$;

CREATE OR REPLACE FUNCTION public.request_notification(p_id integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q reserve_requests; lines jsonb;
begin
  select * into q from reserve_requests where id = p_id and requested_by = jwt_email() and customer_id = my_customer();
  if q.id is null or q.notified_at is not null then return null; end if;
  if q.batch_id is not null then
    select jsonb_agg(jsonb_build_object('strain', r.strain, 'from', r.current_lbs, 'to', r.requested_lbs) order by r.strain) into lines
      from reserve_requests r where r.batch_id = q.batch_id;
    update reserve_requests set notified_at = now() where batch_id = q.batch_id;
  else
    update reserve_requests set notified_at = now() where id = q.id;
  end if;
  return jsonb_build_object('customer', (select name from customers where id = q.customer_id), 'strain', q.strain,
    'from', q.current_lbs, 'to', q.requested_lbs, 'note', q.note, 'by', q.requested_by, 'crop_year', q.crop_year, 'lines', lines,
    'by_name', (select display_name from app_users where email = q.requested_by),
    'admins', notify_list('sales', true, 'requests'));
end $function$;

CREATE OR REPLACE FUNCTION public.order_notification(p_id integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o orders;
begin
  update orders set notified_at = now()
   where id = p_id and notified_at is null and placed_by = jwt_email() and customer_id = my_customer()
  returning * into o;
  if o.id is null then return null; end if;
  return jsonb_build_object('id', o.id, 'customer', (select name from customers where id = o.customer_id),
    'by', o.placed_by, 'by_name', (select display_name from app_users where email = o.placed_by),
    'note', o.notes, 'po', o.po_number, 'wanted', o.wanted_date,
    'lines', (select jsonb_agg(jsonb_build_object('strain', strain, 'lbs', lbs, 'price', price_per_lb) order by strain) from order_lines where order_id = o.id),
    'to', notify_list('sales', false, 'orders'));
end $function$;

revoke execute on function is_owner(), mod_level(text), is_mod_admin(text), is_sales_admin(), is_any_admin(), my_access(), sync_role(text),
  save_user(text, text, text, int, jsonb, boolean), set_my_prefs(jsonb), set_my_name(text), notify_list(text, boolean, text),
  set_app_setting(text, text), admin_overview() from public, anon;
grant execute on function is_owner(), mod_level(text), is_mod_admin(text), is_sales_admin(), is_any_admin(), my_access(),
  save_user(text, text, text, int, jsonb, boolean), set_my_prefs(jsonb), set_my_name(text),
  set_app_setting(text, text), admin_overview() to authenticated;

-- check: who has what
select u.email, u.owner, u.role, coalesce(string_agg(a.module || ':' || a.level, ', ' order by a.module), '') as access
  from app_users u left join module_access a on a.email = u.email
 where u.role in ('admin','sales','crew') group by u.email, u.owner, u.role order by u.owner desc, u.email;
