-- Migration 063 (Aziz 10/25): one master list of vehicles and equipment in Compliance, assigned to departments,
-- with our drivers and outside carriers (their contacts, license, insurance, trucks and drivers). Run after 062. Safe to re-run.
--  - fleet_assets gains department (distribution / cultivation / nursery / processing / company), body type, pallet layout,
--    and carrier_id (an outside carrier's truck). The old Distribution vehicles table moves in here; loads keep their vehicle.
--  - "vehicles" stays as a read-only view over fleet_assets, so loads, manifests and transfers keep working unchanged.
--  - fleet_drivers: our drivers (with or without an app login) and carrier drivers (never on the app), with license expiry.
--  - fleet_carriers: outside carriers. Their license expiry and insurance certificates (documents) show on Deadlines.
--  - Compliance edits everything. A department's Admins edit their own department's vehicles and drivers;
--    Distribution Admins also edit carriers.

create table if not exists fleet_carriers (
  id              serial primary key,
  name            text not null,
  license_no      text,                 -- DCC distributor / transport license
  license_expires date,
  contact_name    text,
  phone           text,
  email           text,
  address         text,
  notes           text,
  active          boolean not null default true,
  created_by      text default current_email(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists fleet_carriers_name on fleet_carriers (lower(name));

alter table fleet_assets add column if not exists department text not null default 'company';
alter table fleet_assets drop constraint if exists fleet_assets_department_check;
alter table fleet_assets add constraint fleet_assets_department_check check (department in ('distribution','cultivation','nursery','processing','company'));
alter table fleet_assets add column if not exists body_type text;          -- Reefer truck, Box truck, Pickup, Tractor…
alter table fleet_assets add column if not exists pallet_spaces int;
alter table fleet_assets add column if not exists pallets_across int;
alter table fleet_assets add column if not exists carrier_id int references fleet_carriers(id) on delete set null;
alter table fleet_assets add column if not exists legacy_vehicle_id int;
create unique index if not exists fleet_assets_legacy on fleet_assets (legacy_vehicle_id) where legacy_vehicle_id is not null;

create table if not exists fleet_drivers (
  id              serial primary key,
  name            text not null,
  email           text,                 -- their app login, if they have one
  phone           text,
  license_no      text,
  license_class   text,
  license_expires date,
  department      text check (department is null or department in ('distribution','cultivation','nursery','processing','company')),
  carrier_id      int references fleet_carriers(id) on delete cascade,   -- set = an outside carrier's driver
  active          boolean not null default true,
  notes           text,
  created_by      text default current_email(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create table if not exists fleet_driver_assets (
  driver_id int not null references fleet_drivers(id) on delete cascade,
  asset_id  int not null references fleet_assets(id) on delete cascade,
  primary key (driver_id, asset_id)
);

alter table fleet_carriers enable row level security;
alter table fleet_drivers enable row level security;
alter table fleet_driver_assets enable row level security;
drop policy if exists fleet_read on fleet_carriers; drop policy if exists fleet_read on fleet_drivers; drop policy if exists fleet_read on fleet_driver_assets;
create policy fleet_read on fleet_carriers for select to authenticated using (is_staff());
create policy fleet_read on fleet_drivers for select to authenticated using (is_staff());
create policy fleet_read on fleet_driver_assets for select to authenticated using (is_staff());
revoke all on fleet_carriers, fleet_drivers, fleet_driver_assets from anon;
revoke insert, update, delete on fleet_carriers, fleet_drivers, fleet_driver_assets from authenticated;
grant select on fleet_carriers, fleet_drivers, fleet_driver_assets to authenticated;
grant all on fleet_carriers, fleet_drivers, fleet_driver_assets to service_role;

alter table comp_doc_links drop constraint if exists comp_doc_links_ref_kind_check;
alter table comp_doc_links add constraint comp_doc_links_ref_kind_check
  check (ref_kind in ('test','pallet','lot','harvest','material','license','customer','metrc_error','obligation','processor','asset','fleet_log','carrier','driver'));

-- ---------- move the Distribution vehicles in (once) ----------
do $$
declare v record; cid int; aid int; is_ours boolean; cname text;
begin
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'vehicles') then
    for v in select * from vehicles order by id loop
      is_ours := coalesce(nullif(trim(v.owner), ''), 'Lifted') ~* '^(lifted|dna organics)';
      cid := null;
      if not is_ours then
        cname := trim(regexp_replace(v.owner, '\s*\(\s*outside carrier\s*\)\s*$', '', 'i'));
        select id into cid from fleet_carriers where lower(name) = lower(cname);
        if cid is null then insert into fleet_carriers (name, created_by) values (cname, 'migration 063') returning id into cid; end if;
      end if;
      select id into aid from fleet_assets where legacy_vehicle_id = v.id;
      if aid is null then
        insert into fleet_assets (kind, name, plate, body_type, notes, status, pallet_spaces, pallets_across, department, carrier_id,
                                  checklist, legacy_vehicle_id, created_by)
        values (case when coalesce(v.kind, '') ~* 'trailer' then 'trailer' else 'vehicle' end, v.name, upper(nullif(trim(v.plate), '')), nullif(trim(v.kind), ''),
                v.notes, case when v.active then 'active' else 'retired' end, v.spaces, v.across,
                case when is_ours then 'distribution' else 'company' end, cid,
                case when is_ours then (case when coalesce(v.kind, '') ~* 'trailer' then 'trailer' else 'vehicle' end) end, v.id, 'migration 063')
        returning id into aid;
      end if;
    end loop;
    -- loads point at the new ids
    alter table loads drop constraint if exists loads_vehicle_id_fkey;
    update loads l set vehicle_id = a.id from fleet_assets a where a.legacy_vehicle_id = l.vehicle_id and l.vehicle_id <> a.id;
    alter table vehicles rename to vehicles_legacy;
  end if;
end $$;
-- (re-runnable) loads.vehicle_id -> fleet_assets
alter table loads drop constraint if exists loads_vehicle_id_fkey;
alter table loads add constraint loads_vehicle_id_fkey foreign key (vehicle_id) references fleet_assets(id);

-- what loads, manifests and transfers read: Distribution vehicles + carrier trucks (+ anything a load already used)
create or replace view vehicles with (security_invoker = true) as
  select a.id, a.name, a.plate, coalesce(a.body_type, initcap(a.kind)) as kind, a.notes, a.status <> 'retired' and (a.department = 'distribution' or a.carrier_id is not null) as active,
         a.updated_at, coalesce(a.pallet_spaces, 8) as spaces, coalesce(a.pallets_across, 2) as across,
         coalesce(c.name, 'Lifted') as owner, a.department, a.carrier_id
    from fleet_assets a left join fleet_carriers c on c.id = a.carrier_id
   where a.kind in ('vehicle', 'trailer');
grant select on vehicles to authenticated;

-- ---------- who can edit what ----------
-- department -> module key for "Admin of that department"
create or replace function fleet_dept_admin(p_dept text) returns boolean
language sql stable security definer set search_path = public as $$
  select not impersonating() and (comp_can_edit() or is_owner() or
         (p_dept in ('distribution','cultivation','nursery','processing') and coalesce(is_mod_admin(p_dept), false)))
$$;
create or replace function fleet_carrier_admin() returns boolean
language sql stable security definer set search_path = public as $$ select fleet_dept_admin('distribution') $$;
-- the departments this person can add to / edit
create or replace function fleet_my_depts() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(d), '{}') from unnest(array['distribution','cultivation','nursery','processing','company']) d where fleet_dept_admin(d)
$$;

-- ---------- vehicles and equipment ----------
create or replace function fleet_save_asset(p jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare v_id int := nullif(p ->> 'id', '')::int; v_name text := nullif(trim(p ->> 'name'), ''); a fleet_assets;
        v_carrier int; v_dept text;
begin
  if v_name is null then raise exception 'Give it a name'; end if;
  if v_id is not null then
    select * into a from fleet_assets where id = v_id;
    if a.id is null then raise exception 'Vehicle not found'; end if;
  end if;
  v_carrier := case when p ? 'carrier_id' then nullif(p ->> 'carrier_id', '')::int else a.carrier_id end;
  v_dept := coalesce(nullif(p ->> 'department', ''), a.department, 'company');
  -- permission: carrier trucks = Compliance or Distribution Admins; ours = Compliance or that department's Admins (old and new department)
  if v_carrier is not null or a.carrier_id is not null then
    if not fleet_carrier_admin() then raise exception 'Only Compliance or a Distribution Admin can change carrier vehicles'; end if;
  elsif not (fleet_dept_admin(v_dept) and (a.id is null or fleet_dept_admin(a.department))) then
    raise exception 'Only Compliance or a % Admin can change this', initcap(case v_dept when 'cultivation' then 'production' else v_dept end);
  end if;
  if v_id is null then
    insert into fleet_assets (kind, name, department) values (coalesce(nullif(p ->> 'kind', ''), 'vehicle'), v_name, v_dept) returning id into v_id;
  end if;
  update fleet_assets set
    kind = coalesce(nullif(p ->> 'kind', ''), kind),
    name = v_name,
    department = v_dept,
    carrier_id = v_carrier,
    unit_no = case when p ? 'unit_no' then nullif(trim(p ->> 'unit_no'), '') else unit_no end,
    site = case when p ? 'site' then nullif(upper(trim(p ->> 'site')), '') else site end,
    make = case when p ? 'make' then nullif(trim(p ->> 'make'), '') else make end,
    model = case when p ? 'model' then nullif(trim(p ->> 'model'), '') else model end,
    year = case when p ? 'year' then nullif(p ->> 'year', '')::int else year end,
    vin = case when p ? 'vin' then nullif(upper(trim(p ->> 'vin')), '') else vin end,
    plate = case when p ? 'plate' then nullif(upper(trim(p ->> 'plate')), '') else plate end,
    body_type = case when p ? 'body_type' then nullif(trim(p ->> 'body_type'), '') else body_type end,
    pallet_spaces = case when p ? 'pallet_spaces' then nullif(p ->> 'pallet_spaces', '')::int else pallet_spaces end,
    pallets_across = case when p ? 'pallets_across' then nullif(p ->> 'pallets_across', '')::int else pallets_across end,
    assigned_to = case when p ? 'assigned_to' then nullif(trim(p ->> 'assigned_to'), '') else assigned_to end,
    status = coalesce(nullif(p ->> 'status', ''), status),
    checklist = case when p ? 'checklist' then nullif(p ->> 'checklist', '') else checklist end,
    inspect_every_days = case when p ? 'inspect_every_days' then nullif(p ->> 'inspect_every_days', '')::int else inspect_every_days end,
    service_every_days = case when p ? 'service_every_days' then nullif(p ->> 'service_every_days', '')::int else service_every_days end,
    service_every_miles = case when p ? 'service_every_miles' then nullif(p ->> 'service_every_miles', '')::numeric else service_every_miles end,
    service_every_hours = case when p ? 'service_every_hours' then nullif(p ->> 'service_every_hours', '')::numeric else service_every_hours end,
    odometer = case when p ? 'odometer' then nullif(p ->> 'odometer', '')::numeric else odometer end,
    hours = case when p ? 'hours' then nullif(p ->> 'hours', '')::numeric else hours end,
    notes = case when p ? 'notes' then nullif(trim(p ->> 'notes'), '') else notes end,
    updated_at = now()
  where id = v_id;
  -- drivers who drive it (our drivers only; carrier trucks list their carrier's drivers)
  if p ? 'driver_ids' then
    delete from fleet_driver_assets where asset_id = v_id;
    insert into fleet_driver_assets (driver_id, asset_id)
    select (x)::int, v_id from jsonb_array_elements_text(coalesce(p -> 'driver_ids', '[]')) x on conflict do nothing;
  end if;
  perform _comp_event('fleet_asset', v_name, jsonb_build_object('id', v_id, 'new', a.id is null, 'department', v_dept));
  return v_id;
end $$;

-- ---------- drivers ----------
create or replace function fleet_save_driver(p jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare v_id int := nullif(p ->> 'id', '')::int; d fleet_drivers; v_name text := nullif(trim(p ->> 'name'), '');
        v_carrier int; v_dept text;
begin
  if v_name is null then raise exception 'Give the driver a name'; end if;
  if v_id is not null then select * into d from fleet_drivers where id = v_id; if d.id is null then raise exception 'Driver not found'; end if; end if;
  v_carrier := case when p ? 'carrier_id' then nullif(p ->> 'carrier_id', '')::int else d.carrier_id end;
  v_dept := case when v_carrier is not null then null else coalesce(nullif(p ->> 'department', ''), d.department, 'distribution') end;
  if v_carrier is not null or d.carrier_id is not null then
    if not fleet_carrier_admin() then raise exception 'Only Compliance or a Distribution Admin can change carrier drivers'; end if;
  elsif not (fleet_dept_admin(v_dept) and (d.id is null or d.department is null or fleet_dept_admin(d.department))) then
    raise exception 'Only Compliance or that department''s Admins can change this driver';
  end if;
  if v_id is null then insert into fleet_drivers (name) values (v_name) returning id into v_id; end if;
  update fleet_drivers set name = v_name, carrier_id = v_carrier, department = v_dept,
    email = case when p ? 'email' then nullif(lower(trim(p ->> 'email')), '') else email end,
    phone = case when p ? 'phone' then nullif(trim(p ->> 'phone'), '') else phone end,
    license_no = case when p ? 'license_no' then nullif(upper(trim(p ->> 'license_no')), '') else license_no end,
    license_class = case when p ? 'license_class' then nullif(trim(p ->> 'license_class'), '') else license_class end,
    license_expires = case when p ? 'license_expires' then nullif(p ->> 'license_expires', '')::date else license_expires end,
    active = coalesce((p ->> 'active')::boolean, active),
    notes = case when p ? 'notes' then nullif(trim(p ->> 'notes'), '') else notes end,
    updated_at = now()
  where id = v_id;
  if p ? 'asset_ids' then
    delete from fleet_driver_assets where driver_id = v_id;
    insert into fleet_driver_assets (driver_id, asset_id)
    select v_id, (x)::int from jsonb_array_elements_text(coalesce(p -> 'asset_ids', '[]')) x on conflict do nothing;
  end if;
  perform _comp_event('fleet_driver', v_name, jsonb_build_object('id', v_id, 'new', d.id is null, 'carrier', v_carrier));
  return v_id;
end $$;

-- ---------- carriers ----------
create or replace function fleet_save_carrier(p jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare v_id int := nullif(p ->> 'id', '')::int; v_name text := nullif(trim(p ->> 'name'), ''); c fleet_carriers;
begin
  if not fleet_carrier_admin() then raise exception 'Only Compliance or a Distribution Admin can change carriers'; end if;
  if v_name is null then raise exception 'Give the carrier a name'; end if;
  if v_id is not null then select * into c from fleet_carriers where id = v_id; if c.id is null then raise exception 'Carrier not found'; end if; end if;
  if exists (select 1 from fleet_carriers where lower(name) = lower(v_name) and id is distinct from v_id) then raise exception 'There''s already a carrier called %', v_name; end if;
  if v_id is null then insert into fleet_carriers (name) values (v_name) returning id into v_id; end if;
  update fleet_carriers set name = v_name,
    license_no = case when p ? 'license_no' then nullif(upper(trim(p ->> 'license_no')), '') else license_no end,
    license_expires = case when p ? 'license_expires' then nullif(p ->> 'license_expires', '')::date else license_expires end,
    contact_name = case when p ? 'contact_name' then nullif(trim(p ->> 'contact_name'), '') else contact_name end,
    phone = case when p ? 'phone' then nullif(trim(p ->> 'phone'), '') else phone end,
    email = case when p ? 'email' then nullif(lower(trim(p ->> 'email')), '') else email end,
    address = case when p ? 'address' then nullif(trim(p ->> 'address'), '') else address end,
    notes = case when p ? 'notes' then nullif(trim(p ->> 'notes'), '') else notes end,
    active = coalesce((p ->> 'active')::boolean, active),
    updated_at = now()
  where id = v_id;
  -- a carrier that's switched off takes its trucks off the load list
  if (p ->> 'active')::boolean is false then update fleet_assets set status = 'retired', updated_at = now() where carrier_id = v_id; end if;
  perform _comp_event('fleet_carrier', v_name, jsonb_build_object('id', v_id, 'new', c.id is null));
  return v_id;
end $$;

-- everything the Vehicles screens need (060 + departments, drivers, carriers)
create or replace function fleet_data(p_since date default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not is_staff() then null else jsonb_build_object(
    'assets', coalesce((select jsonb_agg(to_jsonb(a) || jsonb_build_object(
        'last_inspection', (select max(happened_on) from fleet_logs l where l.asset_id = a.id and l.kind = 'inspection' and l.deleted_at is null),
        'last_service', (select max(happened_on) from fleet_logs l where l.asset_id = a.id and l.kind = 'maintenance' and l.deleted_at is null),
        'open', (select count(*) from fleet_logs l where l.asset_id = a.id and l.status = 'open' and l.deleted_at is null),
        'driver_ids', (select coalesce(jsonb_agg(x.driver_id), '[]') from fleet_driver_assets x where x.asset_id = a.id),
        'docs', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'doc_type', d.doc_type, 'title', d.title, 'expires_on', d.expires_on) order by d.doc_type, d.expires_on), '[]')
                   from comp_doc_links k join comp_docs d on d.id = k.doc_id
                  where k.ref_kind = 'asset' and k.ref_id = a.id::text and d.deleted_at is null and d.current and d.doc_type <> 'fleet'))
      order by a.status = 'retired', a.kind, coalesce(a.unit_no, ''), a.name) from fleet_assets a), '[]'),
    'logs', coalesce((select jsonb_agg(to_jsonb(l) || jsonb_build_object('files', (select count(*) from comp_doc_links k join comp_docs d on d.id = k.doc_id
                                                                                   where k.ref_kind = 'fleet_log' and k.ref_id = l.id::text and d.deleted_at is null))
                                       order by l.happened_on desc, l.id desc)
                        from fleet_logs l where l.deleted_at is null and (l.happened_on >= coalesce(p_since, current_date - 730) or l.status = 'open')), '[]'),
    'checklists', coalesce((select jsonb_agg(to_jsonb(c) order by c.sort) from fleet_checklists c where c.active), '[]'),
    'drivers', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'email', d.email, 'phone', d.phone,
        'license_no', case when fleet_dept_admin(coalesce(d.department, 'distribution')) then d.license_no end,
        'license_class', d.license_class, 'license_expires', d.license_expires, 'department', d.department, 'carrier_id', d.carrier_id,
        'active', d.active, 'notes', d.notes,
        'has_login', d.email is not null and exists (select 1 from app_users u where u.email = d.email and u.role in ('admin','sales','crew')),
        'asset_ids', (select coalesce(jsonb_agg(x.asset_id), '[]') from fleet_driver_assets x where x.driver_id = d.id))
      order by d.active desc, d.carrier_id nulls first, d.name) from fleet_drivers d), '[]'),
    'carriers', coalesce((select jsonb_agg(to_jsonb(c) || jsonb_build_object(
        'docs', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'doc_type', d.doc_type, 'title', d.title, 'expires_on', d.expires_on) order by d.expires_on), '[]')
                   from comp_doc_links k join comp_docs d on d.id = k.doc_id
                  where k.ref_kind = 'carrier' and k.ref_id = c.id::text and d.deleted_at is null and d.current))
      order by c.active desc, c.name) from fleet_carriers c), '[]'),
    'can_edit', comp_can_edit(), 'my_depts', to_jsonb(fleet_my_depts()), 'carrier_admin', fleet_carrier_admin(), 'me', current_email()
  ) end
$$;

-- Deadlines (060) + carrier licenses and driver licenses
create or replace function comp_deadlines() returns table (
  kind text, ref text, title text, category text, site text, due_on date, days_left int, remind_days int, owner_email text,
  repeat_months int, notes text, doc_type text)
language sql stable security definer set search_path = public as $$
  select * from (
    select 'obligation', o.id::text, o.title, o.category, o.site, o.due_on, (o.due_on - current_date)::int, o.remind_days, o.owner_email, o.repeat_months, o.notes, o.doc_type
      from comp_obligations o where o.active
    union all
    select 'doc', d.id::text, 'Renew: ' || d.title, coalesce((select case t.key when 'licenses' then 'license' when 'ccof_cert' then 'ccof' when 'insurance' then 'insurance' when 'transport' then 'vehicles' else 'other' end
                                                            from comp_doc_types t where t.key = d.doc_type), 'other'),
           d.site, d.expires_on, (d.expires_on - current_date)::int, 60, d.owner_email, null::int, d.notes, d.doc_type
      from comp_docs d where d.deleted_at is null and d.current and d.expires_on is not null
    union all
    select 'license', l.license_no, 'License renewal: ' || l.license_no || ' (' || coalesce(l.site, l.entity, '') || ' ' || l.kind || ')', 'license',
           l.site, l.expires, (l.expires - current_date)::int, 60, null, null::int, null, 'licenses'
      from licenses l where l.active
    union all
    select 'material', m.id::text, 'Listing expires: ' || m.name || coalesce(' (' || m.listing || ')', ''), 'ccof', null, m.listing_expires,
           (m.listing_expires - current_date)::int, 30, null, null::int, null, case when m.pesticide then 'pesticides' else 'fertilizers' end
      from input_products m where m.active and m.listing_expires is not null
    union all
    select 'customer', c.id::text, 'Customer license expires: ' || c.name || coalesce(' (' || c.license || ')', ''), 'license', null, c.license_expires,
           (c.license_expires - current_date)::int, 30, null, null::int, null, 'customers'
      from customers c where c.active and c.kind = 'external' and c.license_expires is not null
    union all
    select 'fleet', f.asset_id::text || ':' || f.what, f.title, 'vehicles', f.site, f.due_on, (f.due_on - current_date)::int,
           case when f.what = 'inspection' then 7 else 14 end, null, null::int, f.notes, 'fleet'
      from fleet_due() f
    union all
    select 'fleet', 'carrier:' || c.id, 'Carrier license expires: ' || c.name || coalesce(' (' || c.license_no || ')', ''), 'vehicles', null, c.license_expires,
           (c.license_expires - current_date)::int, 30, null, null::int, null, 'partners'
      from fleet_carriers c where c.active and c.license_expires is not null
    union all
    select 'fleet', 'driver:' || d.id, 'Driver''s license expires: ' || d.name || coalesce(' (' || c.name || ')', ''), 'vehicles', null, d.license_expires,
           (d.license_expires - current_date)::int, 30, null, null::int, null, 'transport'
      from fleet_drivers d left join fleet_carriers c on c.id = d.carrier_id where d.active and d.license_expires is not null
  ) x where comp_can_read()
  order by due_on nulls first
$$;

revoke execute on function fleet_dept_admin(text), fleet_carrier_admin(), fleet_my_depts(), fleet_save_driver(jsonb), fleet_save_carrier(jsonb) from public, anon;
grant execute on function fleet_dept_admin(text), fleet_carrier_admin(), fleet_my_depts(), fleet_save_driver(jsonb), fleet_save_carrier(jsonb) to authenticated;
