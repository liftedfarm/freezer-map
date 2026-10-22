-- Migration 040:
--  1. Strain profiles: rooting %, cuts per plant, fresh frozen lbs per plant, typical harvest date (worked out from the app's
--     own data) and solventless / hydrocarbon yield % and a photo. Anything can be overridden, but only by an Admin of the
--     module it belongs to: Nursery (rooting, cuts), Production (yield, harvest date), Sales (extraction yields, photo).
--  2. Users and access by module: Owners change anything. A module Admin sees and changes only their own modules, only
--     Off / View / User, never another Admin or Owner, and can only "View as" people who aren't Admins.
--  3. Fresh frozen pallets: the pallet # comes from the METRC tag's last 4 digits (…10053 → P53) unless one is typed.
-- Run after 039. Safe to re-run.
set client_min_messages = warning;

-- ============ 1. strain profiles ============
create table if not exists strain_info (
  strain_id        int primary key references strains(id) on delete cascade,
  rooting_pct      numeric check (rooting_pct between 0 and 100),
  cuts_per_plant   numeric check (cuts_per_plant >= 0),
  yield_lbs_plant  numeric check (yield_lbs_plant >= 0),
  harvest_mmdd     text check (harvest_mmdd ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  solventless_pct  numeric check (solventless_pct between 0 and 100),
  hydrocarbon_pct  numeric check (hydrocarbon_pct between 0 and 100),
  spot_price       numeric check (spot_price >= 0),     -- $/lb on the catalog (blank = the catalog's default)
  photo_url        text,
  menu_note        text,
  updated_by       text default current_email(),
  updated_at       timestamptz not null default now()
);
alter table strain_info add column if not exists spot_price numeric check (spot_price >= 0);
alter table strain_info enable row level security;
drop policy if exists read_info on strain_info;
create policy read_info on strain_info for select to authenticated using (is_staff());
grant select on strain_info to authenticated;

-- every strain: what the data says (auto) and what's been set by hand (set)
create or replace function strain_profiles() returns setof jsonb
language sql stable security definer set search_path = public as $$
  with names as (   -- every name a strain goes by
    select s.id, lower(s.name) as nm from strains s
    union select s.id, lower(a) from strains s, unnest(s.aliases) a
  ),
  root as (select n.id, sum(coalesce(b.s1_vigorous, 0) + coalesce(b.s2_vigorous, 0)) as rooted, sum(b.cuttings) as cut, count(*) as n
             from nursery_batches b join names n on n.nm = lower(b.strain)
            where b.s1_vigorous is not null and b.cuttings > 0 group by n.id),
  cuts as (select n.id, coalesce(max(p.cuts_g3), avg(m.cuts_per_plant) filter (where m.gen = 3), avg(m.cuts_per_plant)) as v,
                  case when max(p.cuts_g3) is not null then 'the Nursery plan' else 'mother lots' end as src
             from names n left join nursery_strain_plan p on lower(p.strain) = n.nm
             left join nursery_mothers m on lower(m.strain) = n.nm and m.cuts_per_plant is not null
            group by n.id having coalesce(max(p.cuts_g3), avg(m.cuts_per_plant)) is not null),
  ff as (   -- fresh frozen harvests in the app plus the imported history
    select n.id, x.lbs, x.plants, x.on_date from (
      select h.strain, coalesce(h.ff_lbs, (select sum(p.og_weight) from pallets p where p.harvest_id = h.id and p.parent_id is null)) as lbs,
             coalesce(h.plants_harvested, h.plants) as plants, h.harvested_on as on_date
        from cult_harvests h where h.kind = 'ff' and h.status = 'done'
      union all
      select y.strain, y.ff_lbs, y.plants, y.harvested_on from cult_yield_history y
    ) x join names n on n.nm = lower(x.strain)),
  yld as (select id, sum(lbs) / nullif(sum(plants), 0) as v, count(*) as n from ff where lbs > 0 and plants > 0 group by id),
  hday as (select id, round(avg(extract(doy from on_date)))::int as doy, count(*) as n from ff where on_date is not null group by id)
  select jsonb_build_object('id', s.id, 'name', s.name,
           'auto', jsonb_build_object(
             'rooting_pct', round(100.0 * r.rooted / nullif(r.cut, 0), 1), 'rooting_n', r.n,
             'cuts_per_plant', round(c.v, 1), 'cuts_src', c.src,
             'yield_lbs_plant', round(y.v, 2), 'yield_n', y.n,
             'harvest_mmdd', to_char(date '2001-01-01' + (d.doy - 1), 'MM-DD'), 'harvest_n', d.n),
           'set', coalesce(to_jsonb(i) - 'strain_id', '{}'::jsonb))
    from strains s
    left join root r on r.id = s.id left join cuts c on c.id = s.id left join yld y on y.id = s.id left join hday d on d.id = s.id
    left join strain_info i on i.strain_id = s.id
   where is_staff()
   order by s.name
$$;

-- what menus, the portal and the catalog show (customers too): only the menu facts, never the grow data
drop function if exists strain_menu_info();
create or replace function strain_menu_info() returns table (name text, solventless_pct numeric, hydrocarbon_pct numeric, spot_price numeric, photo_url text, menu_note text, lineage text)
language sql stable security definer set search_path = public as $$
  select s.name, i.solventless_pct, i.hydrocarbon_pct, i.spot_price, i.photo_url, i.menu_note, s.lineage
    from strains s left join strain_info i on i.strain_id = s.id
   where s.active and (is_staff() or my_customer() is not null)
$$;

-- set (or clear, with null) overrides; each field belongs to a module and only that module's Admins can change it
create or replace function set_strain_info(p_strain int, p_vals jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare k text; m text; s strains; before jsonb; after jsonb;
  owner_of constant jsonb := '{"rooting_pct":"nursery","cuts_per_plant":"nursery","yield_lbs_plant":"cultivation","harvest_mmdd":"cultivation",
                               "solventless_pct":"sales","hydrocarbon_pct":"sales","spot_price":"sales","photo_url":"sales","menu_note":"sales"}';
  names constant jsonb := '{"nursery":"Nursery","cultivation":"Production","sales":"Sales"}';
begin
  perform no_view_as();
  select * into s from strains where id = p_strain;
  if s.id is null then raise exception 'Strain not found'; end if;
  for k in select jsonb_object_keys(coalesce(p_vals, '{}')) loop
    m := owner_of ->> k;
    if m is null then raise exception 'Unknown strain field %', k; end if;
    if not is_mod_admin(m) then raise exception 'Only a % Admin can change that', names ->> m; end if;
  end loop;
  select coalesce(to_jsonb(i) - 'strain_id' - 'updated_at' - 'updated_by', '{}') into before from strain_info i where strain_id = p_strain;
  insert into strain_info (strain_id) values (p_strain) on conflict do nothing;
  update strain_info set
    rooting_pct     = case when p_vals ? 'rooting_pct'     then nullif(p_vals ->> 'rooting_pct', '')::numeric     else rooting_pct end,
    cuts_per_plant  = case when p_vals ? 'cuts_per_plant'  then nullif(p_vals ->> 'cuts_per_plant', '')::numeric  else cuts_per_plant end,
    yield_lbs_plant = case when p_vals ? 'yield_lbs_plant' then nullif(p_vals ->> 'yield_lbs_plant', '')::numeric else yield_lbs_plant end,
    harvest_mmdd    = case when p_vals ? 'harvest_mmdd'    then nullif(p_vals ->> 'harvest_mmdd', '')             else harvest_mmdd end,
    solventless_pct = case when p_vals ? 'solventless_pct' then nullif(p_vals ->> 'solventless_pct', '')::numeric else solventless_pct end,
    hydrocarbon_pct = case when p_vals ? 'hydrocarbon_pct' then nullif(p_vals ->> 'hydrocarbon_pct', '')::numeric else hydrocarbon_pct end,
    spot_price      = case when p_vals ? 'spot_price'      then nullif(p_vals ->> 'spot_price', '')::numeric      else spot_price end,
    photo_url       = case when p_vals ? 'photo_url'       then nullif(trim(p_vals ->> 'photo_url'), '')          else photo_url end,
    menu_note       = case when p_vals ? 'menu_note'       then nullif(trim(p_vals ->> 'menu_note'), '')          else menu_note end,
    updated_by = current_email(), updated_at = now()
   where strain_id = p_strain
  returning to_jsonb(strain_info) - 'strain_id' - 'updated_at' - 'updated_by' into after;
  insert into events (user_email, type, note, details)
  values (current_email(), 'strain_info', s.name, jsonb_build_object('strain', s.name, 'set', p_vals, 'was', coalesce(before, '{}')));
  return after;
end $$;
revoke execute on function strain_profiles(), strain_menu_info(), set_strain_info(int, jsonb) from public, anon;
grant execute on function strain_profiles(), strain_menu_info(), set_strain_info(int, jsonb) to authenticated;

-- ============ 2. users and access, by module ============
-- the modules this person manages: everything for Owners; otherwise the ones they're Admin of (not the Admin module itself)
create or replace function manages(m text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_owner() or (m <> 'admin' and is_mod_admin(m))
$$;
-- someone a non-Owner can't touch: an Owner, or an Admin of anything
create or replace function is_protected_user(p_email text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_users where email = p_email and owner) or exists (select 1 from module_access where email = p_email and level = 'admin')
$$;
revoke execute on function manages(text), is_protected_user(text) from public, anon;
grant execute on function manages(text), is_protected_user(text) to authenticated;

-- who sees whom: Owners everyone; module Admins see staff, but only the access rows for their own modules
drop policy if exists read_users on app_users;
create policy read_users on app_users for select to authenticated
  using (is_admin() or email = jwt_email() or (is_any_admin() and role in ('admin','sales','crew')));
drop policy if exists read_access on module_access;
create policy read_access on module_access for select to authenticated
  using (is_owner() or email = jwt_email() or manages(module));

create or replace function save_user(p_email text, p_name text, p_kind text, p_customer int default null,
                                     p_access jsonb default '{}', p_owner boolean default null)
returns app_users
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email)); was app_users; u app_users; m text; lv text; before jsonb; want text; own boolean := is_owner();
begin
  perform no_view_as();
  if not (own or is_any_admin()) then raise exception 'Only Owners and module Admins can change access'; end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'That email doesn''t look right'; end if;
  if p_kind not in ('staff','customer','none') then raise exception 'Unknown kind %', p_kind; end if;
  if p_kind = 'customer' and p_customer is null then raise exception 'Pick which customer this login belongs to'; end if;
  select * into was from app_users where email = e;
  if not own then
    if was.email is not null and is_protected_user(e) then raise exception 'Only an Owner can change an Owner or another Admin'; end if;
    if p_owner is not null and p_owner is distinct from coalesce(was.owner, false) then raise exception 'Only an Owner can make or remove Owners'; end if;
    -- adding people, customer logins and blocking: the Admin module; module Admins only change levels on existing staff
    if (was.email is null or p_kind <> 'staff' or was.role not in ('admin','sales','crew')) and not is_admin() then
      raise exception 'Only someone with the Admin module can add people or change what kind of login they are';
    end if;
  end if;
  if p_owner is not null and p_owner is distinct from coalesce(was.owner, false) then
    if not p_owner and (select count(*) from app_users where owner) = 1 then raise exception 'There has to be at least one Owner'; end if;
  end if;
  if coalesce(was.owner, false) and p_kind <> 'staff' and (select count(*) from app_users where owner) = 1 then
    raise exception 'There has to be at least one Owner';
  end if;
  if e = current_email() and p_kind <> 'staff' then raise exception 'You can''t take away your own access'; end if;
  if e = current_email() and not own then raise exception 'Ask an Owner to change your own access'; end if;
  select coalesce(jsonb_object_agg(module, level), '{}') into before from module_access where email = e;
  insert into app_users (email, role, customer_id, display_name, added_by, owner)
  values (e, case p_kind when 'staff' then 'crew' when 'customer' then 'customer' else 'none' end,
          case when p_kind = 'customer' then p_customer end, nullif(trim(p_name), ''), current_email(),
          p_kind = 'staff' and own and coalesce(p_owner, false))
  on conflict (email) do update
    set role = case p_kind when 'staff' then case when app_users.role in ('admin','sales','crew') then app_users.role else 'crew' end
                           when 'customer' then 'customer' else 'none' end,
        customer_id = excluded.customer_id,
        display_name = coalesce(excluded.display_name, app_users.display_name),
        owner = case when p_kind <> 'staff' then false when own then coalesce(p_owner, app_users.owner) else app_users.owner end,
        updated_at = now();
  if p_kind <> 'staff' then
    delete from module_access where email = e;
  else
    for m in select unnest(array['distribution','sales','cultivation','nursery','admin']) loop
      want := nullif(coalesce(p_access, '{}') ->> m, '');
      if want is not null and want not in ('view','user','admin') then raise exception 'Unknown level %', want; end if;
      if want = 'view' and m = 'admin' then want := null; end if;
      if not manages(m) then continue; end if;                     -- not theirs: leave it as it was
      if not own and want = 'admin' then raise exception 'Only an Owner can make someone an Admin'; end if;
      delete from module_access where email = e and module = m;
      if want is not null then insert into module_access values (e, m, want); end if;
    end loop;
  end if;
  perform sync_role(e);
  select * into u from app_users where email = e;
  insert into events (user_email, type, note, details)
  values (current_email(), 'user_access', e, jsonb_build_object('email', e, 'kind', p_kind, 'owner', u.owner, 'customer_id', u.customer_id,
          'access', coalesce((select jsonb_object_agg(module, level) from module_access where email = e), '{}'), 'was', before, 'was_role', was.role));
  return u;
end $$;

-- one person, one module: what a module's own Settings > People uses
create or replace function set_module_level(p_email text, p_module text, p_level text) returns void
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email)); was text;
begin
  perform no_view_as();
  if p_module not in ('distribution','sales','cultivation','nursery') then raise exception 'Unknown module %', p_module; end if;
  if nullif(p_level, '') is not null and p_level not in ('view','user','admin') then raise exception 'Unknown level %', p_level; end if;
  if not manages(p_module) then raise exception 'Only an Admin of this module can change who has it'; end if;
  if not exists (select 1 from app_users where email = e and role in ('admin','sales','crew')) then raise exception 'No staff member with that email'; end if;
  if not is_owner() then
    if is_protected_user(e) then raise exception 'Only an Owner can change an Owner or another Admin'; end if;
    if p_level = 'admin' then raise exception 'Only an Owner can make someone an Admin'; end if;
    if e = current_email() then raise exception 'Ask an Owner to change your own access'; end if;
  end if;
  select level into was from module_access where email = e and module = p_module;
  delete from module_access where email = e and module = p_module;
  if nullif(p_level, '') is not null then insert into module_access values (e, p_module, p_level); end if;
  perform sync_role(e);
  insert into events (user_email, type, note, details)
  values (current_email(), 'user_access', e, jsonb_build_object('email', e, 'module', p_module, 'level', nullif(p_level, ''), 'was', was));
end $$;
revoke execute on function set_module_level(text, text, text) from public, anon;
grant execute on function set_module_level(text, text, text) to authenticated;

create or replace function remove_user(p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email)); was app_users;
begin
  perform no_view_as();
  if not is_admin() then raise exception 'Only someone with the Admin module can remove people'; end if;
  select * into was from app_users where email = e;
  if not is_owner() and is_protected_user(e) then raise exception 'Only an Owner can remove an Owner or another Admin'; end if;
  if was.owner and (select count(*) from app_users where owner) = 1 then raise exception 'There has to be at least one Owner'; end if;
  if e = current_email() then raise exception 'You can''t remove yourself'; end if;
  delete from app_users where email = e;
  insert into events (user_email, type, note, details)
  values (current_email(), 'user_removed', e, jsonb_build_object('email', e, 'was', was.role));
end $$;

-- View as: Owners anyone but another Owner; a module Admin only people who aren't Admins and who use one of their modules
create or replace function start_view_as(p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare t app_users; me text := real_email(); own boolean;
begin
  if not jwt_oauth() then raise exception 'Only staff can use View as'; end if;
  own := exists (select 1 from app_users where email = me and owner);
  select * into t from app_users where email = lower(trim(p_email));
  if t.email is null then raise exception 'User not found'; end if;
  if t.owner then raise exception 'You can''t view as an Owner'; end if;
  if not own then
    if exists (select 1 from module_access where email = t.email and level = 'admin') then raise exception 'You can''t view as another Admin'; end if;
    if t.role = 'customer' then
      if not exists (select 1 from module_access where email = me and module = 'sales' and level = 'admin') then raise exception 'Only Sales Admins can view as a customer'; end if;
    elsif not exists (select 1 from module_access a join module_access b on b.module = a.module
                       where a.email = me and a.level = 'admin' and a.module <> 'admin' and b.email = t.email) then
      raise exception 'You can only view as people who use a module you''re an Admin of';
    end if;
  end if;
  insert into view_as (admin_email, target_email) values (me, t.email)
  on conflict (admin_email) do update set target_email = excluded.target_email, started_at = now(), expires_at = now() + interval '2 hours';
  insert into events (user_email, type, note, details)
  values (me, 'view_as', t.email, jsonb_build_object('target', t.email, 'role', t.role));
end $$;

-- ============ 3. pallet # from the METRC tag ============
do $$
declare d text;
begin
  select pg_get_functiondef('cult_add_pallets(bigint, jsonb)'::regprocedure) into d;
  if d not like '%right(v_tag, 4)%' then
    execute replace(d, '    if v_code is null then
      select coalesce(max(',
      '    if v_code is null and v_tag ~ ''[0-9]{4}$'' and right(v_tag, 4)::int > 0 then   -- …10053 → P53
      v_code := pre || case when pre = ''T'' then lpad(right(v_tag, 4)::int::text, 3, ''0'') else right(v_tag, 4)::int::text end;
      if exists (select 1 from pallets where code = v_code) then v_code := null; end if;
    end if;
    if v_code is null then
      select coalesce(max(');
  end if;
end $$;

select (select count(*) from strains) as strains, (select count(*) from strain_info) as profiles_set,
       pg_get_functiondef('cult_add_pallets(bigint, jsonb)'::regprocedure) like '%right(v_tag, 4)%' as pallet_from_tag;
