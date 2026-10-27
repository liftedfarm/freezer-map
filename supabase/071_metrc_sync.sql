-- 071_metrc_sync.sql: pull METRC through T3 (packages, transfers, manifests) and reconcile against the app.
--   metrc_packages            every package METRC has for our licenses (active, on hold, in transit, inactive, transferred)
--   metrc_transfers           outgoing transfers, one row per delivery (manifest, recipient, driver, dates)
--   metrc_transfer_packages   packages on each delivery
--   comp_reconcile_live()     the Reconcile checks against the latest pull, with the trail that explains each gap
--   metrc_autoclose()         closes to-dos METRC already shows (harvest packages entered by hand, etc.)
-- Written by the server (service role) only; Compliance reads. Re-runnable. Run after 070.

create table if not exists metrc_packages (
  license        text not null,
  label          text not null,
  metrc_id       bigint,
  state          text not null,                 -- active / intransit / inactive / transferred / gone (was active, not in the latest full pull)
  item           text,
  category       text,
  qty            numeric,
  uom            text,
  lbs            numeric,
  location       text,
  source_labels  text[] not null default '{}',
  source_harvests text,
  packaged_on    date,
  finished_on    date,
  last_modified  timestamptz,
  on_hold        boolean not null default false,
  lab_state      text,
  received_manifest text,
  received_from  text,
  seen_at        timestamptz not null default now(),
  primary key (license, label)
);
create index if not exists metrc_packages_label on metrc_packages (label);
create index if not exists metrc_packages_sources on metrc_packages using gin (source_labels);

create table if not exists metrc_transfers (
  delivery_id     bigint primary key,
  transfer_id     bigint,
  license         text not null,                -- shipper
  manifest        text,
  recipient_license text,
  recipient_name  text,
  shipment_type   text,
  created_at      timestamptz,
  departed_at     timestamptz,
  arrived_at      timestamptz,
  received_at     timestamptz,
  voided          boolean not null default false,
  driver          text,
  vehicle         text,
  package_count   int,
  last_modified   timestamptz,
  packages_loaded boolean not null default false,
  seen_at         timestamptz not null default now()
);
create index if not exists metrc_transfers_manifest on metrc_transfers (manifest);

create table if not exists metrc_transfer_packages (
  delivery_id    bigint not null references metrc_transfers(delivery_id) on delete cascade,
  label          text not null,
  manifest       text,
  item           text,
  shipped_lbs    numeric,
  received_lbs   numeric,
  uom            text,
  state          text,
  source_labels  text[] not null default '{}',
  primary key (delivery_id, label)
);
create index if not exists metrc_transfer_packages_label on metrc_transfer_packages (label);

create table if not exists metrc_sync_runs (
  id           bigserial primary key,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  started_by   text,
  license      text,
  counts       jsonb not null default '{}',
  complete     boolean not null default false,  -- every step finished for this license
  error        text
);
create table if not exists metrc_sync_state (
  license     text not null,
  step        text not null,
  cursor      text,                -- e.g. lastModified to pull from next time
  updated_at  timestamptz not null default now(),
  primary key (license, step)
);

do $$ declare t text; begin
  foreach t in array array['metrc_packages','metrc_transfers','metrc_transfer_packages','metrc_sync_runs','metrc_sync_state'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists read_%s on %I', t, t);
    execute format('create policy read_%s on %I for select to authenticated using (comp_can_read())', t, t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;
grant usage, select on sequence metrc_sync_runs_id_seq to service_role;

-- ---------- the trail behind one tag: what METRC did with it ----------
/** packages made from this tag (any license) and the manifests this tag or those went out on */
create or replace function metrc_trail(p_tag text) returns jsonb
language sql stable security definer set search_path = public as $$
  with kids as (
    select k.label, k.license, k.state, k.lbs, k.packaged_on, k.item from metrc_packages k
     where upper(p_tag) = any(k.source_labels) and k.label <> upper(p_tag)
  ), ships as (
    select tp.label, tp.shipped_lbs, t.manifest, t.recipient_name, t.recipient_license, coalesce(t.departed_at, t.created_at) as shipped_at, t.voided
      from metrc_transfer_packages tp join metrc_transfers t on t.delivery_id = tp.delivery_id
     where (tp.label = upper(p_tag) or tp.label in (select label from kids)) and not t.voided
  )
  select jsonb_build_object(
    'kids', coalesce((select jsonb_agg(jsonb_build_object('tag', k.label, 'license', k.license, 'state', k.state, 'lbs', k.lbs, 'packaged_on', k.packaged_on,
              'ship', (select jsonb_build_object('manifest', s.manifest, 'to', s.recipient_name, 'to_license', s.recipient_license, 'lbs', s.shipped_lbs, 'on', s.shipped_at::date)
                         from ships s where s.label = k.label order by s.shipped_at desc limit 1)) order by k.packaged_on, k.label) from kids k), '[]'),
    'ship', (select jsonb_build_object('manifest', s.manifest, 'to', s.recipient_name, 'to_license', s.recipient_license, 'lbs', s.shipped_lbs, 'on', s.shipped_at::date)
               from ships s where s.label = upper(p_tag) order by s.shipped_at desc limit 1),
    'self', (select jsonb_build_object('license', m.license, 'state', m.state, 'lbs', m.lbs, 'finished_on', m.finished_on, 'last_modified', m.last_modified, 'location', m.location)
               from metrc_packages m where m.label = upper(p_tag)
              order by (m.state in ('active', 'intransit')) desc, m.last_modified desc nulls last limit 1))
$$;

/** one line a person can read: "400 lb split to …5521 on 10/14, shipped on 0011702377 to Bear Labs 10/16" */
create or replace function metrc_trail_text(p jsonb) returns text
language sql immutable as $$
  select nullif(concat_ws('; ',
    case when p -> 'ship' is not null and p -> 'ship' <> 'null'::jsonb then
      'Shipped whole on ' || (p -> 'ship' ->> 'manifest') || ' to ' || coalesce(p -> 'ship' ->> 'to', '?') || ' ' || to_char((p -> 'ship' ->> 'on')::date, 'MM/DD') end,
    (select string_agg(
        coalesce(round((k ->> 'lbs')::numeric, 2)::text || ' lb', '?') || ' to …' || right(k ->> 'tag', 6)
        || coalesce(' ' || to_char((k ->> 'packaged_on')::date, 'MM/DD'), '')
        || case when k -> 'ship' is not null and k -> 'ship' <> 'null'::jsonb
                then ', shipped ' || (k -> 'ship' ->> 'manifest') || ' to ' || coalesce(k -> 'ship' ->> 'to', '?') || ' ' || to_char((k -> 'ship' ->> 'on')::date, 'MM/DD')
                else ' (' || (k ->> 'state') || ')' end, '; ')
       from jsonb_array_elements(coalesce(p -> 'kids', '[]')) k),
    case when p -> 'self' ->> 'state' in ('inactive', 'gone') then 'Finished in METRC' || coalesce(' ' || to_char((p -> 'self' ->> 'finished_on')::date, 'MM/DD'), '') end
  ), '')
$$;

-- ---------- Reconcile against the latest pull ----------
create or replace function comp_reconcile_live(p_license text) returns table (
  issue text, tag text, pallet_id bigint, code text, strain text, app_lbs numeric, metrc_lbs numeric, app_item text, metrc_item text,
  app_license text, metrc_location text, app_spot text, metrc_changed timestamptz, explain text, trail jsonb, note text)
language plpgsql stable security definer set search_path = public as $$
declare tol numeric; stale int;
begin
  if not comp_can_read() then raise exception 'Not allowed'; end if;
  tol := coalesce((select nullif(value, '')::numeric from app_settings where key = 'comp.weight_tol'), 1);
  stale := coalesce((select nullif(value, '')::int from app_settings where key = 'comp.stale_days'), 90);
  return query
  with live as (
    select p.*, comp_pallet_license(p.id) as lic from pallets p
     where p.status in ('in_freezer','unslotted') and coalesce(p.kind, '') <> 'mixed'
  ), m as (select * from metrc_packages x where x.license = p_license and x.state in ('active', 'intransit')),
  bytag as (select distinct on (upper(p.package_tag)) p.* from pallets p join m on upper(p.package_tag) = m.label
             order by upper(p.package_tag), (p.status in ('in_freezer','unslotted')) desc, p.id desc),
  spot as (select p.id, concat_ws(' ', f.site, s.code) as where_ from pallets p left join slots s on s.id = p.slot_id left join freezers f on f.id = s.freezer_id),
  rows_ as (
    select 'not_in_app'::text as issue, m.label as tag, null::bigint as pallet_id, null::text as code, m.item as strain, null::numeric as app_lbs, m.lbs as metrc_lbs,
           null::text as app_item, m.item as metrc_item, null::text as app_license, m.location as metrc_location, m.last_modified, m.source_harvests as note
      from m where not exists (select 1 from bytag b where upper(b.package_tag) = m.label)
    union all
    select 'closed_in_app', m.label, b.id, b.code, b.strain, b.current_weight, m.lbs, i.metrc_name, m.item, null, m.location, m.last_modified, 'App says ' || b.status
      from m join bytag b on upper(b.package_tag) = m.label left join items i on i.id = b.item_id
     where b.status not in ('in_freezer','unslotted','in_transit')
    union all
    select 'not_in_metrc', upper(l.package_tag), l.id, l.code, l.strain, l.current_weight, null, i.metrc_name, null, l.lic, null, null, null
      from live l left join items i on i.id = l.item_id
     where l.lic = p_license and l.package_tag is not null and not coalesce(l.tag_pending, false)
       and not exists (select 1 from m where m.label = upper(l.package_tag))
    union all
    select 'other_license', m.label, l.id, l.code, l.strain, l.current_weight, m.lbs, null, m.item, l.lic, m.location, m.last_modified, 'METRC: ' || p_license
      from m join live l on upper(l.package_tag) = m.label where l.lic is distinct from p_license
    union all
    select 'weight', m.label, l.id, l.code, l.strain, l.current_weight, m.lbs, null, null, l.lic, m.location, m.last_modified,
           case when l.current_weight > m.lbs then 'METRC is ' || round(l.current_weight - m.lbs, 2) || ' lb lower' else 'METRC is ' || round(m.lbs - l.current_weight, 2) || ' lb higher' end
      from m join live l on upper(l.package_tag) = m.label where m.lbs is not null and abs(coalesce(l.current_weight, 0) - m.lbs) > tol
    union all
    select 'item', m.label, l.id, l.code, l.strain, null, null, i.metrc_name, m.item, l.lic, m.location, m.last_modified, null
      from m join live l on upper(l.package_tag) = m.label join items i on i.id = l.item_id
     where i.metrc_name is not null and m.item is not null and lower(trim(i.metrc_name)) <> lower(trim(m.item))
    union all
    select 'on_hold', m.label, b.id, b.code, b.strain, null, m.lbs, null, m.item, null, m.location, m.last_modified, concat_ws(' · ', case when m.on_hold then 'On hold' end, m.lab_state)
      from m left join bytag b on upper(b.package_tag) = m.label
     where m.on_hold or coalesce(m.lab_state, '') ~* 'fail'
    union all
    select 'tag_pending', null, l.id, l.code, l.strain, l.current_weight, null, null, null, l.lic, null, null, null
      from live l where l.lic = p_license and (coalesce(l.tag_pending, false) or l.package_tag is null)
    union all
    select 'stale', upper(l.package_tag), l.id, l.code, l.strain, l.current_weight, null, null, null, l.lic, null, null,
           'No change in ' || (current_date - coalesce((select max(e.at) from events e where e.pallet_id = l.id), l.created_at)::date) || ' days'
      from live l where l.lic = p_license
       and coalesce((select max(e.at) from events e where e.pallet_id = l.id), l.created_at) < now() - make_interval(days => stale)
  )
  select r.issue, r.tag, r.pallet_id, r.code, r.strain, r.app_lbs, r.metrc_lbs, r.app_item, r.metrc_item, r.app_license, r.metrc_location,
         (select sp.where_ from spot sp where sp.id = r.pallet_id), r.last_modified,
         case when r.tag is not null and r.issue in ('weight', 'not_in_metrc', 'closed_in_app') then metrc_trail_text(metrc_trail(r.tag)) end,
         case when r.tag is not null and r.issue in ('weight', 'not_in_metrc', 'closed_in_app') then metrc_trail(r.tag) end,
         r.note
    from rows_ r;
end $$;
revoke all on function comp_reconcile_live(text) from public, anon;
grant execute on function comp_reconcile_live(text) to authenticated;
revoke all on function metrc_trail(text) from public, anon;
grant execute on function metrc_trail(text) to authenticated;

/** per license: when it was last pulled, how many packages */
create or replace function metrc_sync_status() returns table (license text, site text, last_pull timestamptz, complete boolean, active int, error text)
language sql stable security definer set search_path = public as $$
  select l.license_no, l.site,
         (select max(r.finished_at) from metrc_sync_runs r where r.license = l.license_no and r.complete),
         coalesce((select r.complete from metrc_sync_runs r where r.license = l.license_no order by r.id desc limit 1), false),
         (select count(*)::int from metrc_packages m where m.license = l.license_no and m.state in ('active', 'intransit')),
         (select r.error from metrc_sync_runs r where r.license = l.license_no order by r.id desc limit 1)
    from licenses l where l.active and l.site is not null and l.kind <> 'transport' and comp_can_read()
   order by l.site, l.license_no
$$;
revoke all on function metrc_sync_status() from public, anon;
grant execute on function metrc_sync_status() to authenticated;

-- ---------- after a pull: close to-dos METRC already shows ----------
create or replace function metrc_autoclose() returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; k int;
begin
  -- a package-making step whose tag now exists in METRC (entered by hand, through Roshi, or by the app)
  update comp_metrc_actions a set status = 'done', done_by = 'METRC sync (already in METRC)', done_at = now(),
         note = coalesce(a.note, 'Tag is in METRC')
   where a.status in ('todo', 'error') and a.kind in ('harvest_package', 'new_package', 'split', 'combine', 'proc_output', 'tag')
     and a.tag is not null and exists (select 1 from metrc_packages m where m.label = upper(a.tag));
  get diagnostics k = row_count; n := n + k;
  -- a weight change METRC already matches (the package's current weight in the app = METRC)
  update comp_metrc_actions a set status = 'done', done_by = 'METRC sync (already in METRC)', done_at = now(),
         note = coalesce(a.note, 'METRC weight matches the app')
    from pallets p, metrc_packages m
   where a.status in ('todo', 'error') and a.kind = 'adjust' and p.id = a.pallet_id and m.label = upper(p.package_tag)
     and m.state in ('active', 'intransit') and m.lbs is not null and abs(m.lbs - p.current_weight) < 0.01
     and not exists (select 1 from comp_metrc_actions b where b.tag = a.tag and b.status in ('todo', 'error') and b.id > a.id);
  get diagnostics k = row_count; n := n + k;
  -- finished / used up, and METRC has it finished
  update comp_metrc_actions a set status = 'done', done_by = 'METRC sync (already in METRC)', done_at = now(),
         note = coalesce(a.note, 'Finished in METRC')
   where a.status in ('todo', 'error') and a.kind = 'finish' and a.tag is not null
     and exists (select 1 from metrc_packages m where m.label = upper(a.tag) and m.state in ('inactive', 'transferred'));
  get diagnostics k = row_count; n := n + k;
  -- shipped / transferred, and the tag is on a METRC manifest made after the to-do
  update comp_metrc_actions a set status = 'done', done_by = 'METRC sync (already in METRC)', done_at = now(),
         note = coalesce(a.note, 'On manifest ' || (select t.manifest from metrc_transfer_packages tp join metrc_transfers t on t.delivery_id = tp.delivery_id
                                                     where tp.label = upper(a.tag) and not t.voided order by t.created_at desc limit 1))
   where a.status in ('todo', 'error') and a.kind in ('transfer', 'manifest') and a.tag is not null
     and exists (select 1 from metrc_transfer_packages tp join metrc_transfers t on t.delivery_id = tp.delivery_id
                  where tp.label = upper(a.tag) and not t.voided and coalesce(t.created_at, now()) >= a.at - interval '2 days');
  get diagnostics k = row_count; n := n + k;
  if n > 0 then
    insert into events (user_email, type, note, details) values ('metrc sync', 'metrc_autoclose', n || ' to-dos already in METRC', jsonb_build_object('n', n));
  end if;
  return n;
end $$;
revoke all on function metrc_autoclose() from public, anon, authenticated;
grant execute on function metrc_autoclose() to service_role;

select '071 metrc sync' as ok;
