-- Migration 060 (feedback sheet 10/24): Compliance > Vehicles and equipment, Nursery leachate % auto-calc, customer statements and balances.
-- Safe to re-run.
--
-- Vehicles and equipment (Beth's request, Compliance):
--  - fleet_assets: vehicles, trailers (incl. the 4 reefers), equipment (combine, tractors, forklifts).
--  - Insurance policies and registrations are Compliance documents linked to the asset (ref_kind 'asset'),
--    so their expiry dates land on Deadlines and they back up to SharePoint like every other document.
--  - fleet_logs: maintenance, inspections and incidents, filled out in the app. ANY crew member or driver can file one
--    (Aziz, 10/24: not tied to the Compliance role); photos go in the same private bucket under fleet/.
--  - fleet_checklists: the inspection checklist per kind of asset (editable later).
--  - Due service and inspections show on Compliance > Deadlines.
--
-- Leachate (Nursery > Logs > Leachate): Leach % = leachate volume / front emitter mL x 100, Expected % = average of
-- front and back emitter mL / water per plant x 100 (the math in the 2026 Field Leachate sheet). Recalculated on every save; old rows backfilled.

-- =====================================================================================================
-- Vehicles and equipment
-- =====================================================================================================
create table if not exists fleet_checklists (
  key     text primary key,
  label   text not null,
  items   jsonb not null default '[]',      -- [{"k": "lights", "l": "Lights and signals"}, ...]
  sort    int not null default 0,
  active  boolean not null default true
);
insert into fleet_checklists (key, label, items, sort) values
  ('vehicle', 'Vehicle (pre-trip)', '[
    {"k":"lights","l":"Lights, signals, hazards"},{"k":"brakes","l":"Brakes and parking brake"},{"k":"tires","l":"Tires and wheels"},
    {"k":"steering","l":"Steering"},{"k":"horn","l":"Horn"},{"k":"wipers","l":"Wipers and windshield"},{"k":"mirrors","l":"Mirrors"},
    {"k":"belts","l":"Seat belts"},{"k":"fluids","l":"Oil, coolant, fluids"},{"k":"leaks","l":"No leaks"},{"k":"body","l":"Body and doors (no new damage)"},
    {"k":"extinguisher","l":"Fire extinguisher"},{"k":"firstaid","l":"First aid kit"},{"k":"papers","l":"Registration and insurance card in the vehicle"},
    {"k":"cargo","l":"Cargo area clean, locks and seals"}]', 1),
  ('trailer', 'Trailer / reefer', '[
    {"k":"hitch","l":"Hitch, coupler, safety chains"},{"k":"lights","l":"Lights and signals"},{"k":"brakes","l":"Brakes and breakaway"},
    {"k":"tires","l":"Tires and wheels"},{"k":"doors","l":"Doors, locks, seals"},{"k":"reefer","l":"Reefer running, temperature OK"},
    {"k":"fuel","l":"Reefer fuel"},{"k":"floor","l":"Floor and walls clean, no damage"},{"k":"papers","l":"Registration on file"}]', 2),
  ('equipment', 'Equipment', '[
    {"k":"fluids","l":"Oil, hydraulic, coolant levels"},{"k":"leaks","l":"No leaks"},{"k":"tires","l":"Tires or tracks"},
    {"k":"guards","l":"Guards and shields in place"},{"k":"belts","l":"Belts and chains"},{"k":"hydraulics","l":"Hydraulic hoses"},
    {"k":"lights","l":"Lights and backup alarm"},{"k":"controls","l":"Controls and seat"},{"k":"extinguisher","l":"Fire extinguisher"},
    {"k":"decals","l":"Safety decals readable"}]', 3)
on conflict (key) do nothing;

create table if not exists fleet_assets (
  id                  serial primary key,
  kind                text not null default 'vehicle' check (kind in ('vehicle','trailer','equipment')),
  name                text not null,
  unit_no             text,                -- our own number (truck 3, R1…)
  site                text,                -- home site (OHR, GVR, 1PN)
  make                text, model text, year int,
  vin                 text,                -- VIN or serial number
  plate               text,
  assigned_to         text,
  status              text not null default 'active' check (status in ('active','out_of_service','retired')),
  checklist           text references fleet_checklists(key) on update cascade,
  inspect_every_days  int,                 -- blank = no regular inspection
  service_every_days  int,
  service_every_miles numeric,
  service_every_hours numeric,
  odometer            numeric,             -- last reading from any report
  hours               numeric,
  notes               text,
  created_by          text default current_email(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists fleet_logs (
  id             bigserial primary key,
  asset_id       int references fleet_assets(id) on delete set null,
  kind           text not null check (kind in ('maintenance','inspection','incident')),
  happened_on    date not null default current_date,
  happened_at    time,
  odometer       numeric,
  hours          numeric,
  summary        text,                      -- one line: "Oil change", "Pre-trip, 1 defect", "Backed into gate post"
  details        jsonb not null default '{}', -- the rest of the form (checklist answers, people, injuries…)
  result         text,                      -- inspection: pass / defects / out_of_service
  status         text not null default 'closed' check (status in ('open','closed')),  -- open = defects to fix / incident to follow up
  closed_note    text, closed_by text, closed_at timestamptz,
  cost           numeric,
  vendor         text,
  performed_by   text,
  next_due_on    date,                      -- maintenance: next service
  next_due_miles numeric,
  next_due_hours numeric,
  created_by     text default current_email(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);
create index if not exists fleet_logs_asset on fleet_logs (asset_id, happened_on desc);
create index if not exists fleet_logs_open on fleet_logs (status) where status = 'open' and deleted_at is null;

alter table fleet_checklists enable row level security;
alter table fleet_assets enable row level security;
alter table fleet_logs enable row level security;
drop policy if exists fleet_read on fleet_checklists; drop policy if exists fleet_read on fleet_assets; drop policy if exists fleet_read on fleet_logs;
create policy fleet_read on fleet_checklists for select to authenticated using (is_staff());
create policy fleet_read on fleet_assets for select to authenticated using (is_staff());
create policy fleet_read on fleet_logs for select to authenticated using (is_staff() and deleted_at is null);
revoke all on fleet_checklists, fleet_assets, fleet_logs from anon;
grant select on fleet_checklists, fleet_assets, fleet_logs to authenticated;
grant all on fleet_checklists, fleet_assets, fleet_logs to service_role;

-- documents can link to an asset (insurance, registration) or a report (photos)
alter table comp_doc_links drop constraint if exists comp_doc_links_ref_kind_check;
alter table comp_doc_links add constraint comp_doc_links_ref_kind_check
  check (ref_kind in ('test','pallet','lot','harvest','material','license','customer','metrc_error','obligation','processor','asset','fleet_log'));
insert into comp_doc_types (key, label, folder, sort, expires, notes) values
  ('fleet', 'Vehicle and Equipment Records', 'Vehicle and Equipment Records', 18, false, 'Maintenance, inspection and incident report photos')
on conflict (key) do nothing;
update comp_doc_types set notes = 'Vehicle registrations, distributor transport' where key = 'transport' and notes = 'Vehicle registration, distributor transport';

-- any crew member can add report photos (path fleet/…); everything else in the bucket keeps the 055 rule
drop policy if exists comp_files_add_fleet on storage.objects;
create policy comp_files_add_fleet on storage.objects for insert to authenticated
  with check (bucket_id = 'compliance' and name like 'fleet/%' and public.is_staff() and not public.impersonating());

create or replace function fleet_can_report() returns boolean
language sql stable security definer set search_path = public as $$ select coalesce(is_staff(), false) and not impersonating() $$;

-- ---------- assets (Compliance users) ----------
create or replace function fleet_save_asset(p jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare v_id int := nullif(p ->> 'id', '')::int; v_name text := nullif(trim(p ->> 'name'), '');
begin
  if not comp_can_edit() then raise exception 'Only Compliance can add or change vehicles and equipment'; end if;
  if v_name is null then raise exception 'Give it a name'; end if;
  if v_id is null then
    insert into fleet_assets (kind, name) values (coalesce(nullif(p ->> 'kind', ''), 'vehicle'), v_name) returning id into v_id;
  end if;
  update fleet_assets set
    kind = coalesce(nullif(p ->> 'kind', ''), kind),
    name = v_name,
    unit_no = case when p ? 'unit_no' then nullif(trim(p ->> 'unit_no'), '') else unit_no end,
    site = case when p ? 'site' then nullif(upper(trim(p ->> 'site')), '') else site end,
    make = case when p ? 'make' then nullif(trim(p ->> 'make'), '') else make end,
    model = case when p ? 'model' then nullif(trim(p ->> 'model'), '') else model end,
    year = case when p ? 'year' then nullif(p ->> 'year', '')::int else year end,
    vin = case when p ? 'vin' then nullif(upper(trim(p ->> 'vin')), '') else vin end,
    plate = case when p ? 'plate' then nullif(upper(trim(p ->> 'plate')), '') else plate end,
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
  perform _comp_event('fleet_asset', v_name, jsonb_build_object('id', v_id, 'new', p ->> 'id' is null));
  return v_id;
end $$;

-- ---------- reports (any crew member) ----------
create or replace function fleet_save_log(p jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint := nullif(p ->> 'id', '')::bigint; v_kind text := p ->> 'kind'; old fleet_logs; a fleet_assets;
        v_asset int := nullif(p ->> 'asset_id', '')::int; v_status text; v_result text := nullif(p ->> 'result', '');
        v_odo numeric := nullif(p ->> 'odometer', '')::numeric; v_hrs numeric := nullif(p ->> 'hours', '')::numeric;
begin
  if not fleet_can_report() then raise exception 'Sign in with your Lifted account to file a report'; end if;
  if v_kind not in ('maintenance','inspection','incident') then raise exception 'Unknown report type'; end if;
  if v_asset is null and v_kind <> 'incident' then raise exception 'Pick the vehicle or equipment'; end if;
  if v_asset is not null then
    select * into a from fleet_assets where id = v_asset;
    if a.id is null then raise exception 'Vehicle or equipment not found'; end if;
  end if;
  if v_kind = 'inspection' and v_result not in ('pass','defects','out_of_service') then raise exception 'Pick the inspection result'; end if;
  if v_kind = 'incident' and nullif(trim(coalesce(p ->> 'summary', '')), '') is null then raise exception 'Say what happened'; end if;
  if v_kind = 'maintenance' and nullif(trim(coalesce(p ->> 'summary', '')), '') is null then raise exception 'Say what was done'; end if;
  v_status := case when v_kind = 'incident' then 'open' when v_kind = 'inspection' and v_result <> 'pass' then 'open' else 'closed' end;
  if v_id is not null then
    select * into old from fleet_logs where id = v_id and deleted_at is null;
    if old.id is null then raise exception 'Report not found'; end if;
    if not (comp_can_edit() or (old.created_by = current_email() and old.created_at > now() - interval '1 day')) then
      raise exception 'Only Compliance can change a report after the day it was filed';
    end if;
    update fleet_logs set asset_id = v_asset, kind = v_kind,
      happened_on = coalesce(nullif(p ->> 'happened_on', '')::date, happened_on), happened_at = nullif(p ->> 'happened_at', '')::time,
      odometer = v_odo, hours = v_hrs, summary = nullif(trim(p ->> 'summary'), ''), details = coalesce(p -> 'details', '{}'), result = v_result,
      status = case when old.status = 'closed' and old.closed_at is not null then 'closed' else v_status end,
      cost = nullif(p ->> 'cost', '')::numeric, vendor = nullif(trim(p ->> 'vendor'), ''), performed_by = nullif(trim(p ->> 'performed_by'), ''),
      next_due_on = nullif(p ->> 'next_due_on', '')::date, next_due_miles = nullif(p ->> 'next_due_miles', '')::numeric,
      next_due_hours = nullif(p ->> 'next_due_hours', '')::numeric, updated_at = now()
    where id = v_id;
  else
    insert into fleet_logs (asset_id, kind, happened_on, happened_at, odometer, hours, summary, details, result, status, cost, vendor, performed_by,
                            next_due_on, next_due_miles, next_due_hours)
    values (v_asset, v_kind, coalesce(nullif(p ->> 'happened_on', '')::date, current_date), nullif(p ->> 'happened_at', '')::time, v_odo, v_hrs,
            nullif(trim(p ->> 'summary'), ''), coalesce(p -> 'details', '{}'), v_result, v_status, nullif(p ->> 'cost', '')::numeric,
            nullif(trim(p ->> 'vendor'), ''), nullif(trim(p ->> 'performed_by'), ''), nullif(p ->> 'next_due_on', '')::date,
            nullif(p ->> 'next_due_miles', '')::numeric, nullif(p ->> 'next_due_hours', '')::numeric)
    returning id into v_id;
  end if;
  -- latest readings on the asset; failed inspection takes it out of service until Compliance puts it back
  if v_asset is not null then
    update fleet_assets set odometer = greatest(coalesce(odometer, 0), coalesce(v_odo, 0)), hours = greatest(coalesce(hours, 0), coalesce(v_hrs, 0)),
           status = case when v_kind = 'inspection' and v_result = 'out_of_service' and status = 'active' then 'out_of_service' else status end,
           updated_at = now()
     where id = v_asset;
    update fleet_assets set odometer = nullif(odometer, 0), hours = nullif(hours, 0) where id = v_asset;
  end if;
  perform _comp_event('fleet_' || v_kind, coalesce(a.name, '') || coalesce(': ' || nullif(trim(p ->> 'summary'), ''), ''),
                      jsonb_build_object('id', v_id, 'asset', v_asset, 'result', v_result, 'edit', old.id is not null));
  return v_id;
end $$;

create or replace function fleet_close_log(p_id bigint, p_note text, p_open boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare l fleet_logs;
begin
  if not comp_can_edit() then raise exception 'Only Compliance can close a report'; end if;
  select * into l from fleet_logs where id = p_id and deleted_at is null;
  if l.id is null then raise exception 'Report not found'; end if;
  if p_open then
    update fleet_logs set status = 'open', closed_note = null, closed_by = null, closed_at = null, updated_at = now() where id = p_id;
  else
    update fleet_logs set status = 'closed', closed_note = nullif(trim(p_note), ''), closed_by = current_email(), closed_at = now(), updated_at = now() where id = p_id;
  end if;
  perform _comp_event('fleet_closed', coalesce((select name from fleet_assets where id = l.asset_id), '') || coalesce(': ' || l.summary, ''),
                      jsonb_build_object('id', p_id, 'open', p_open, 'note', p_note));
end $$;

create or replace function fleet_delete_log(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare l fleet_logs;
begin
  select * into l from fleet_logs where id = p_id and deleted_at is null;
  if l.id is null then raise exception 'Report not found'; end if;
  if not (comp_can_edit() or (l.created_by = current_email() and l.created_at > now() - interval '1 day' and fleet_can_report())) then
    raise exception 'Only Compliance can remove a report (or whoever filed it, the same day)';
  end if;
  update fleet_logs set deleted_at = now(), updated_at = now() where id = p_id;
  perform _comp_event('fleet_deleted', coalesce(l.summary, l.kind), jsonb_build_object('id', p_id));
end $$;

-- a photo or file on a report (any crew member, own reports; Compliance any report)
create or replace function fleet_add_file(p_log bigint, p jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare l fleet_logs; v_id bigint; v_name text;
begin
  if not fleet_can_report() then raise exception 'Not allowed'; end if;
  select * into l from fleet_logs where id = p_log and deleted_at is null;
  if l.id is null then raise exception 'Report not found'; end if;
  if not (comp_can_edit() or l.created_by = current_email()) then raise exception 'Only whoever filed the report (or Compliance) can add photos to it'; end if;
  if coalesce(p ->> 'file_path', '') !~ '^fleet/' then raise exception 'Bad file path'; end if;
  select name into v_name from fleet_assets where id = l.asset_id;
  insert into comp_docs (doc_type, title, site, file_path, file_name, mime, size_bytes, effective_on, notes)
  values ('fleet', coalesce(nullif(trim(p ->> 'title'), ''), initcap(l.kind) || coalesce(' · ' || v_name, '') || ' · ' || to_char(l.happened_on, 'YYYY-MM-DD')),
          (select site from fleet_assets where id = l.asset_id), p ->> 'file_path', nullif(p ->> 'file_name', ''), nullif(p ->> 'mime', ''),
          nullif(p ->> 'size_bytes', '')::bigint, l.happened_on, nullif(trim(p ->> 'notes'), ''))
  returning id into v_id;
  insert into comp_doc_links (doc_id, ref_kind, ref_id) values (v_id, 'fleet_log', p_log::text) on conflict do nothing;
  if l.asset_id is not null then insert into comp_doc_links (doc_id, ref_kind, ref_id) values (v_id, 'asset', l.asset_id::text) on conflict do nothing; end if;
  return v_id;
end $$;

-- everything the Vehicles screens need in one call
create or replace function fleet_data(p_since date default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not is_staff() then null else jsonb_build_object(
    'assets', coalesce((select jsonb_agg(to_jsonb(a) || jsonb_build_object(
        'last_inspection', (select max(happened_on) from fleet_logs l where l.asset_id = a.id and l.kind = 'inspection' and l.deleted_at is null),
        'last_service', (select max(happened_on) from fleet_logs l where l.asset_id = a.id and l.kind = 'maintenance' and l.deleted_at is null),
        'open', (select count(*) from fleet_logs l where l.asset_id = a.id and l.status = 'open' and l.deleted_at is null),
        'docs', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'doc_type', d.doc_type, 'title', d.title, 'expires_on', d.expires_on) order by d.doc_type, d.expires_on), '[]')
                   from comp_doc_links k join comp_docs d on d.id = k.doc_id
                  where k.ref_kind = 'asset' and k.ref_id = a.id::text and d.deleted_at is null and d.current and d.doc_type <> 'fleet'))
      order by a.status = 'retired', a.kind, coalesce(a.unit_no, ''), a.name) from fleet_assets a), '[]'),
    'logs', coalesce((select jsonb_agg(to_jsonb(l) || jsonb_build_object('files', (select count(*) from comp_doc_links k join comp_docs d on d.id = k.doc_id
                                                                                   where k.ref_kind = 'fleet_log' and k.ref_id = l.id::text and d.deleted_at is null))
                                       order by l.happened_on desc, l.id desc)
                        from fleet_logs l where l.deleted_at is null and (l.happened_on >= coalesce(p_since, current_date - 730) or l.status = 'open')), '[]'),
    'checklists', coalesce((select jsonb_agg(to_jsonb(c) order by c.sort) from fleet_checklists c where c.active), '[]'),
    'can_edit', comp_can_edit(), 'me', current_email()
  ) end
$$;

-- when the next service / inspection is due, per asset (shared by Deadlines and the Vehicles screen)
create or replace function fleet_due() returns table (asset_id int, what text, title text, site text, due_on date, notes text)
language sql stable security definer set search_path = public as $$
  with a as (select * from fleet_assets where status <> 'retired'),
  svc as (
    select a.id, a.name, a.site,
           (select l.next_due_on from fleet_logs l where l.asset_id = a.id and l.kind = 'maintenance' and l.deleted_at is null and l.next_due_on is not null
             order by l.happened_on desc, l.id desc limit 1) as next_set,
           (select max(happened_on) from fleet_logs l where l.asset_id = a.id and l.kind = 'maintenance' and l.deleted_at is null) as last_svc,
           a.service_every_days, a.inspect_every_days, a.created_at::date as since,
           (select max(happened_on) from fleet_logs l where l.asset_id = a.id and l.kind = 'inspection' and l.deleted_at is null) as last_insp
      from a)
  select id, 'service', 'Service due: ' || name, site,
         coalesce(next_set, case when service_every_days is not null then coalesce(last_svc, since) + service_every_days end), null
    from svc where next_set is not null or service_every_days is not null
  union all
  select id, 'inspection', 'Inspection due: ' || name, site, coalesce(last_insp, since) + inspect_every_days, null
    from svc where inspect_every_days is not null
$$;

-- Deadlines (055) + vehicle service and inspections
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
  ) x where comp_can_read()
  order by due_on nulls first
$$;

revoke execute on function fleet_can_report(), fleet_save_asset(jsonb), fleet_save_log(jsonb), fleet_close_log(bigint, text, boolean),
  fleet_delete_log(bigint), fleet_add_file(bigint, jsonb), fleet_data(date), fleet_due(), comp_deadlines() from public, anon;
grant execute on function fleet_can_report(), fleet_save_asset(jsonb), fleet_save_log(jsonb), fleet_close_log(bigint, text, boolean),
  fleet_delete_log(bigint), fleet_add_file(bigint, jsonb), fleet_data(date), fleet_due(), comp_deadlines() to authenticated;

-- =====================================================================================================
-- Nursery leachate: Leach % and Expected % calculate themselves
-- =====================================================================================================
create or replace function _leachate_calc() returns trigger
language plpgsql set search_path = public as $$
declare n int := (case when new.front_ml is not null then 1 else 0 end) + (case when new.back_ml is not null then 1 else 0 end);
begin
  new.leach_pct := case when new.leach_vol is not null and coalesce(new.front_ml, 0) > 0 then round(new.leach_vol / new.front_ml * 100, 1) end;
  new.expect_pct := case when n > 0 and coalesce(new.water_ml_plant, 0) > 0
                         then round((coalesce(new.front_ml, 0) + coalesce(new.back_ml, 0)) / n / new.water_ml_plant * 100, 1) end;
  return new;
end $$;
drop trigger if exists leachate_calc on nursery_leachate;
create trigger leachate_calc before insert or update on nursery_leachate for each row execute function _leachate_calc();
-- backfill: fills the blanks; rows that already match the sheet are unchanged
update nursery_leachate set leach_vol = leach_vol;

-- =====================================================================================================
-- Customer dashboard and statement (Matt's request): balance, statement, lbs picked up this month
-- =====================================================================================================
-- QuickBooks is the source of truth for payments. Refunds and discounts are credit memos there, and older invoices
-- came from Roshi, so the headline balance is the QuickBooks customer balance (pulled on the hourly payment check),
-- with the open invoices and credits QuickBooks has. Until QuickBooks production is connected, the app's own open invoices are used.
create table if not exists acct_customer_balances (
  customer_id     int not null references customers(id) on delete cascade,
  env             text not null,
  qbo_customer_id text,
  balance         numeric,
  open_items      jsonb not null default '[]',   -- [{type, doc, date, due, total, balance}] open invoices and unused credits in QuickBooks
  synced_at       timestamptz not null default now(),
  primary key (customer_id, env)
);
alter table acct_customer_balances enable row level security;
drop policy if exists read_bal on acct_customer_balances;
create policy read_bal on acct_customer_balances for select to authenticated using (has_module('accounting') or is_sales());
revoke all on acct_customer_balances from anon;
grant select on acct_customer_balances to authenticated;
grant all on acct_customer_balances to service_role;

-- the server writes what QuickBooks says (api/qbo/_lib.js syncBalances); rows: [{customer_id, qbo_customer_id, balance, open_items}]
create or replace function acct_record_balances(p_env text, p_rows jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; r jsonb;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]')) loop
    insert into acct_customer_balances (customer_id, env, qbo_customer_id, balance, open_items, synced_at)
    values ((r ->> 'customer_id')::int, p_env, r ->> 'qbo_customer_id', nullif(r ->> 'balance', '')::numeric, coalesce(r -> 'open_items', '[]'), now())
    on conflict (customer_id, env) do update set qbo_customer_id = excluded.qbo_customer_id, balance = excluded.balance,
      open_items = excluded.open_items, synced_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function acct_record_balances(text, jsonb) from public, anon, authenticated;
grant execute on function acct_record_balances(text, jsonb) to service_role;

-- one customer's dashboard and statement. Customers get their own; Sales and Accounting can pass any customer.
create or replace function customer_statement(p_customer int default null, p_from date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_c int := coalesce(my_customer(), case when is_sales() or has_module('accounting') then p_customer end);
  v_env text := case when exists (select 1 from qbo_connection where env = 'production' and active) then 'production' end;
  v_from date := coalesce(p_from, (current_date - interval '12 months')::date);
  v_month date := date_trunc('month', current_date)::date;
  v_year int := crop_year();
  cu customers; b acct_customer_balances; t record;
  v_inv jsonb; v_app_bal numeric; v_app_due numeric; v_shipped numeric; v_pending numeric; v_res jsonb;
begin
  if v_c is null then return null; end if;
  select * into cu from customers where id = v_c;
  if cu.id is null then return null; end if;
  if v_env is not null then select * into b from acct_customer_balances where customer_id = v_c and env = v_env; end if;
  select * into t from terms_for(v_c, v_year) limit 1;

  -- invoices from the app (newest first), each with QuickBooks' balance when it has one
  select coalesce(jsonb_agg(x order by x.invoice_date desc, x.id desc), '[]') into v_inv from (
    select i.id, i.inv_number, i.invoice_date, i.due_date, i.total, i.status, i.terms_label, i.po_number, i.share_token,
           o.so_number,
           case when i.status = 'void' then 0 when i.status = 'paid' then 0
                when p.balance is not null then p.balance else i.total end as balance,
           (i.status = 'open' and coalesce(p.balance, i.total) > 0 and i.due_date < current_date) as past_due
      from invoices i
      left join orders o on o.id = i.order_id
      left join acct_pushes p on p.invoice_id = i.id and p.env = v_env
     where i.customer_id = v_c and i.status <> 'void' and (i.invoice_date >= v_from or i.status = 'open')
  ) x;
  select coalesce(sum((e ->> 'balance')::numeric), 0), coalesce(sum((e ->> 'balance')::numeric) filter (where (e ->> 'past_due')::boolean), 0)
    into v_app_bal, v_app_due from jsonb_array_elements(v_inv) e;

  -- fresh frozen picked up this month, and what's ordered but not shipped yet
  select coalesce(sum(l.lbs) filter (where o.status = 'shipped' and coalesce(o.shipped_date, o.order_date) >= v_month), 0),
         coalesce(sum(l.lbs) filter (where o.status in ('pending','submitted')), 0)
    into v_shipped, v_pending
    from orders o join order_lines l on l.order_id = o.id
   where o.customer_id = v_c and l.product = 'fresh_frozen';
  select jsonb_build_object('reserved', coalesce(sum(r.reserved), 0), 'shipped', coalesce(sum(r.shipped), 0), 'pending', coalesce(sum(r.pending), 0),
                            'remaining', coalesce(sum(r.remaining), 0), 'strains', count(*))
    into v_res from reserve_balances r where r.customer_id = v_c and coalesce(r.crop_year, v_year) = v_year;

  return jsonb_build_object(
    'customer', jsonb_build_object('id', cu.id, 'name', cu.name, 'terms', cu.payment_terms),
    'balance', jsonb_build_object(
       'amount', case when b.balance is not null then b.balance else v_app_bal end,
       'past_due', case when b.balance is not null then coalesce((select sum((e ->> 'balance')::numeric) from jsonb_array_elements(b.open_items) e
                                                                    where e ->> 'type' = 'Invoice' and (e ->> 'due')::date < current_date), 0) else v_app_due end,
       'source', case when b.balance is not null then 'quickbooks' else 'app' end,
       'synced_at', b.synced_at),
    'open_items', case when b.balance is not null then b.open_items else '[]'::jsonb end,
    'invoices', v_inv,
    'month', jsonb_build_object('start', v_month, 'shipped', v_shipped, 'min', t.monthly_min_lbs,
                                'left', case when t.monthly_min_lbs is not null then greatest(t.monthly_min_lbs - v_shipped, 0) end),
    'pending_lbs', v_pending,
    'reserves', v_res || jsonb_build_object('year', v_year),
    'contract_lbs', t.contract_lbs,
    'price_per_lb', t.price_per_lb,
    'from', v_from
  );
end $$;
revoke execute on function customer_statement(int, date) from public, anon;
grant execute on function customer_statement(int, date) to authenticated;
