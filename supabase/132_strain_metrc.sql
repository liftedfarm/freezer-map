-- 132_strain_metrc.sql: Add strain > METRC (plan claude/strain-metrc-plan.md, agreed with Aziz 2026-10-30, Msg STR-1..4).
-- Adding a strain (or "METRC" on an existing one) lists what METRC needs on every Lifted license: the strain, the farm items
-- (Fresh Frozen, Dry Harvest), the processing items at GVR Processing (both farms) and the 1PN nursery items (Clone, URC,
-- Seed optional) for the crop years and seasons ticked. Ticked rows become METRC to-dos (strain_create, item_create) that go
-- through T3 like every other kind: Off until a Compliance Admin turns them on, Dry run until Live.
-- Nursery strains can be coded: on 1PN the METRC strain and item names use the strain number (0473) instead of the name.
-- Once a strain is coded it stays coded. The app always shows the real name (Nursery > Strains > METRC codes, spreadsheet).
-- Nothing here changes METRC by itself. Re-runnable. Run after 131.
set client_min_messages = warning;

-- =====================================================================================================
-- 1. strain fields METRC needs
-- =====================================================================================================
alter table strains add column if not exists metrc_coded   boolean not null default false;
alter table strains add column if not exists metrc_coded_at timestamptz;
alter table strains add column if not exists metrc_testing text not null default 'None';
alter table strains add column if not exists metrc_thc     numeric not null default 0;
alter table strains add column if not exists metrc_cbd     numeric not null default 0;
alter table strains add column if not exists metrc_indica  numeric not null default 50;
alter table strains add column if not exists metrc_sativa  numeric not null default 50;
alter table strains drop constraint if exists strains_metrc_testing_check;
alter table strains add constraint strains_metrc_testing_check check (metrc_testing in ('None', 'InHouse', 'ThirdParty'));

-- coded stays coded
create or replace function _strain_coded_keep() returns trigger
language plpgsql as $$
begin
  if old.metrc_coded and not new.metrc_coded then raise exception 'A coded strain stays coded (its METRC names use the number)'; end if;
  if new.metrc_coded and not old.metrc_coded then new.metrc_coded_at := now(); end if;
  return new;
end $$;
drop trigger if exists strain_coded_keep on strains;
create trigger strain_coded_keep before update of metrc_coded on strains for each row execute function _strain_coded_keep();

-- the number code: 0473
create or replace function strain_code(p_strain int) returns text
language sql stable security definer set search_path = public as $$
  select lpad(strain_no::text, 4, '0') from strains where id = p_strain
$$;

-- the strain's METRC name on a license: the code on a nursery license when the strain is coded, else the METRC spelling
create or replace function metrc_strain_on(p_strain int, p_license text) returns text
language sql stable security definer set search_path = public as $$
  select case when s.metrc_coded and exists (select 1 from licenses l where l.license_no = p_license and l.kind = 'nursery')
              then strain_code(s.id) else metrc_strain(s.id) end
    from strains s where s.id = p_strain
$$;

-- nursery site letters in item names: 1PN (FL27WB)
alter table nursery_sites add column if not exists metrc_code text;
update nursery_sites set metrc_code = 'WB' where code = '1PN' and metrc_code is null;

-- =====================================================================================================
-- 2. which items go on which kind of license (Compliance > Settings > METRC items; editable)
-- =====================================================================================================
create table if not exists metrc_item_rules (
  license_kind text not null check (license_kind in ('cultivation', 'processor', 'nursery')),
  finish       text not null references finishes(code),
  default_on   boolean not null default true,
  label        text,            -- name ending, e.g. Clone / URC / Seed (nursery). Blank = the finish's METRC label
  category     text,            -- METRC item category. Blank = copy from an existing item of the same kind on that license
  uom          text,            -- METRC unit of measure (Pounds, Each, Grams). Blank = copy
  sort         int not null default 50,
  primary key (license_kind, finish));
insert into metrc_item_rules (license_kind, finish, default_on, label, category, uom, sort) values
  ('cultivation', 'FF', true,  null,    'Fresh Cannabis Plant', 'Pounds', 1),
  ('cultivation', 'DH', true,  null,    'Fresh Cannabis Plant', 'Pounds', 2),
  ('processor',   'FF', true,  null,    'Fresh Cannabis Plant', 'Pounds', 1),
  ('processor',   'UF', true,  null,    'Flower',               'Pounds', 3),
  ('processor',   'BF', true,  null,    'Flower',               'Pounds', 4),
  ('processor',   'ST', true,  null,    'Flower',               'Pounds', 5),
  ('processor',   'SM', true,  null,    'Flower',               'Pounds', 6),
  ('processor',   'TR', true,  null,    'Leaf',                 'Pounds', 7),
  ('processor',   'BT', true,  null,    'Leaf',                 'Pounds', 8),
  ('processor',   'DB', false, null,    'Leaf',                 'Pounds', 9),
  ('processor',   'DS', false, null,    'Leaf',                 'Pounds', 10),
  ('nursery',     'CL', true,  'Clone', 'Clone - Cutting',      'Each',   1),
  ('nursery',     'UR', true,  'URC',   'Clone - Cutting',      'Each',   2),
  ('nursery',     'SD', false, 'Seed',  'Seeds',                'Grams',  3)
on conflict (license_kind, finish) do nothing;
alter table metrc_item_rules enable row level security;
drop policy if exists read_metrc_item_rules on metrc_item_rules;
create policy read_metrc_item_rules on metrc_item_rules for select to authenticated using (is_staff());
grant select on metrc_item_rules to authenticated;
grant all on metrc_item_rules to service_role;

create or replace function save_metrc_item_rule(p_kind text, p_finish text, p_default_on boolean, p_label text, p_category text, p_uom text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not comp_is_admin() then raise exception 'Only a Compliance Admin can change the METRC item rules'; end if;
  insert into metrc_item_rules (license_kind, finish, default_on, label, category, uom)
  values (p_kind, upper(p_finish), coalesce(p_default_on, true), nullif(trim(p_label), ''), nullif(trim(p_category), ''), nullif(trim(p_uom), ''))
  on conflict (license_kind, finish) do update set default_on = excluded.default_on, label = excluded.label, category = excluded.category, uom = excluded.uom;
  insert into events (user_email, type, note, details) values (current_email(), 'metrc_item_rule', p_kind || ' ' || p_finish,
    jsonb_build_object('kind', p_kind, 'finish', p_finish, 'default_on', p_default_on, 'label', p_label, 'category', p_category, 'uom', p_uom));
end $$;
revoke all on function save_metrc_item_rule(text, text, boolean, text, text, text) from public, anon;
grant execute on function save_metrc_item_rule(text, text, boolean, text, text, text) to authenticated;

-- =====================================================================================================
-- 3. nursery items (season + crop year + strain + Clone / URC / Seed) and what the app has asked METRC for
-- =====================================================================================================
create table if not exists metrc_nursery_items (
  id         bigserial primary key,
  strain_id  int not null references strains(id),
  site       text not null references nursery_sites(code),
  crop_year  int not null,
  season     text not null check (season in ('FL', 'SP')),
  finish     text not null references finishes(code),
  metrc_name text not null,
  license    text,
  metrc_status text not null default 'to_create' check (metrc_status in ('to_create', 'in_metrc', 'retired')),
  created_by text default current_email(),
  created_at timestamptz not null default now(),
  unique (strain_id, site, crop_year, season, finish));
alter table metrc_nursery_items enable row level security;
drop policy if exists read_metrc_nursery_items on metrc_nursery_items;
create policy read_metrc_nursery_items on metrc_nursery_items for select to authenticated using (is_staff());
grant select on metrc_nursery_items to authenticated;
grant all on metrc_nursery_items to service_role;

-- p_name = the strain's name on the nursery license (the code when the strain is coded)
drop function if exists nursery_item_name(text, int, text, text, int);
create or replace function nursery_item_name(p_site text, p_year int, p_season text, p_finish text, p_name text) returns text
language sql stable security definer set search_path = public as $$
  select n.code || ' (' || p_season || lpad((p_year % 100)::text, 2, '0') || coalesce(n.metrc_code, '') || ') - '
         || p_name || ' - '
         || coalesce((select label from metrc_item_rules where license_kind = 'nursery' and finish = p_finish),
                     (select coalesce(metrc_label, name) from finishes where code = p_finish))
    from nursery_sites n where n.code = p_site
$$;

-- one row per strain or item per license the app asked METRC to make (or found already there)
create table if not exists metrc_setup (
  id          bigserial primary key,
  strain_id   int not null references strains(id),
  license     text not null,
  what        text not null check (what in ('strain', 'item')),
  metrc_name  text not null,
  finish      text,
  crop_year   int,
  site        text,          -- grow farm (farm items) or nursery site
  season      text,
  item_id     bigint references items(id),
  nursery_item_id bigint references metrc_nursery_items(id),
  category    text,
  uom         text,
  metrc_id    bigint,
  status      text not null default 'queued' check (status in ('queued', 'in_metrc', 'skipped')),
  action_id   bigint,
  created_by  text default current_email(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now());
create unique index if not exists metrc_setup_uq on metrc_setup (license, what, lower(metrc_name));
create index if not exists metrc_setup_strain on metrc_setup (strain_id);
alter table metrc_setup enable row level security;
drop policy if exists read_metrc_setup on metrc_setup;
create policy read_metrc_setup on metrc_setup for select to authenticated using (is_staff());
grant select on metrc_setup to authenticated;
grant all on metrc_setup to service_role;
grant usage on sequence metrc_setup_id_seq, metrc_nursery_items_id_seq to service_role;

-- METRC's active items per license (nightly pull, and "Refresh from METRC" on the strain's METRC sheet)
create table if not exists metrc_items (
  license text not null, id bigint not null, name text not null, category text, uom text, strain_id bigint, strain text,
  archived boolean not null default false, seen_at timestamptz not null default now(), primary key (license, id));
create index if not exists metrc_items_name on metrc_items (license, lower(name));
alter table metrc_items enable row level security;
drop policy if exists read_metrc_items on metrc_items;
create policy read_metrc_items on metrc_items for select to authenticated using (is_staff());
grant select on metrc_items to authenticated;
grant all on metrc_items to service_role;

-- =====================================================================================================
-- 4. to-do kinds
-- =====================================================================================================
insert into metrc_push_kinds (kind, label, phase, sort, ready) values
  ('strain_create', 'New strain: create the strain in METRC', 0, 5, true),
  ('item_create',   'New strain: create its items in METRC',  0, 6, true)
on conflict (kind) do update set label = excluded.label, phase = excluded.phase, sort = excluded.sort, ready = excluded.ready;

-- who can send a strain to METRC: Production, Nursery and Compliance Admins, the Admin module and Owners
create or replace function can_metrc_strains() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((is_mod_admin('cultivation') or is_mod_admin('nursery') or is_mod_admin('compliance') or is_admin() or is_owner())
                  and not impersonating(), false)
$$;

-- the server's view of the caller (090) + can_strains: may refresh METRC strains / items from the strain's METRC sheet
create or replace function metrc_me() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'email', current_email(),
    'admin', coalesce(comp_is_admin(), false),
    'can_send', coalesce((comp_can_edit() or is_mod_admin('distribution') or is_mod_admin('processing') or is_owner()) and not impersonating(), false),
    'can_receive_plants', coalesce((comp_can_edit() or can_edit('cultivation') or is_owner()) and not impersonating(), false),
    'can_receive_nursery', coalesce((comp_can_edit() or can_edit('nursery') or is_owner()) and not impersonating(), false),
    'can_ship_nursery', coalesce((comp_can_edit() or can_edit('nursery') or is_owner()) and not impersonating(), false),
    'can_strains', can_metrc_strains())
$$;

-- =====================================================================================================
-- 5. the plan: everything METRC needs for a strain, and what's already there
-- p_opts: { years: [2026, 2027], seasons: ['FL'], coded: bool }   (blank = this year and next, FL, the strain's own setting)
-- =====================================================================================================
create or replace function metrc_strain_plan(p_strain int, p_opts jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  s strains; yr int := extract(year from _local_today())::int;
  years int[]; seasons text[]; coded boolean; rows jsonb := '[]';
begin
  if not is_staff() then raise exception 'Staff only'; end if;
  select * into s from strains where id = p_strain;
  if s.id is null then raise exception 'Strain not found'; end if;
  years := coalesce((select array_agg(distinct (v)::int order by (v)::int) from jsonb_array_elements_text(p_opts -> 'years') v), array[yr, yr + 1]);
  seasons := coalesce((select array_agg(distinct upper(v)) from jsonb_array_elements_text(p_opts -> 'seasons') v where upper(v) in ('FL', 'SP')), array['FL']);
  coded := s.metrc_coded or coalesce((p_opts ->> 'coded')::boolean, false);

  with lic as (
    select l.license_no, l.kind, l.site, coalesce(n.code, l.site) as site_code, n.code as nursery_site, l.sort as lic_sort
      from licenses l left join nursery_sites n on n.license = l.license_no and n.active
     where l.active and l.kind in ('cultivation', 'processor', 'nursery')),
  sname as (   -- the strain's name on each license (code on the nursery when coded)
    select lic.*, case when coded and lic.kind = 'nursery' then strain_code(s.id) else metrc_strain(s.id) end as strain_name from lic),
  want as (
    -- the strain itself
    select lic_sort, license_no, kind, site_code, 'strain'::text as what, strain_name as name, null::text as finish, null::int as crop_year, null::text as site,
           null::text as season, true as on_default, 0 as sort, null::text as category, null::text as uom
      from sname
    union all
    -- farm items on the farm's own cultivation license
    select x.lic_sort, x.license_no, x.kind, x.site_code, 'item', item_metrc_name(y, x.site, 'OCAL', r.finish, s.id), r.finish, y, x.site, null,
           r.default_on, 10 + r.sort, r.category, r.uom
      from sname x join sites st on st.code = x.site and st.farm_code is not null
      join metrc_item_rules r on r.license_kind = 'cultivation', unnest(years) y
     where x.kind = 'cultivation'
    union all
    -- processing license: items for every farm's crop
    select x.lic_sort, x.license_no, x.kind, x.site_code, 'item', item_metrc_name(y, st.code, 'OCAL', r.finish, s.id), r.finish, y, st.code, null,
           r.default_on, 10 + r.sort, r.category, r.uom
      from sname x join metrc_item_rules r on r.license_kind = 'processor'
      cross join sites st cross join unnest(years) y
     where x.kind = 'processor' and st.farm_code is not null
    union all
    -- nursery: season x crop year x Clone / URC / Seed
    select x.lic_sort, x.license_no, x.kind, x.site_code, 'item', nursery_item_name(x.nursery_site, y, se, r.finish, x.strain_name), r.finish, y, x.nursery_site, se,
           r.default_on, 10 + r.sort, r.category, r.uom
      from sname x join metrc_item_rules r on r.license_kind = 'nursery', unnest(years) y, unnest(seasons) se
     where x.kind = 'nursery' and x.nursery_site is not null)
  select coalesce(jsonb_agg(jsonb_build_object(
           'key', w.license_no || '|' || w.what || '|' || w.name,
           'license', w.license_no, 'license_kind', w.kind, 'site', w.site_code, 'what', w.what, 'name', w.name,
           'finish', w.finish, 'crop_year', w.crop_year, 'farm', w.site, 'season', w.season, 'category', w.category, 'uom', w.uom,
           'on', w.on_default,
           'state', case when w.what = 'strain' and (ms.id is not null) then 'in_metrc'
                         when w.what = 'item' and mi.id is not null then 'in_metrc'
                         when su.status = 'in_metrc' then 'in_metrc'
                         when su.status = 'queued' then 'queued'
                         else 'new' end,
           'metrc_name', coalesce(ms.name, mi.name),
           'action_id', su.action_id)
         order by w.lic_sort, w.license_no, w.sort, w.crop_year, w.season, w.name), '[]')
    into rows
    from want w
    left join lateral (select m.id, m.name from metrc_strains m
                        where m.license = w.license_no and not m.archived and w.what = 'strain'
                          and (lower(m.name) = lower(w.name)
                               or (w.kind <> 'nursery' or not coded) and lower(m.name) in (select lower(a) from unnest(coalesce(s.aliases, '{}') || s.name) a))
                        order by (lower(m.name) = lower(w.name)) desc limit 1) ms on true
    left join lateral (select m.id, m.name from metrc_items m
                        where m.license = w.license_no and not m.archived and w.what = 'item' and lower(m.name) = lower(w.name) limit 1) mi on true
    left join metrc_setup su on su.license = w.license_no and su.what = w.what and lower(su.metrc_name) = lower(w.name) and su.status <> 'skipped';

  return jsonb_build_object(
    'strain', jsonb_build_object('id', s.id, 'name', s.name, 'metrc_name', metrc_strain(s.id), 'strain_no', s.strain_no, 'code', strain_code(s.id),
                                 'coded', s.metrc_coded, 'testing', s.metrc_testing, 'thc', s.metrc_thc, 'cbd', s.metrc_cbd,
                                 'indica', s.metrc_indica, 'sativa', s.metrc_sativa),
    'years', to_jsonb(years), 'seasons', to_jsonb(seasons), 'coded', coded, 'this_year', yr,
    'can_send', can_metrc_strains(),
    'pulled_at', (select max(seen_at) from metrc_items),
    'modes', (select jsonb_object_agg(kind, mode) from metrc_push_kinds where kind in ('strain_create', 'item_create')),
    'rows', rows);
end $$;
revoke all on function metrc_strain_plan(int, jsonb) from public, anon;
grant execute on function metrc_strain_plan(int, jsonb) to authenticated;

-- =====================================================================================================
-- 6. queue the ticked rows as METRC to-dos
-- p_opts as above plus { metrc_name, testing, thc, cbd, indica, sativa }; p_keys = the ticked rows' keys
-- =====================================================================================================
create or replace function metrc_strain_queue(p_strain int, p_opts jsonb, p_keys text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s strains; plan jsonb; r jsonb; n_s int := 0; n_i int := 0; n_skip int := 0;
  iid bigint; nid bigint; sid bigint; aid bigint; mname text; first_id bigint;
begin
  if not can_metrc_strains() then raise exception 'Only Production, Nursery or Compliance Admins (or Admin) can send a strain to METRC'; end if;
  select * into s from strains where id = p_strain for update;
  if s.id is null then raise exception 'Strain not found'; end if;
  if coalesce(array_length(p_keys, 1), 0) = 0 then raise exception 'Tick what to make in METRC'; end if;

  -- the strain's METRC fields (kept on the strain for next time)
  mname := nullif(trim(p_opts ->> 'metrc_name'), '');
  update strains set
    roshi_name    = case when mname is not null and mname <> name then mname when mname = name then null else roshi_name end,
    metrc_coded   = metrc_coded or coalesce((p_opts ->> 'coded')::boolean, false),
    metrc_testing = coalesce(nullif(p_opts ->> 'testing', ''), metrc_testing),
    metrc_thc     = coalesce((nullif(p_opts ->> 'thc', ''))::numeric, metrc_thc),
    metrc_cbd     = coalesce((nullif(p_opts ->> 'cbd', ''))::numeric, metrc_cbd),
    metrc_indica  = coalesce((nullif(p_opts ->> 'indica', ''))::numeric, metrc_indica),
    metrc_sativa  = coalesce((nullif(p_opts ->> 'sativa', ''))::numeric, metrc_sativa),
    updated_at = now()
   where id = s.id
   returning * into s;
  if s.metrc_indica < 0 or s.metrc_sativa < 0 or s.metrc_indica + s.metrc_sativa <> 100 then raise exception 'Indica + Sativa has to add up to 100'; end if;
  if s.metrc_thc < 0 or s.metrc_cbd < 0 or s.metrc_thc > 100 or s.metrc_cbd > 100 then raise exception 'THC and CBD are percentages (0 to 100)'; end if;

  plan := metrc_strain_plan(s.id, p_opts);
  -- strains first, so their to-dos come before the items that need them
  for r in select x from jsonb_array_elements(plan -> 'rows') x
            where x ->> 'key' = any(p_keys) order by (x ->> 'what') = 'item', x ->> 'license', x ->> 'name' loop
    if r ->> 'state' <> 'new' then n_skip := n_skip + 1; continue; end if;
    iid := null; nid := null;
    if r ->> 'what' = 'item' and r ->> 'license_kind' = 'nursery' then
      insert into metrc_nursery_items (strain_id, site, crop_year, season, finish, metrc_name, license)
      values (s.id, r ->> 'farm', (r ->> 'crop_year')::int, r ->> 'season', r ->> 'finish', r ->> 'name', r ->> 'license')
      on conflict (strain_id, site, crop_year, season, finish) do update set metrc_name = excluded.metrc_name
      returning id into nid;
    elsif r ->> 'what' = 'item' then
      iid := item_for((r ->> 'crop_year')::int, r ->> 'farm', r ->> 'finish', s.id);
    end if;
    insert into metrc_setup (strain_id, license, what, metrc_name, finish, crop_year, site, season, item_id, nursery_item_id, category, uom, status)
    values (s.id, r ->> 'license', r ->> 'what', r ->> 'name', r ->> 'finish', (r ->> 'crop_year')::int, r ->> 'farm', r ->> 'season',
            iid, nid, r ->> 'category', r ->> 'uom', 'queued')
    on conflict (license, what, lower(metrc_name)) do update set status = 'queued', item_id = excluded.item_id, nursery_item_id = excluded.nursery_item_id,
           category = excluded.category, uom = excluded.uom, updated_at = now()
    returning id into sid;
    insert into comp_metrc_actions (license, action, summary, details, kind)
    values (r ->> 'license',
            case r ->> 'what' when 'strain' then 'Create strain in METRC' else 'Create item in METRC' end,
            case r ->> 'what' when 'strain' then 'Strain ' || (r ->> 'name') || case when r ->> 'name' <> s.name then ' (' || s.name || ')' else '' end
                 else (r ->> 'name') || case when s.metrc_coded and r ->> 'license_kind' = 'nursery' then ' (' || s.name || ')' else '' end end,
            jsonb_build_object('type', case r ->> 'what' when 'strain' then 'strain_create' else 'item_create' end,
                               'strain_id', s.id, 'strain', s.name, 'setup_id', sid, 'name', r ->> 'name',
                               'strain_name', metrc_strain_on(s.id, r ->> 'license'),
                               'finish', r ->> 'finish', 'crop_year', (r ->> 'crop_year')::int, 'farm', r ->> 'farm', 'season', r ->> 'season',
                               'category', r ->> 'category', 'uom', r ->> 'uom', 'license_kind', r ->> 'license_kind',
                               'testing', s.metrc_testing, 'thc', s.metrc_thc, 'cbd', s.metrc_cbd, 'indica', s.metrc_indica, 'sativa', s.metrc_sativa),
            case r ->> 'what' when 'strain' then 'strain_create' else 'item_create' end)
    returning id into aid;
    first_id := coalesce(first_id, aid);
    update metrc_setup set action_id = aid where id = sid;
    if r ->> 'what' = 'strain' then n_s := n_s + 1; else n_i := n_i + 1; end if;
  end loop;

  insert into events (user_email, type, note, details)
  values (current_email(), 'metrc_strain_queued', s.name,
          jsonb_build_object('strain_id', s.id, 'strains', n_s, 'items', n_i, 'skipped', n_skip, 'coded', s.metrc_coded, 'opts', p_opts));
  return jsonb_build_object('strains', n_s, 'items', n_i, 'skipped', n_skip, 'first_id', first_id,
                            'modes', (select jsonb_object_agg(kind, mode) from metrc_push_kinds where kind in ('strain_create', 'item_create')));
end $$;
revoke all on function metrc_strain_queue(int, jsonb, text[]) from public, anon;
grant execute on function metrc_strain_queue(int, jsonb, text[]) to authenticated;

-- =====================================================================================================
-- 7. the server writes back what METRC has (after a create, or when it was already there)
-- =====================================================================================================
create or replace function metrc_setup_done(p_setup bigint, p_metrc_id bigint, p_metrc_name text, p_category text default null, p_uom text default null) returns void
language plpgsql security definer set search_path = public as $$
declare su metrc_setup;
begin
  update metrc_setup set status = 'in_metrc', metrc_id = coalesce(p_metrc_id, metrc_id), updated_at = now(),
         category = coalesce(p_category, category), uom = coalesce(p_uom, uom)
   where id = p_setup returning * into su;
  if su.id is null then return; end if;
  if su.what = 'strain' and p_metrc_id is not null then
    insert into metrc_strains (license, id, name, archived, seen_at) values (su.license, p_metrc_id, coalesce(p_metrc_name, su.metrc_name), false, now())
    on conflict (license, id) do update set name = excluded.name, archived = false, seen_at = now();
  elsif su.what = 'item' then
    if p_metrc_id is not null then
      insert into metrc_items (license, id, name, category, uom, seen_at) values (su.license, p_metrc_id, coalesce(p_metrc_name, su.metrc_name), p_category, p_uom, now())
      on conflict (license, id) do update set name = excluded.name, archived = false, seen_at = now();
    end if;
    update items set metrc_status = 'in_metrc', updated_at = now() where id = su.item_id and metrc_status = 'to_create';
    update metrc_nursery_items set metrc_status = 'in_metrc' where id = su.nursery_item_id;
  end if;
end $$;
revoke all on function metrc_setup_done(bigint, bigint, text, text, text) from public, anon, authenticated;
grant execute on function metrc_setup_done(bigint, bigint, text, text, text) to service_role;

-- a skipped / deleted to-do frees its row (so the strain's METRC sheet offers it again)
create or replace function _metrc_setup_free() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind in ('strain_create', 'item_create') and new.status = 'skipped' and old.status is distinct from 'skipped' then
    update metrc_setup set status = 'skipped', updated_at = now() where action_id = new.id and status = 'queued';
  end if;
  return new;
end $$;
drop trigger if exists metrc_setup_free on comp_metrc_actions;
create trigger metrc_setup_free after update of status on comp_metrc_actions for each row execute function _metrc_setup_free();

-- the METRC clone item the app made for a strain on a nursery license, for a cut on a date:
-- Jan to Jun = the Spring item of that year if there is one, else Fall; Jul to Dec = Fall. Then any year (newest first).
create or replace function nursery_metrc_item(p_strain text, p_license text, p_on date, p_finish text default 'CL') returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', su.metrc_id, 'name', su.metrc_name)
    from metrc_setup su
   where su.what = 'item' and su.status = 'in_metrc' and su.metrc_id is not null and su.license = p_license
     and su.finish = coalesce(p_finish, 'CL') and su.strain_id = strain_id_of(p_strain)
   order by (su.crop_year = extract(year from coalesce(p_on, _local_today()))::int) desc,
            (su.season = case when extract(month from coalesce(p_on, _local_today())) <= 6 then 'SP' else 'FL' end) desc,
            su.crop_year desc, su.season = 'FL' desc
   limit 1
$$;
revoke all on function nursery_metrc_item(text, text, date, text) from public, anon;
grant execute on function nursery_metrc_item(text, text, date, text) to authenticated, service_role;

-- =====================================================================================================
-- 8. coded strains list (Nursery > Strains > METRC codes, with a spreadsheet)
-- =====================================================================================================
create or replace function metrc_strain_codes() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'code', strain_code(s.id), 'name', s.name, 'aliases', s.aliases, 'active', s.active, 'coded_at', s.metrc_coded_at,
           'items', (select coalesce(jsonb_agg(jsonb_build_object('license', su.license, 'what', su.what, 'name', su.metrc_name, 'status', su.status)
                                                order by su.license, su.what desc, su.metrc_name), '[]')
                       from metrc_setup su where su.strain_id = s.id and su.status <> 'skipped'
                        and exists (select 1 from licenses l where l.license_no = su.license and l.kind = 'nursery')))
         order by s.strain_no), '[]')
    from strains s where s.metrc_coded and is_staff()
$$;
revoke all on function metrc_strain_codes() from public, anon;
grant execute on function metrc_strain_codes() to authenticated;

select '132 strain METRC ready' as ok;
