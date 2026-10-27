-- 075_metrc_phase12.sql: METRC through T3, the rest of Phase 1 and Phase 2.
-- Phase 1: splits, combines (emptied sources finished), finish / remove, tag and hand-made package checks,
--          transfers (OHR <> GVR, to processors), customer manifests, receiving (Distribution > Inbound),
--          per-stop METRC checklist that blocks Depart.
-- Phase 2: METRC locations / strains / plant batches / plants / harvests pulled in, location and strain mapping,
--          nursery actions (clone packages from mother lots, mother lots from clone packages, losses),
--          farm plantings, the flip to flowering (overnight), the harvest chain (harvest plants, packages from harvest
--          at Push, waste, finish), each harvest/plant kind gated by a cutover date per site.
-- Every new kind starts Off. Nothing goes to METRC until a Compliance Admin turns a kind on, and Live is on.
-- Re-runnable. Run after 074.
set client_min_messages = warning;

-- =====================================================================================================
-- 1. kinds
-- =====================================================================================================
create or replace function metrc_kind(p_type text) returns text
language sql immutable as $$
  select case p_type
    when 'weight_adjust' then 'adjust'
    when 'split_from' then 'split'
    when 'merge' then 'combine'
    when 'removed' then 'finish'
    when 'tag_set' then 'tag'
    when 'created' then 'new_package'
    when 'stop_departed' then 'manifest'        -- set to transfer for stops at our own sites (see _metrc_set_kind)
    when 'proc_sent' then 'transfer'
    when 'move' then 'ship_check'
    when 'shipped' then 'ship_check'
    when 'received' then 'receive'
    when 'proc_received' then 'receive'
    when 'harvest_plants' then 'harvest_plants'
    when 'harvested' then 'harvest_package'
    when 'pushed' then 'harvest_package'
    when 'proc_wet' then 'harvest_package'
    when 'proc_output' then 'proc_output'
    when 'proc_used' then 'proc_used'
    when 'proc_run_done' then 'run_waste'
    when 'harvest_waste' then 'harvest_waste'
    when 'harvest_finish' then 'harvest_finish'
    when 'nursery_cut' then 'nursery_clones'
    when 'nursery_mother_lot' then 'nursery_mothers'
    when 'nursery_loss' then 'nursery_loss'
    when 'planting_made' then 'planting'
    when 'planting_loss' then 'plant_loss'
    when 'planting_flip' then 'flower'
    when 'nursery_shipped' then 'transfer'
    else 'other' end
$$;

create or replace function _metrc_set_kind() returns trigger
language plpgsql as $$
begin
  new.kind := coalesce(new.kind,
    case when new.details ->> 'type' = 'removed' and new.details ->> 'reason' = 'shipped' then 'ship_check'
         when new.details ->> 'type' = 'stop_departed' and coalesce((new.details ->> 'internal')::boolean, false) then 'transfer'
         else metrc_kind(new.details ->> 'type') end);
  return new;
end $$;

-- open to-dos get the new kinds (done ones keep theirs)
update comp_metrc_actions set kind = case when details ->> 'type' = 'removed' and details ->> 'reason' = 'shipped' then 'ship_check'
                                          else metrc_kind(details ->> 'type') end
 where status in ('todo', 'error') and coalesce(push_state, '') <> 'sending'
   and kind is distinct from case when details ->> 'type' = 'removed' and details ->> 'reason' = 'shipped' then 'ship_check' else metrc_kind(details ->> 'type') end;

insert into metrc_push_kinds (kind, label, phase, sort, ready) values
  ('adjust',          'Package weight adjustments',                         1, 10, true),
  ('split',           'Splits (new package from a package)',                1, 20, true),
  ('combine',         'Combines (emptied sources finished)',                1, 30, true),
  ('finish',          'Remove: used up (adjust to 0, finish)',              1, 40, true),
  ('tag',             'Tag fixes (checks METRC has the tag)',               1, 50, true),
  ('new_package',     'Package entered by hand (checks METRC has it)',      1, 55, true),
  ('transfer',        'Transfers: OHR / GVR, to processors',                1, 60, true),
  ('manifest',        'Customer manifests',                                 1, 70, true),
  ('ship_check',      'Shipped: check it left on a METRC manifest',         1, 75, true),
  ('receive',         'Receiving',                                          1, 80, true),
  ('nursery_clones',  'Nursery: clone package from a mother lot',           2, 90, true),
  ('nursery_mothers', 'Nursery: mother lot from a clone package',           2, 92, true),
  ('nursery_loss',    'Nursery: lost clones / mothers',                     2, 94, true),
  ('planting',        'Farm planting (plant batch from clone packages)',    2, 100, true),
  ('plant_loss',      'Farm planting losses (destroy from the batch)',      2, 102, true),
  ('flower',          'Flip to flowering (overnight, with plant tags)',     2, 105, true),
  ('harvest_plants',  'Harvest plants (count + wet weight)',                2, 110, true),
  ('harvest_package', 'Packages from harvest (at Push)',                    2, 120, true),
  ('harvest_waste',   'Harvest waste',                                      2, 150, true),
  ('harvest_finish',  'Finish harvest',                                     2, 170, true),
  ('proc_output',     'Processing outputs',                                 4, 130, false),
  ('proc_used',       'Processing inputs used',                             4, 140, false),
  ('run_waste',       'Run waste / moisture loss',                          5, 160, false),
  ('other',           'Other',                                              9, 999, false)
on conflict (kind) do update set label = excluded.label, phase = excluded.phase, sort = excluded.sort, ready = excluded.ready;

-- which kinds wait for a site cutover date (harvest and plant work keeps going by hand until then)
create or replace function metrc_kind_needs_cutover(p_kind text) returns boolean
language sql immutable as $$
  select p_kind in ('nursery_clones', 'nursery_mothers', 'nursery_loss', 'planting', 'plant_loss', 'flower',
                    'harvest_plants', 'harvest_package', 'harvest_waste', 'harvest_finish')
$$;

-- the site a license belongs to (OHR / GVR / 1PN)
create or replace function metrc_license_site(p_license text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select upper(site) from licenses where license_no = p_license and site is not null limit 1),
                  (select upper(code) from nursery_sites where license = p_license limit 1))
$$;

-- a to-do of a cutover kind can go once its site has a cutover date and the to-do is from that date on
create or replace function metrc_past_cutover(p_kind text, p_license text, p_at timestamptz) returns boolean
language sql stable security definer set search_path = public as $$
  select not metrc_kind_needs_cutover(p_kind) or coalesce(
    (select p_at >= (nullif(value, ''))::date::timestamp at time zone 'America/Los_Angeles'
       from app_settings where key = 'comp.metrc_cutover_' || metrc_license_site(p_license)), false)
$$;

-- =====================================================================================================
-- 2. every tag a to-do touches, so the sender keeps them in order (a split touches its parent too)
-- =====================================================================================================
alter table comp_metrc_actions add column if not exists touch_tags text[] not null default '{}';
create index if not exists comp_metrc_actions_touch on comp_metrc_actions using gin (touch_tags) where status in ('todo', 'error');

create or replace function metrc_touch_tags(a comp_metrc_actions) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct upper(t)) filter (where nullif(trim(t), '') is not null), '{}') from (
    select a.tag as t
    union all select p.package_tag from pallets p where a.details ->> 'type' = 'split_from' and p.id = nullif(a.details ->> 'parent_id', '')::bigint
    union all select p.package_tag from pallets p where a.details ->> 'type' = 'merge' and p.merged_into = a.pallet_id
    union all select p.package_tag from pallets p where a.details ->> 'type' = 'tag_set' and a.details ->> 'from' is not null and p.id = a.pallet_id
    union all select a.details ->> 'from' where a.details ->> 'type' = 'tag_set'
    union all select a.details ->> 'old_tag' where a.details ->> 'type' = 'proc_received'
  ) x
$$;

create or replace function _metrc_set_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.touch_tags := metrc_touch_tags(new);
  return new;
end $$;
drop trigger if exists metrc_set_touch on comp_metrc_actions;
create trigger metrc_set_touch before insert on comp_metrc_actions for each row execute function _metrc_set_touch();

update comp_metrc_actions a set touch_tags = metrc_touch_tags(a) where a.status in ('todo', 'error');

-- a pending tag filled in later: the open to-dos for that package pick it up
create or replace function _metrc_tag_filled() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.package_tag is not null and new.package_tag is distinct from old.package_tag then
    update comp_metrc_actions a set tag = coalesce(a.tag, new.package_tag),
           touch_tags = (select coalesce(array_agg(distinct x), '{}') from unnest(a.touch_tags || upper(new.package_tag)) x)
     where a.status in ('todo', 'error') and a.pallet_id = new.id and coalesce(a.push_state, '') <> 'sending'
       and a.kind in ('split', 'combine', 'new_package', 'harvest_package', 'proc_output');
  end if;
  return new;
exception when others then return new;
end $$;
drop trigger if exists metrc_tag_filled on pallets;
create trigger metrc_tag_filled after update of package_tag on pallets for each row execute function _metrc_tag_filled();

-- =====================================================================================================
-- 3. claim: cutover dates, overnight-only kinds, earlier to-dos on the same tags first
-- =====================================================================================================
create or replace function metrc_claim(p_ids bigint[], p_limit int default 40) returns setof comp_metrc_actions
language plpgsql security definer set search_path = public as $$
begin
  update comp_metrc_actions set push_state = 'failed', push_error = coalesce(push_error, 'Stopped mid-send; will retry')
   where push_state = 'sending' and push_at < now() - interval '10 minutes' and kind <> 'flower';
  update comp_metrc_actions set push_state = 'failed', push_error = coalesce(push_error, 'Stopped mid-send; will retry')
   where push_state = 'sending' and push_at < now() - interval '30 minutes' and kind = 'flower';
  return query
  update comp_metrc_actions a set push_state = 'sending', push_attempts = a.push_attempts + 1, push_at = now()
   where a.id in (
     select x.id from comp_metrc_actions x join metrc_push_kinds k on k.kind = x.kind
      where x.status in ('todo', 'error') and k.ready
        and coalesce(x.push_state, '') <> 'sending'
        and metrc_past_cutover(x.kind, x.license, x.at)
        and (case when p_ids is not null then x.id = any(p_ids) and k.mode <> 'off'
                  else k.mode = 'auto' and x.kind <> 'flower' and (x.due_at is null or x.due_at <= now())
                       and (x.push_state is null or x.push_state in ('checked', 'waiting')
                            or (x.push_state = 'failed' and x.push_attempts < 3 and x.push_at < now() - interval '15 minutes')) end)
      order by x.id
      limit greatest(1, least(coalesce(p_limit, 40), 200))
      for update of x skip locked)
  returning a.*;
end $$;

-- the overnight run: flips to flowering on Auto (and ones someone tapped Send on, which wait for the night)
create or replace function metrc_claim_night(p_limit int default 5) returns setof comp_metrc_actions
language plpgsql security definer set search_path = public as $$
begin
  return query
  update comp_metrc_actions a set push_state = 'sending', push_attempts = a.push_attempts + 1, push_at = now()
   where a.id in (
     select x.id from comp_metrc_actions x join metrc_push_kinds k on k.kind = x.kind
      where x.status in ('todo', 'error') and k.ready and x.kind = 'flower' and k.mode <> 'off'
        and metrc_past_cutover(x.kind, x.license, x.at)
        and (k.mode = 'auto' or x.details ? 'queued_by')
        and (x.push_state is null or x.push_state in ('checked', 'waiting') or (x.push_state = 'failed' and x.push_attempts < 5))
      order by x.id limit greatest(1, least(coalesce(p_limit, 5), 20))
      for update of x skip locked)
  returning a.*;
end $$;

-- Send on a flip (Approve mode): queue it for tonight
create or replace function metrc_queue_night(p_ids bigint[]) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not coalesce((metrc_me() ->> 'can_send')::boolean, false) then raise exception 'Only Compliance (or a Distribution / Processing Admin) can send to METRC'; end if;
  update comp_metrc_actions set details = details || jsonb_build_object('queued_by', current_email(), 'queued_at', now()),
         push_state = 'waiting', push_error = 'Queued for tonight''s run'
   where id = any(p_ids) and kind = 'flower' and status in ('todo', 'error');
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function metrc_queue_night(bigint[]) from public, anon;
grant execute on function metrc_queue_night(bigint[]) to authenticated;

-- results can also carry progress (big jobs done in pieces) and close sibling to-dos covered by the same METRC action
create or replace function metrc_result(p_id bigint, p_state text, p_by text, p_request jsonb, p_response jsonb, p_error text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_state not in ('checked', 'sent', 'failed', 'waiting') then raise exception 'Bad state'; end if;
  update comp_metrc_actions set
    push_state = p_state, push_by = p_by, push_at = now(),
    push_request = coalesce(p_request, push_request), push_response = coalesce(p_response, push_response),
    push_error = case when p_state in ('failed', 'waiting') then left(p_error, 1000) end,
    push_attempts = case when p_state in ('checked', 'waiting') then greatest(push_attempts - 1, 0) else push_attempts end,
    status = case when p_state = 'sent' then 'done' else status end,
    note = case when p_state = 'sent' then coalesce(left(p_error, 500), note) else note end,
    done_by = case when p_state = 'sent' then 'Lifted App via T3 (' || coalesce(p_by, '?') || ')' else done_by end,
    done_at = case when p_state = 'sent' then now() else done_at end
   where id = p_id;
  if p_state in ('sent', 'failed') then
    insert into events (user_email, type, note, details)
    values (coalesce(p_by, 'metrc worker'), 'metrc_push', p_error,
            jsonb_build_object('id', p_id, 'state', p_state, 'error', left(p_error, 300)));
  end if;
end $$;

-- siblings: other open to-dos the same METRC action covered (the rest of a stop packages, the rest of a delivery)
create or replace function metrc_close_siblings(p_ids bigint[], p_by text, p_note text) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update comp_metrc_actions set status = 'done', push_state = 'sent', push_by = p_by, push_at = now(), push_error = null,
         note = left(p_note, 500), done_by = 'Lifted App via T3 (' || coalesce(p_by, '?') || ')', done_at = now()
   where id = any(p_ids) and status in ('todo', 'error') and coalesce(push_state, '') <> 'sending';
  get diagnostics n = row_count;
  return n;
end $$;
create or replace function metrc_progress(p_id bigint, p_progress jsonb) returns void
language sql security definer set search_path = public as $$
  update comp_metrc_actions set push_response = coalesce(push_response, '{}'::jsonb) || jsonb_build_object('progress', p_progress), push_at = now() where id = p_id
$$;

revoke all on function metrc_claim(bigint[], int) from public, anon, authenticated;
revoke all on function metrc_claim_night(int) from public, anon, authenticated;
revoke all on function metrc_result(bigint, text, text, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function metrc_close_siblings(bigint[], text, text) from public, anon, authenticated;
revoke all on function metrc_progress(bigint, jsonb) from public, anon, authenticated;
grant execute on function metrc_claim(bigint[], int), metrc_claim_night(int), metrc_result(bigint, text, text, jsonb, jsonb, text),
                          metrc_close_siblings(bigint[], text, text), metrc_progress(bigint, jsonb) to service_role;

create or replace function metrc_set_mode(p_kind text, p_mode text) returns void
language plpgsql security definer set search_path = public as $$
declare k metrc_push_kinds;
begin
  if not comp_is_admin() then raise exception 'Only a Compliance Admin can change how the app sends to METRC'; end if;
  select * into k from metrc_push_kinds where kind = p_kind for update;
  if not found then raise exception 'Unknown kind'; end if;
  if p_mode not in ('off', 'approve', 'auto') then raise exception 'Off, Approve or Auto'; end if;
  if p_mode <> 'off' and not k.ready then raise exception 'The app can''t send "%" yet (phase %)', k.label, k.phase; end if;
  update metrc_push_kinds set mode = p_mode, updated_by = current_email(), updated_at = now() where kind = p_kind;
  perform _comp_event('metrc_mode', p_kind, jsonb_build_object('kind', p_kind, 'mode', p_mode, 'was', k.mode));
end $$;

-- =====================================================================================================
-- 4. settings
-- =====================================================================================================
insert into app_settings (key, value) values
  ('comp.metrc_reason_used', 'Scale Variance'),
  ('comp.metrc_ttype_internal', ''),          -- METRC transfer type for our own licenses (OHR <> GVR)
  ('comp.metrc_ttype_customer', ''),          -- customers (no prices: pick a type that is not Wholesale)
  ('comp.metrc_ttype_processor', ''),         -- out to a drying processor
  ('comp.metrc_ttype_nursery', ''),           -- 1PN clones out to farms
  ('comp.metrc_phone', ''),                   -- phone for questions on manifests
  ('comp.metrc_transit_hours', '3'),
  ('comp.metrc_proc_driver', ''),             -- driver name for processor runs (no load in the app)
  ('comp.metrc_proc_vehicle', ''),            -- fleet asset id for processor runs
  ('comp.metrc_waste_type', ''),              -- harvest waste type (blank = METRC first harvest waste type)
  ('comp.metrc_plant_waste_reason', ''),      -- reason for destroying immature plants / lost clones
  ('comp.metrc_plant_adjust_reason', ''),     -- reason for lost clones in a clone package
  ('comp.metrc_cutover_OHR', ''), ('comp.metrc_cutover_GVR', ''), ('comp.metrc_cutover_1PN', '')
on conflict (key) do nothing;

create or replace function comp_set_setting(p_key text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not comp_is_admin() then raise exception 'Only a Compliance Admin can change Compliance settings'; end if;
  if p_key not in ('comp.weight_tol', 'comp.stale_days', 'comp.sp_site', 'comp.sp_root',
                   'comp.metrc_live', 'comp.metrc_reason_drying', 'comp.metrc_reason_scale', 'comp.metrc_reason_waste', 'comp.metrc_reason_entry',
                   'comp.metrc_reason_used', 'comp.metrc_ttype_internal', 'comp.metrc_ttype_customer', 'comp.metrc_ttype_processor', 'comp.metrc_ttype_nursery',
                   'comp.metrc_phone', 'comp.metrc_transit_hours', 'comp.metrc_proc_driver', 'comp.metrc_proc_vehicle',
                   'comp.metrc_waste_type', 'comp.metrc_plant_waste_reason', 'comp.metrc_plant_adjust_reason',
                   'comp.metrc_cutover_OHR', 'comp.metrc_cutover_GVR', 'comp.metrc_cutover_1PN')
  then raise exception 'Unknown setting'; end if;
  if p_key = 'comp.metrc_live' and coalesce(trim(p_value), '') not in ('true', 'false') then raise exception 'Live is true or false'; end if;
  if p_key like 'comp.metrc_cutover_%' and nullif(trim(p_value), '') is not null and trim(p_value) !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Cutover is a date (YYYY-MM-DD) or blank'; end if;
  if p_key = 'comp.metrc_transit_hours' and (nullif(trim(p_value), '') is null or trim(p_value) !~ '^\d+(\.\d+)?$') then raise exception 'Hours, a number'; end if;
  insert into app_settings (key, value) values (p_key, coalesce(trim(p_value), '')) on conflict (key) do update set value = excluded.value;
  if p_key in ('comp.sp_site', 'comp.sp_root') then update comp_docs set backed_up_at = null, sp_item_id = null, sp_path = null where backed_up_at is not null; end if;
  perform _comp_event('comp_setting', p_key, jsonb_build_object('key', p_key, 'value', p_value));
end $$;
revoke all on function comp_set_setting(text, text) from public, anon;
grant execute on function comp_set_setting(text, text) to authenticated;

-- transfer types, drivers, vehicles per license (from the connection test)
alter table metrc_connection add column if not exists transfer jsonb;   -- { license: { types: [...], drivers: [...], vehicles: [...] } }

-- =====================================================================================================
-- 5. transfers and manifests made by the app
-- =====================================================================================================
create table if not exists metrc_app_transfers (
  id                bigserial primary key,
  key               text not null unique,          -- stop:<stop id>:<from license> / proc:<processor>:<date>:<from license>
  kind              text not null,                 -- transfer / manifest
  license           text not null,                 -- shipper
  recipient_license text,
  recipient_name    text,
  stop_id           int,
  load_id           int,
  transfer_type     text,
  transfer_id       bigint,
  delivery_id       bigint,
  manifest          text,
  state             text not null default 'created' check (state in ('created', 'received', 'voided')),
  packages          jsonb,                         -- [{ tag, lbs, pallet_id, metrc_id }]
  request           jsonb,
  created_by        text,
  created_at        timestamptz not null default now(),
  received_at       timestamptz,
  received_by       text
);
create index if not exists metrc_app_transfers_stop on metrc_app_transfers (stop_id);
alter table metrc_app_transfers enable row level security;
drop policy if exists read_app_transfers on metrc_app_transfers;
create policy read_app_transfers on metrc_app_transfers for select to authenticated using (is_staff());
grant select on metrc_app_transfers to authenticated;
grant all on metrc_app_transfers to service_role;
grant usage on sequence metrc_app_transfers_id_seq to service_role;

-- each stop METRC checklist (written by the server; Depart reads it)
create table if not exists metrc_stop_checks (
  stop_id     int not null,
  license     text not null,
  ok          boolean not null,
  checks      jsonb not null,                      -- [{ key, ok, label, detail }]
  checked_at  timestamptz not null default now(),
  checked_by  text,
  primary key (stop_id, license)
);
alter table metrc_stop_checks enable row level security;
drop policy if exists read_stop_checks on metrc_stop_checks;
create policy read_stop_checks on metrc_stop_checks for select to authenticated using (is_staff());
grant select on metrc_stop_checks to authenticated;
grant all on metrc_stop_checks to service_role;

-- every package on a stop (a mixed pallet is several packages), with the license it ships from
create or replace function metrc_stop_packages(p_stop int)
returns table (pallet_id bigint, top_id bigint, code text, tag text, tag_pending boolean, strain text, lbs numeric, product text,
               from_site text, from_license text, item text)
language sql stable security definer set search_path = public as $$
  select p.id, t.id, p.code, upper(p.package_tag), coalesce(p.tag_pending, false), p.strain, p.current_weight, p.product,
         x.fs, site_license(x.fs), (select metrc_name from items where id = p.item_id)
    from load_items i join pallets t on t.id = i.pallet_id
    join pallets p on ((p.id = t.id and t.kind is distinct from 'mixed') or (p.container_id = t.id and t.kind = 'mixed'))
    cross join lateral (select coalesce(i.from_site, pallet_site(t)) as fs) x
   where i.stop_id = p_stop
$$;
revoke all on function metrc_stop_packages(int) from public, anon;
grant execute on function metrc_stop_packages(int) to authenticated, service_role;

-- what the server needs to build a stop METRC transfer
create or replace function metrc_stop_info(p_stop int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s load_stops; l loads; c customers; a fleet_assets; site text; dr fleet_drivers;
begin
  select * into s from load_stops where id = p_stop;
  if s.id is null then return null; end if;
  select * into l from loads where id = s.load_id;
  select * into c from customers where id = s.customer_id;
  select * into a from fleet_assets where id = l.vehicle_id;
  select * into dr from fleet_drivers where active and lower(name) = lower(trim(l.driver)) order by carrier_id nulls first limit 1;
  site := case when c.kind = 'internal' and upper(c.name) in ('OHR', 'GVR') then upper(c.name) end;
  return jsonb_build_object(
    'stop_id', s.id, 'seq', s.seq, 'status', s.status, 'manifest', s.manifest,
    'load_id', l.id, 'load', l.code, 'load_date', l.load_date, 'load_status', l.status, 'departed_at', l.departed_at,
    'internal', site is not null, 'to_site', site,
    'to_license', coalesce(site_license(site), c.license), 'to_name', coalesce(c.legal_name, c.name), 'customer', c.name,
    'to_address', coalesce(c.ship_to_address, c.address),
    'driver', l.driver, 'driver_license', dr.license_no, 'driver_carrier', dr.carrier_id,
    'vehicle', a.name, 'make', a.make, 'model', a.model, 'plate', a.plate, 'vehicle_carrier', a.carrier_id,
    'transporter', transport_license(),
    'orders', (select coalesce(jsonb_agg(coalesce(o.so_number, 'Order #' || o.id) order by o.id), '[]'::jsonb) from orders o
                where o.stop_id = s.id or exists (select 1 from order_picks x join load_items i on i.pallet_id = x.pallet_id where x.order_id = o.id and i.stop_id = s.id)),
    'packages', (select coalesce(jsonb_agg(to_jsonb(k) order by k.from_site, k.code), '[]'::jsonb) from metrc_stop_packages(s.id) k));
end $$;
revoke all on function metrc_stop_info(int) from public, anon, authenticated;
grant execute on function metrc_stop_info(int) to service_role;

-- is METRCending on for this stop kind? (Off = done by hand, the checklist is only advice)
create or replace function metrc_stop_kind_on(p_internal boolean) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select mode <> 'off' from metrc_push_kinds where kind = case when p_internal then 'transfer' else 'manifest' end), false)
$$;

-- Depart: every stop the app sends to METRC needs a green checklist from the last hour; then one to-do per stop and license
create or replace function depart_load(p_load int) returns void
language plpgsql security definer set search_path = public as $$
declare l loads; n int; s record; bad text;
begin
  perform require_staff();
  select * into l from loads where id = p_load for update;
  if l.status not in ('planning','loading') then raise exception 'Load % is %', l.code, l.status; end if;
  select count(*) into n from load_items where load_id = l.id and not loaded;
  if n > 0 then raise exception '% pallet(s) planned but not loaded yet. Load them or remove them first.', n; end if;
  if not exists (select 1 from load_items where load_id = l.id) then raise exception 'Nothing is on this load'; end if;
  -- the METRC checklist
  select string_agg(distinct 'stop ' || x.seq || ' (' || x.from_license || ')', ', ') into bad
    from (select st.seq, st.id, k.from_license, (c.kind = 'internal' and upper(c.name) in ('OHR', 'GVR')) as internal
            from load_stops st join customers c on c.id = st.customer_id
            cross join lateral (select distinct from_license from metrc_stop_packages(st.id)) k
           where st.load_id = l.id and st.status = 'pending') x
   where metrc_stop_kind_on(x.internal)
     and not exists (select 1 from metrc_stop_checks ck where ck.stop_id = x.id and ck.license = x.from_license and ck.ok and ck.checked_at > now() - interval '60 minutes');
  if bad is not null then raise exception 'The METRC checklist isn''t green for %. Run the check on each stop (and fix what it shows) before Depart.', bad; end if;

  update loads set status = 'in_transit', departed_at = now() where id = l.id;
  insert into events (user_email, type, load_id, details) values (current_email(), 'load_departed', l.id, jsonb_build_object('load', l.code));
  -- one METRC transfer per stop and shipping license
  for s in select st.id, st.seq, c.name as customer, (c.kind = 'internal' and upper(c.name) in ('OHR', 'GVR')) as internal,
                  case when c.kind = 'internal' and upper(c.name) in ('OHR', 'GVR') then upper(c.name) end as to_site, c.license as cust_license,
                  k.from_license, k.from_site, k.tags, k.lbs, k.n
             from load_stops st join customers c on c.id = st.customer_id
             cross join lateral (select from_license, min(from_site) as from_site, array_agg(tag) filter (where tag is not null) as tags,
                                        sum(lbs) as lbs, count(*) as n from metrc_stop_packages(st.id) group by from_license) k
            where st.load_id = l.id and st.status = 'pending' order by st.seq loop
    insert into events (user_email, type, load_id, lbs, details)
    values (current_email(), 'stop_departed', l.id, s.lbs,
            jsonb_build_object('stop_id', s.id, 'seq', s.seq, 'load', l.code, 'customer', s.customer, 'internal', s.internal,
                               'from_site', s.from_site, 'from_license', s.from_license, 'to_site', s.to_site,
                               'to_license', coalesce(site_license(s.to_site), s.cust_license), 'tags', to_jsonb(coalesce(s.tags, '{}')), 'packages', s.n));
  end loop;
end $$;
revoke all on function depart_load(int) from public, anon;
grant execute on function depart_load(int) to authenticated;

-- =====================================================================================================
-- 6. to-dos for the new event types (stops, nursery, plantings); the older ones stay in _comp_queue_event
-- =====================================================================================================
create or replace function metrc_touch_tags(a comp_metrc_actions) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct upper(t)) filter (where nullif(trim(t), '') is not null), '{}') from (
    select a.tag as t
    union all select p.package_tag from pallets p where a.details ->> 'type' = 'split_from' and p.id = nullif(a.details ->> 'parent_id', '')::bigint
    union all select p.package_tag from pallets p where a.details ->> 'type' = 'merge' and p.merged_into = a.pallet_id
    union all select p.package_tag from pallets p where a.details ->> 'type' = 'tag_set' and a.details ->> 'from' is not null and p.id = a.pallet_id
    union all select a.details ->> 'from' where a.details ->> 'type' = 'tag_set'
    union all select a.details ->> 'old_tag' where a.details ->> 'type' = 'proc_received'
    union all select jsonb_array_elements_text(case when jsonb_typeof(a.details -> 'tags') = 'array' then a.details -> 'tags' else '[]'::jsonb end)
  ) x
$$;

create or replace function _metrc_queue_more() returns trigger
language plpgsql security definer set search_path = public as $$
declare a text; lic text; s text; d jsonb := new.details;
begin
  if new.type not in ('stop_departed', 'nursery_shipped', 'nursery_cut', 'nursery_mother_lot', 'nursery_loss', 'planting_made', 'planting_loss', 'planting_flip') then return new; end if;
  a := case new.type
    when 'stop_departed' then case when coalesce((d ->> 'internal')::boolean, false)
                                   then 'Transfer ' || coalesce(d ->> 'from_site', '?') || ' > ' || coalesce(d ->> 'to_site', '?') || ' (METRC transfer)'
                                   else 'Manifest to ' || coalesce(d ->> 'customer', '?') end
    when 'nursery_shipped' then 'Nursery clones out to ' || coalesce(d ->> 'to', '?') || ' (METRC transfer)'
    when 'nursery_cut' then 'Clone package from mother lot'
    when 'nursery_mother_lot' then 'Mother lot from clone package'
    when 'nursery_loss' then case when d ->> 'what' = 'mothers' then 'Destroy lost mothers' else 'Adjust clone package (lost clones)' end
    when 'planting_made' then 'Planting: plant batch from clone package'
    when 'planting_loss' then 'Destroy lost plants (planting)'
    when 'planting_flip' then 'Flip to flowering (plant tags)' end;
  lic := case
    when new.type = 'stop_departed' then d ->> 'from_license'
    when new.type like 'nursery%' then (select license from nursery_sites where code = d ->> 'site')
    else comp_site_cult_license(d ->> 'site') end;
  s := concat_ws(' · ', d ->> 'load', case when new.type = 'stop_departed' then 'stop ' || (d ->> 'seq') || ', ' || (d ->> 'packages') || ' packages' end,
                 d ->> 'strain', d ->> 'field', d ->> 'room',
                 case when new.type = 'nursery_cut' then (d ->> 'cuttings') || ' cuttings' end,
                 case when new.type = 'nursery_shipped' then (d ->> 'plants') || ' plants' end,
                 case when new.type = 'nursery_mother_lot' then (d ->> 'qty') || ' mothers' end,
                 case when new.type = 'nursery_loss' then (d ->> 'lost') || ' lost' end,
                 case when new.type = 'planting_made' then (d ->> 'plants') || ' plants' end,
                 case when new.type = 'planting_loss' then (d ->> 'lost') || ' lost' end,
                 case when new.type = 'planting_flip' then (d ->> 'plants') || ' plants' end);
  insert into comp_metrc_actions (event_id, at, license, action, pallet_id, code, tag, lbs, summary, details, due_at)
  values (new.id, new.at, lic, a, null, null, nullif(d ->> 'tag', ''), new.lbs, nullif(s, ''),
          jsonb_strip_nulls(d || jsonb_build_object('type', new.type, 'by', new.user_email, 'note', new.note)), null)
  on conflict (event_id) do nothing;
  return new;
exception when others then return new;   -- never block the real action
end $$;
drop trigger if exists metrc_queue_more on events;
create trigger metrc_queue_more after insert on events for each row execute function _metrc_queue_more();

-- ---------- nursery: cutting events, mother lots, losses ----------
create or replace function _metrc_nursery_batch() returns trigger
language plpgsql security definer set search_path = public as $$
declare m nursery_mothers;
begin
  if new.mother_id is not null then select * into m from nursery_mothers where id = new.mother_id; end if;
  if coalesce(new.cuttings, 0) > 0 and (tg_op = 'INSERT' or coalesce(old.cuttings, 0) = 0) then
    insert into events (user_email, type, note, details)
    values (current_email(), 'nursery_cut', new.strain,
            jsonb_strip_nulls(jsonb_build_object('batch_id', new.id, 'site', new.site, 'strain', new.strain, 'cuttings', new.cuttings, 'cut_on', new.cut_on,
                               'mother_id', new.mother_id, 'mother_tag', m.plant_tag, 'tag', new.tags[1], 'gen', new.gen, 'name', new.name)));
  elsif tg_op = 'UPDATE' and coalesce(new.lost, 0) > coalesce(old.lost, 0) and coalesce(old.cuttings, 0) > 0 then
    insert into events (user_email, type, note, details)
    values (current_email(), 'nursery_loss', new.strain,
            jsonb_strip_nulls(jsonb_build_object('what', 'clones', 'batch_id', new.id, 'site', new.site, 'strain', new.strain,
                               'lost', new.lost - coalesce(old.lost, 0), 'tag', new.tags[1], 'name', new.name)));
  end if;
  return new;
exception when others then return new;
end $$;
drop trigger if exists metrc_nursery_batch on nursery_batches;
create trigger metrc_nursery_batch after insert or update of cuttings, lost on nursery_batches for each row execute function _metrc_nursery_batch();

create or replace function _metrc_nursery_mother() returns trigger
language plpgsql security definer set search_path = public as $$
declare b nursery_batches;
begin
  if tg_op = 'INSERT' and new.batch_id is not null and coalesce(new.qty, 0) > 0 then
    select * into b from nursery_batches where id = new.batch_id;
    insert into events (user_email, type, note, details)
    values (current_email(), 'nursery_mother_lot', new.strain,
            jsonb_strip_nulls(jsonb_build_object('mother_id', new.id, 'batch_id', new.batch_id, 'site', new.site, 'strain', new.strain, 'qty', new.qty,
                               'lot_tag', new.plant_tag, 'source_tag', b.tags[1], 'room_id', new.room_id, 'room', (select name from nursery_rooms where id = new.room_id),
                               'on', new.started_on)));
  elsif tg_op = 'UPDATE' and coalesce(new.lost, 0) > coalesce(old.lost, 0) then
    insert into events (user_email, type, note, details)
    values (current_email(), 'nursery_loss', new.strain,
            jsonb_strip_nulls(jsonb_build_object('what', 'mothers', 'mother_id', new.id, 'site', new.site, 'strain', new.strain,
                               'lost', new.lost - coalesce(old.lost, 0), 'lot_tag', new.plant_tag)));
  end if;
  return new;
exception when others then return new;
end $$;
drop trigger if exists metrc_nursery_mother on nursery_mothers;
create trigger metrc_nursery_mother after insert or update of lost on nursery_mothers for each row execute function _metrc_nursery_mother();

-- ---------- nursery deliveries: the clone packages go out on a METRC transfer ----------
create or replace function _metrc_nursery_shipped() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select x.ref, min(x.order_id) as order_id, sum(x.plants) as plants, min(x.manifest) as manifest, min(x.delivered_on) as delivered_on,
                  array_agg(distinct x.batch_id) filter (where x.batch_id is not null) as batches,
                  jsonb_object_agg(coalesce(x.batch_id, 0)::text, x.plants) as per_batch
             from nd x group by x.ref loop
    insert into events (user_email, type, note, details)
    select current_email(), 'nursery_shipped', o.strain,
           jsonb_strip_nulls(jsonb_build_object('ref', r.ref, 'order_id', o.id, 'site', o.nursery_site, 'to_site', o.site, 'strain', o.strain, 'plants', r.plants,
             'to', coalesce(o.site, c.name), 'to_license', coalesce(comp_site_cult_license(o.site), c.license), 'manifest', r.manifest, 'on', r.delivered_on,
             'per_batch', r.per_batch,
             'tags', (select coalesce(jsonb_agg(upper(b.tags[1])) filter (where b.tags[1] is not null), '[]'::jsonb) from nursery_batches b where b.id = any(r.batches))))
      from cult_nursery_orders o left join customers c on c.id = o.customer_id where o.id = r.order_id;
  end loop;
  return null;
exception when others then return null;
end $$;
drop trigger if exists metrc_nursery_shipped on nursery_deliveries;
create trigger metrc_nursery_shipped after insert on nursery_deliveries referencing new table as nd for each statement execute function _metrc_nursery_shipped();

-- ---------- farm plantings: planted, losses, the flip ----------
alter table cult_plantings add column if not exists flipped_on date;
alter table cult_plantings add column if not exists flipped_by text;

create or replace function _metrc_planting() returns trigger
language plpgsql security definer set search_path = public as $$
declare f text := (select name from fields where id = new.field_id);
begin
  if tg_op = 'INSERT' and coalesce(new.plants, 0) > 0 then
    insert into events (user_email, type, note, details)
    values (current_email(), 'planting_made', new.strain,
            jsonb_strip_nulls(jsonb_build_object('planting_id', new.id, 'site', new.site, 'field_id', new.field_id, 'field', f, 'strain', new.strain,
                               'plants', new.plants, 'planted_on', new.planted_on, 'source', new.source, 'nursery', new.nursery, 'crop_year', new.crop_year)));
  elsif tg_op = 'UPDATE' and coalesce(new.plant_loss, 0) > coalesce(old.plant_loss, 0) then
    insert into events (user_email, type, note, details)
    values (current_email(), 'planting_loss', new.strain,
            jsonb_strip_nulls(jsonb_build_object('planting_id', new.id, 'site', new.site, 'field_id', new.field_id, 'field', f, 'strain', new.strain,
                               'lost', new.plant_loss - coalesce(old.plant_loss, 0))));
  end if;
  return new;
exception when others then return new;
end $$;
drop trigger if exists metrc_planting on cult_plantings;
create trigger metrc_planting after insert or update of plant_loss on cult_plantings for each row execute function _metrc_planting();

create or replace function cult_flip(p_planting bigint, p_on date default null) returns cult_plantings
language plpgsql security definer set search_path = public as $$
declare pl cult_plantings; n int;
begin
  perform require_module('cultivation'); perform no_view_as();
  if not can_edit('cultivation') then raise exception 'You can''t change plantings'; end if;
  select * into pl from cult_plantings where id = p_planting for update;
  if pl.id is null then raise exception 'Planting not found'; end if;
  if pl.flipped_on is not null then raise exception 'Already flipped to flowering on %', pl.flipped_on; end if;
  n := coalesce(pl.plants, 0) - coalesce(pl.plant_loss, 0);
  if n <= 0 then raise exception 'No plants left in this planting'; end if;
  update cult_plantings set flipped_on = coalesce(p_on, current_date), flipped_by = current_email(), updated_by = current_email(), updated_at = now()
   where id = pl.id returning * into pl;
  insert into events (user_email, type, note, details)
  values (current_email(), 'planting_flip', pl.strain,
          jsonb_strip_nulls(jsonb_build_object('planting_id', pl.id, 'site', pl.site, 'field_id', pl.field_id, 'field', (select name from fields where id = pl.field_id),
                             'strain', pl.strain, 'plants', n, 'on', pl.flipped_on)));
  return pl;
end $$;
revoke all on function cult_flip(bigint, date) from public, anon;
grant execute on function cult_flip(bigint, date) to authenticated;

-- =====================================================================================================
-- 7. Phase 2 pull: METRC locations, strains, plant batches, plant counts, harvests (written by the server)
-- =====================================================================================================
create table if not exists metrc_locations (
  license text not null, id bigint not null, name text not null, type_name text,
  for_plants boolean, for_plant_batches boolean, for_harvests boolean, for_packages boolean, archived boolean not null default false,
  seen_at timestamptz not null default now(), primary key (license, id));
create table if not exists metrc_strains (
  license text not null, id bigint not null, name text not null, archived boolean not null default false,
  seen_at timestamptz not null default now(), primary key (license, id));
create table if not exists metrc_plant_batches (
  license text not null, id bigint not null, name text, type text, strain text, strain_id bigint, location_id bigint, location text,
  untracked int, tracked int, packaged int, destroyed int, planted_on date, source_package text, source_plant text,
  state text not null default 'active', last_modified timestamptz, seen_at timestamptz not null default now(), primary key (license, id));
create index if not exists metrc_plant_batches_name on metrc_plant_batches (upper(name));
create table if not exists metrc_plant_counts (
  license text not null, phase text not null, location_id bigint not null default 0, location text, strain text not null default '',
  plants int not null default 0, oldest date, newest date, run text, seen_at timestamptz not null default now(),
  primary key (license, phase, location_id, strain, run));
create table if not exists metrc_harvests (
  license text not null, id bigint not null, name text not null, strains text, location text, plant_count int,
  wet numeric, current numeric, waste numeric, packaged numeric, uom text, started date, finished boolean, finished_on date,
  state text not null default 'active', last_modified timestamptz, seen_at timestamptz not null default now(), primary key (license, id));
create index if not exists metrc_harvests_name on metrc_harvests (upper(name));

do $$ declare t text; begin
  foreach t in array array['metrc_locations', 'metrc_strains', 'metrc_plant_batches', 'metrc_plant_counts', 'metrc_harvests'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists read_%s on %I', t, t);
    execute format('create policy read_%s on %I for select to authenticated using (is_staff())', t, t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;

-- plant counts are summed page by page into a run, then the run replaces the last one
create or replace function metrc_plant_counts_add(p_license text, p_phase text, p_run text, p_rows jsonb) returns void
language sql security definer set search_path = public as $$
  insert into metrc_plant_counts (license, phase, location_id, location, strain, plants, oldest, newest, run, seen_at)
  select p_license, p_phase, coalesce((r ->> 'location_id')::bigint, 0), r ->> 'location', coalesce(r ->> 'strain', ''), (r ->> 'plants')::int,
         nullif(r ->> 'oldest', '')::date, nullif(r ->> 'newest', '')::date, p_run, now()
    from jsonb_array_elements(p_rows) r
  on conflict (license, phase, location_id, strain, run) do update
    set plants = metrc_plant_counts.plants + excluded.plants,
        oldest = least(metrc_plant_counts.oldest, excluded.oldest), newest = greatest(metrc_plant_counts.newest, excluded.newest), seen_at = now()
$$;
create or replace function metrc_plant_counts_swap(p_license text, p_phase text, p_run text) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from metrc_plant_counts where license = p_license and phase = p_phase and run <> p_run and run <> 'live';
  delete from metrc_plant_counts where license = p_license and phase = p_phase and run = 'live';
  update metrc_plant_counts set run = 'live' where license = p_license and phase = p_phase and run = p_run;
end $$;
revoke all on function metrc_plant_counts_add(text, text, text, jsonb), metrc_plant_counts_swap(text, text, text) from public, anon, authenticated;
grant execute on function metrc_plant_counts_add(text, text, text, jsonb), metrc_plant_counts_swap(text, text, text) to service_role;

-- ---------- mapping: app fields / nursery rooms / drying rooms -> METRC locations; app strains -> METRC strains ----------
create table if not exists metrc_location_map (
  app_kind    text not null check (app_kind in ('field', 'room', 'drying', 'packages')),   -- drying / packages: app_ref = site code
  app_ref     text not null,
  license     text not null,
  location_id bigint not null,
  location    text,
  updated_by  text, updated_at timestamptz not null default now(),
  primary key (app_kind, app_ref, license));
create table if not exists metrc_strain_map (
  app_strain  text not null,
  license     text not null,
  strain_id   bigint not null,
  strain      text,
  updated_by  text, updated_at timestamptz not null default now(),
  primary key (app_strain, license));
do $$ declare t text; begin
  foreach t in array array['metrc_location_map', 'metrc_strain_map'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists read_%s on %I', t, t);
    execute format('create policy read_%s on %I for select to authenticated using (is_staff())', t, t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;

create or replace function metrc_map_location(p_kind text, p_ref text, p_license text, p_location_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare nm text;
begin
  if not comp_is_admin() then raise exception 'Only a Compliance Admin can change METRC mapping'; end if;
  if p_location_id is null then
    delete from metrc_location_map where app_kind = p_kind and app_ref = p_ref and license = p_license;
  else
    select name into nm from metrc_locations where license = p_license and id = p_location_id;
    if nm is null then raise exception 'That METRC location isn''t on %. Pull from METRC first.', p_license; end if;
    insert into metrc_location_map (app_kind, app_ref, license, location_id, location, updated_by)
    values (p_kind, p_ref, p_license, p_location_id, nm, current_email())
    on conflict (app_kind, app_ref, license) do update set location_id = excluded.location_id, location = excluded.location, updated_by = excluded.updated_by, updated_at = now();
  end if;
  perform _comp_event('metrc_map', p_kind || ':' || p_ref, jsonb_build_object('kind', p_kind, 'ref', p_ref, 'license', p_license, 'location', nm));
end $$;
create or replace function metrc_map_strain(p_strain text, p_license text, p_strain_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare nm text;
begin
  if not comp_is_admin() then raise exception 'Only a Compliance Admin can change METRC mapping'; end if;
  if p_strain_id is null then
    delete from metrc_strain_map where app_strain = p_strain and license = p_license;
  else
    select name into nm from metrc_strains where license = p_license and id = p_strain_id;
    if nm is null then raise exception 'That METRC strain isn''t on %. Pull from METRC first.', p_license; end if;
    insert into metrc_strain_map (app_strain, license, strain_id, strain, updated_by) values (p_strain, p_license, p_strain_id, nm, current_email())
    on conflict (app_strain, license) do update set strain_id = excluded.strain_id, strain = excluded.strain, updated_by = excluded.updated_by, updated_at = now();
  end if;
  perform _comp_event('metrc_map', 'strain:' || p_strain, jsonb_build_object('strain', p_strain, 'license', p_license, 'metrc', nm));
end $$;
revoke all on function metrc_map_location(text, text, text, bigint), metrc_map_strain(text, text, bigint) from public, anon;
grant execute on function metrc_map_location(text, text, text, bigint), metrc_map_strain(text, text, bigint) to authenticated;

-- the METRCtrain for an app strain on a license: the mapping, else the same name (or one of the strain aliases)
create or replace function metrc_strain_for(p_strain text, p_license text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object('id', strain_id, 'name', strain, 'how', 'mapped') from metrc_strain_map where lower(app_strain) = lower(trim(p_strain)) and license = p_license),
    (select jsonb_build_object('id', m.id, 'name', m.name, 'how', 'same name') from metrc_strains m
      where m.license = p_license and not m.archived
        and (lower(m.name) = lower(trim(p_strain))
             or lower(m.name) in (select lower(a) from strains s, unnest(coalesce(s.aliases, '{}') || s.name) a where s.id = strain_id_of(p_strain)))
      order by (lower(m.name) = lower(trim(p_strain))) desc, m.id limit 1))
$$;
revoke all on function metrc_strain_for(text, text) from public, anon;
grant execute on function metrc_strain_for(text, text) to authenticated, service_role;

-- the METRC plant batches the app made for each farm planting (the flip and losses use them)
create table if not exists metrc_planting_batches (
  id             bigserial primary key,
  planting_id    bigint not null,
  license        text not null,
  batch_name     text not null,
  plants         int not null,
  source_package text,
  created_at     timestamptz not null default now(),
  unique (license, batch_name));
alter table metrc_planting_batches enable row level security;
drop policy if exists read_metrc_planting_batches on metrc_planting_batches;
create policy read_metrc_planting_batches on metrc_planting_batches for select to authenticated using (is_staff());
grant select on metrc_planting_batches to authenticated;
grant all on metrc_planting_batches to service_role;
grant usage on sequence metrc_planting_batches_id_seq to service_role;

-- =====================================================================================================
-- 8. receiving into the app (Distribution > Inbound), called by the server after METRC took the delivery
-- =====================================================================================================
-- p_rows: [{ tag, lbs, item, strain, uom }]. Packages already in the app come back into inventory at the site (Needs a spot);
-- new ones are added (Needs a spot, flagged to check strain and product). Plant packages (counted, not weighed) are not pallets.
create or replace function inbound_apply(p_site text, p_license text, p_manifest text, p_from text, p_rows jsonb, p_by text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; p pallets; tg text; code_ text; i int; res jsonb := '[]'; lbs numeric; it text; n_in int := 0; n_new int := 0; n_skip int := 0;
begin
  if upper(coalesce(p_site, '')) not in ('OHR', 'GVR') then
    return jsonb_build_object('in', 0, 'new', 0, 'skipped', jsonb_array_length(coalesce(p_rows, '[]')), 'rows', '[]'::jsonb, 'note', 'Not a freezer site');
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]')) loop
    tg := upper(trim(r ->> 'tag')); lbs := nullif(r ->> 'lbs', '')::numeric; it := r ->> 'item';
    if tg is null or tg = '' then continue; end if;
    if lbs is null then n_skip := n_skip + 1; res := res || jsonb_build_object('tag', tg, 'msg', 'Not weighed in lbs (plant package): METRC only'); continue; end if;
    select * into p from pallets where upper(package_tag) = tg order by (status in ('in_transit', 'at_processor', 'shipped')) desc, updated_at desc limit 1;
    if p.id is not null and p.status in ('in_freezer', 'unslotted') and coalesce(p.received_site, pallet_site(p)) = upper(p_site) then
      n_skip := n_skip + 1; res := res || jsonb_build_object('tag', tg, 'code', p.code, 'msg', 'Already in inventory here');
    elsif p.id is not null then
      update pallets set status = 'unslotted', slot_id = null, received_site = upper(p_site), current_weight = lbs, merged_into = null,
             product = case when product = 'wet' and status = 'at_processor' then 'unbucked' else product end, updated_at = now()
       where id = p.id;
      insert into events (user_email, type, pallet_id, lbs, details)
      values (coalesce(p_by, 'metrc'), 'inbound_received', p.id, lbs,
              jsonb_build_object('tag', tg, 'site', upper(p_site), 'license', p_license, 'manifest', p_manifest, 'from', p_from, 'was', p.status, 'was_lbs', p.current_weight));
      n_in := n_in + 1; res := res || jsonb_build_object('tag', tg, 'code', p.code, 'msg', 'Back in inventory (Needs a spot)');
    else
      code_ := (case when upper(p_site) = 'GVR' then 'G' else 'P' end) || right(tg, 4); i := 1;
      while exists (select 1 from pallets where code = code_) loop code_ := (case when upper(p_site) = 'GVR' then 'G' else 'P' end) || right(tg, 4) || '-R' || i; i := i + 1; end loop;
      insert into pallets (code, strain, current_weight, og_weight, package_tag, status, received_site, product, needs_review, notes, pushed)
      values (code_, coalesce(nullif(trim(r ->> 'strain'), ''), nullif(trim(split_part(coalesce(it, ''), ' - ', 2)), '')), lbs, lbs, tg, 'unslotted', upper(p_site),
              case when it ~* 'standard' then 'standards' when it ~* 'small' then 'smalls' when it ~* 'trim' then 'trim' when it ~* 'unbucked' then 'unbucked'
                   when it ~* 'bucked' then 'bucked' when it ~* '(wet|dry harvest)' then 'wet' else 'fresh_frozen' end,
              'Received from METRC: check strain and product', concat_ws('. ', 'METRC item: ' || coalesce(it, '?'), 'Manifest ' || p_manifest, 'From ' || p_from), true)
      returning * into p;
      insert into events (user_email, type, pallet_id, lbs, details)
      values (coalesce(p_by, 'metrc'), 'inbound_received', p.id, lbs,
              jsonb_build_object('tag', tg, 'site', upper(p_site), 'license', p_license, 'manifest', p_manifest, 'from', p_from, 'new', true, 'item', it));
      n_new := n_new + 1; res := res || jsonb_build_object('tag', tg, 'code', p.code, 'msg', 'Added (Needs a spot; check strain and product)');
    end if;
    p := null;
  end loop;
  return jsonb_build_object('in', n_in, 'new', n_new, 'skipped', n_skip, 'rows', res);
end $$;
revoke all on function inbound_apply(text, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function inbound_apply(text, text, text, text, jsonb, text) to service_role;

-- =====================================================================================================
-- 9. auto-close what METRC already shows (nightly pull), now with the new kinds
-- =====================================================================================================
create or replace function metrc_autoclose() returns integer
language plpgsql security definer set search_path = public as $$
declare n int := 0; k int;
begin
  update comp_metrc_actions a set status = 'done', done_by = 'METRC sync (already in METRC)', done_at = now(),
         note = coalesce(a.note, 'Tag is in METRC')
   where a.status in ('todo', 'error') and coalesce(a.push_state, '') <> 'sending'
     and a.kind in ('harvest_package', 'new_package', 'split', 'combine', 'proc_output', 'tag')
     and a.tag is not null and exists (select 1 from metrc_packages m where m.label = upper(a.tag));
  get diagnostics k = row_count; n := n + k;
  update comp_metrc_actions a set status = 'done', done_by = 'METRC sync (already in METRC)', done_at = now(),
         note = coalesce(a.note, 'METRC weight matches the app')
    from pallets p, metrc_packages m
   where a.status in ('todo', 'error') and coalesce(a.push_state, '') <> 'sending' and a.kind = 'adjust' and p.id = a.pallet_id and m.label = upper(p.package_tag)
     and m.state in ('active', 'intransit') and m.lbs is not null and abs(m.lbs - p.current_weight) < 0.01
     and not exists (select 1 from comp_metrc_actions b where b.touch_tags && a.touch_tags and b.status in ('todo', 'error') and b.id > a.id);
  get diagnostics k = row_count; n := n + k;
  update comp_metrc_actions a set status = 'done', done_by = 'METRC sync (already in METRC)', done_at = now(),
         note = coalesce(a.note, 'Finished in METRC')
   where a.status in ('todo', 'error') and coalesce(a.push_state, '') <> 'sending' and a.kind = 'finish' and a.tag is not null
     and exists (select 1 from metrc_packages m where m.label = upper(a.tag) and m.state in ('inactive', 'transferred'));
  get diagnostics k = row_count; n := n + k;
  -- one package left on a manifest (per-package to-dos: ship checks, processor sends, older transfer / manifest rows)
  update comp_metrc_actions a set status = 'done', done_by = 'METRC sync (already in METRC)', done_at = now(),
         note = coalesce(a.note, 'On manifest ' || (select t.manifest from metrc_transfer_packages tp join metrc_transfers t on t.delivery_id = tp.delivery_id
                                                     where tp.label = upper(a.tag) and not t.voided order by t.created_at desc nulls last limit 1))
   where a.status in ('todo', 'error') and coalesce(a.push_state, '') <> 'sending' and a.kind in ('transfer', 'manifest', 'ship_check') and a.tag is not null
     and exists (select 1 from metrc_transfer_packages tp join metrc_transfers t on t.delivery_id = tp.delivery_id
                  where tp.label = upper(a.tag) and not t.voided and coalesce(t.created_at, t.departed_at, now()) >= a.at - interval '2 days');
  get diagnostics k = row_count; n := n + k;
  -- a stop transfer: every package on it is on a METRC manifest made since the to-do
  update comp_metrc_actions a set status = 'done', done_by = 'METRC sync (already in METRC)', done_at = now(),
         note = coalesce(a.note, 'On a METRC manifest')
   where a.status in ('todo', 'error') and coalesce(a.push_state, '') <> 'sending' and a.kind in ('transfer', 'manifest') and a.tag is null
     and a.details ->> 'type' = 'stop_departed' and jsonb_array_length(coalesce(a.details -> 'tags', '[]')) > 0
     and not exists (select 1 from jsonb_array_elements_text(a.details -> 'tags') x
                      where not exists (select 1 from metrc_transfer_packages tp join metrc_transfers t on t.delivery_id = tp.delivery_id
                                         where tp.label = upper(x) and not t.voided and coalesce(t.created_at, t.departed_at, now()) >= a.at - interval '2 days'));
  get diagnostics k = row_count; n := n + k;
  -- harvest steps METRC already shows
  update comp_metrc_actions a set status = 'done', done_by = 'METRC sync (already in METRC)', done_at = now(), note = coalesce(a.note, 'Harvest finished in METRC')
   where a.status in ('todo', 'error') and coalesce(a.push_state, '') <> 'sending' and a.kind = 'harvest_finish'
     and exists (select 1 from metrc_harvests h where upper(h.name) = upper(a.details ->> 'batch') and h.license = a.license and h.finished);
  get diagnostics k = row_count; n := n + k;
  if n > 0 then
    insert into events (user_email, type, note, details) values ('metrc sync', 'metrc_autoclose', n || ' to-dos already in METRC', jsonb_build_object('n', n));
  end if;
  return n;
end $$;

select '075 metrc phase 1 + 2' as ok, (select count(*) from metrc_push_kinds where ready) as kinds_ready,
       (select count(*) from comp_metrc_actions where status in ('todo', 'error')) as open_todos;
