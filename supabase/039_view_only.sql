-- Migration 039: "View" access level. Each module is now Off / View / User / Admin (Admin module stays On / Off).
-- View sees everything a User sees but can't add or change anything; the database enforces it, not just the screens.
-- How: has_module() still means "can see"; a new can_edit() means User or Admin, and every write (table rules and
-- the functions that save things) now checks can_edit(). Run after 038. Safe to re-run.
set client_min_messages = warning;

alter table module_access drop constraint if exists module_access_level_check;
alter table module_access add constraint module_access_level_check check (level in ('view','user','admin') and (level <> 'view' or module <> 'admin'));

-- can work in a module (not just look)
create or replace function can_edit(m text) returns boolean
language sql stable security definer set search_path = public as $$ select coalesce(mod_level(m) in ('user','admin'), false) $$;
revoke execute on function can_edit(text) from public, anon;
grant execute on function can_edit(text) to authenticated;

-- the Admin module is On (user) or Off: never view
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$ select coalesce(mod_level('admin') in ('user','admin'), false) $$;

-- functions that save: User or Admin only
create or replace function require_module(m text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  perform no_view_as();
  if mod_level(m) = 'view' then raise exception 'You can only view %. Ask an Admin if you need to make changes.', initcap(replace(m, 'cultivation', 'production')); end if;
  if not can_edit(m) then raise exception 'The % module isn''t switched on for your account', m; end if;
end $$;

-- freezer map changes (move, split, load, ship…): blocked for View-only Distribution
create or replace function require_staff() returns void
language plpgsql stable as $$
begin
  perform no_view_as();
  if not is_staff() then
    raise exception 'Your account doesn''t have access to the freezer map. Ask an admin to set your role.';
  end if;
  if mod_level('distribution') = 'view' then raise exception 'You can only view Distribution. Ask an Admin if you need to make changes.'; end if;
end $$;

create or replace function require_distribution() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_staff();
  if mod_level('distribution') is null then raise exception 'You need the Distribution module to fulfill orders'; end if;
end $$;

-- every table rule that adds, changes or deletes: has_module(...) -> can_edit(...)
do $$
declare p record; q text; c text; s text;
begin
  for p in select * from pg_policies where schemaname = 'public' and cmd in ('INSERT','UPDATE','DELETE','ALL')
                                    and (coalesce(qual, '') like '%has_module(%' or coalesce(with_check, '') like '%has_module(%') loop
    q := replace(p.qual, 'has_module(', 'can_edit(');
    c := replace(p.with_check, 'has_module(', 'can_edit(');
    s := format('alter policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
    if q is not null then s := s || format(' using (%s)', q); end if;
    if c is not null then s := s || format(' with check (%s)', c); end if;
    execute s;
  end loop;
end $$;
-- tables any staff member could add to (strains): not View-only people who have nothing else
alter policy add_row on strains with check (is_staff() and not impersonating()
  and exists (select 1 from unnest(array['distribution','sales','cultivation','nursery','admin']) m where can_edit(m)));

-- functions that save and check the module themselves: has_module / is_sales -> can_edit
do $$
declare f text; d text;
begin
  foreach f in array array['nursery_deliver','nursery_order_status','nursery_plant_moms','nursery_save_order','pheno_hunt_number','pheno_keeper'] loop
    select pg_get_functiondef(p.oid) into d from pg_proc p where p.proname = f and p.pronamespace = 'public'::regnamespace;
    if d is not null then execute replace(d, 'has_module(', 'can_edit('); end if;
  end loop;
  foreach f in array array['approve_fill','create_order','import_roshi_orders','make_invoice','set_order_line','set_order_status','set_order_terms'] loop
    select pg_get_functiondef(p.oid) into d from pg_proc p where p.proname = f and p.pronamespace = 'public'::regnamespace;
    if d is not null then execute replace(d, 'is_sales()', 'can_edit(''sales'')'); end if;
  end loop;
end $$;
-- billing actions (mark sent, paid, void)
create or replace function _can_bill(p_inv int) returns boolean
language sql stable security definer set search_path = public as $$
  select can_edit('sales') or exists (select 1 from invoices where id = p_inv and nursery_order_id is not null and can_edit('nursery'))
$$;

-- Users and access: View is a level (not for the Admin module)
do $$
declare d text;
begin
  select pg_get_functiondef('save_user(text,text,text,int,jsonb,boolean)'::regprocedure) into d;
  if d not like '%lv = ''view''%' then
    execute replace(d, 'if lv in (''user'',''admin'') then insert into module_access',
                       'if lv in (''user'',''admin'') or (lv = ''view'' and m <> ''admin'') then insert into module_access');
  end if;
end $$;

select (select count(*) from pg_policies where schemaname = 'public' and cmd <> 'SELECT' and (coalesce(qual, '') || coalesce(with_check, '')) like '%can_edit(%') as write_rules_now_check_can_edit,
       (select count(*) from pg_policies where schemaname = 'public' and cmd <> 'SELECT' and (coalesce(qual, '') || coalesce(with_check, '')) like '%has_module(%') as left_over;
