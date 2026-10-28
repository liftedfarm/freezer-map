-- 090: each module receives its own deliveries; the nursery > production count check; quick transfer manifests from the map.
--  1. Production > Receiving: clones and plants coming to OHR / GVR (from 1PN in the app, or METRC deliveries from outside).
--     Nursery > Receiving: anything coming to 1PN. Distribution > Inbound keeps product packages.
--  2. 1PN > our farms in two steps: the nursery ships (the METRC transfer is made right away), production counts what came.
--     Counts match: received (planting receipt made, METRC receive queued). Counts off: the delivery is held and every
--     Nursery Admin gets an alert to fix the manifest in METRC; once fixed, production is told to recount.
--     Dead or damaged on arrival: received in full, the bad ones logged as a loss (METRC to-do).
--  3. Outside nursery counts off: an alert, and an email to them (queued until email sending is set up).
--  4. Alerts: a small in-app list per module (admins or everyone in the module), shown on the module's dashboard.
--  5. quick_transfer: a one-off OHR <> GVR transfer load for pallets moved on the map (then Depart makes the manifest).
-- Run after 089. Safe to run more than once.

-- =====================================================================================================
-- 1. alerts and the email outbox
-- =====================================================================================================
create table if not exists app_alerts (
  id         bigserial primary key,
  module     text not null,                 -- nursery, cultivation, distribution, sales, ...
  admins     boolean not null default true, -- admins of the module only (else everyone in it)
  kind       text not null,                 -- counts_off, manifest_fixed, ...
  title      text not null,
  body       text,
  ref        jsonb not null default '{}',
  created_by text default current_email(),
  created_at timestamptz not null default now(),
  done_by    text,
  done_at    timestamptz
);
create index if not exists app_alerts_open on app_alerts (module) where done_at is null;
alter table app_alerts enable row level security;
revoke all on app_alerts from anon, authenticated;

create table if not exists email_outbox (
  id         bigserial primary key,
  to_email   text not null,
  subject    text not null,
  body       text not null,
  kind       text,
  ref        jsonb not null default '{}',
  created_by text default current_email(),
  created_at timestamptz not null default now(),
  sent_at    timestamptz,
  error      text
);
alter table email_outbox enable row level security;
revoke all on email_outbox from anon, authenticated;

create or replace function _alert(p_module text, p_admins boolean, p_kind text, p_title text, p_body text, p_ref jsonb) returns bigint
language sql security definer set search_path = public as $$
  insert into app_alerts (module, admins, kind, title, body, ref) values (p_module, p_admins, p_kind, p_title, p_body, coalesce(p_ref, '{}')) returning id
$$;
revoke all on function _alert(text, boolean, text, text, text, jsonb) from public, anon, authenticated;

-- open alerts I should see (module admins, or everyone in the module)
create or replace function my_alerts(p_module text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_staff();
  return coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at desc) from app_alerts a
    where a.done_at is null and (p_module is null or a.module = p_module)
      and (is_owner() or (case when a.admins then mod_level(a.module) = 'admin' else mod_level(a.module) is not null end))), '[]');
end $$;

create or replace function alert_done(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare a app_alerts;
begin
  perform require_staff();
  select * into a from app_alerts where id = p_id;
  if a.id is null then return; end if;
  if not (is_owner() or mod_level(a.module) is not null) then raise exception 'Not your module'; end if;
  update app_alerts set done_at = now(), done_by = current_email() where id = a.id and done_at is null;
end $$;

-- =====================================================================================================
-- 2. 1PN > our farms: ship, count, receive
-- =====================================================================================================
create table if not exists delivery_checks (
  ref          uuid primary key,             -- nursery_deliveries.ref (one delivery)
  order_id     bigint references cult_nursery_orders(id) on delete cascade,
  site         text not null,                -- OHR / GVR (the farm receiving)
  status       text not null default 'in_transit' check (status in ('in_transit', 'counts_off', 'recount', 'received', 'returned')),
  counted      jsonb,                        -- [{id (nursery_deliveries.id), plants, counted}]
  dead         int not null default 0,
  note         text,
  checked_by   text, checked_at timestamptz,
  fixed_by     text, fixed_at timestamptz, fix_note text,
  received_by  text, received_at timestamptz,
  receipt_id   bigint references cult_receipts(id) on delete set null,
  created_at   timestamptz not null default now()
);
alter table delivery_checks enable row level security;
drop policy if exists delivery_checks_read on delivery_checks;
create policy delivery_checks_read on delivery_checks for select to authenticated using (is_staff());
grant select on delivery_checks to authenticated;

-- deliveries to our own farms wait for production to count them (no receipt until then)
do $$
declare d text;
begin
  select pg_get_functiondef('nursery_deliver(bigint,jsonb,date,text,text)'::regprocedure) into d;
  if d not like '%delivery_checks%' then
    d := replace(d, '  if o.site is not null then
    insert into cult_receipts (crop_year, site, strain, batch, nursery, source, order_id, received_on, received, notes)
    values (o.crop_year, o.site, o.strain, coalesce((select max(batch) + 1 from cult_receipts where crop_year = o.crop_year and site = o.site and strain = o.strain), 1),
            o.nursery_site, ''clone'', o.id, d, tot, concat_ws('' · '', ''Delivered by '' || o.nursery_site, ''manifest '' || nullif(trim(p_manifest), '''')))
    returning * into rc;
    update nursery_deliveries set receipt_id = rc.id where nursery_deliveries.ref = v_ref;
  end if;',
    '  if o.site is not null then
    insert into delivery_checks (ref, order_id, site) values (v_ref, o.id, o.site) on conflict (ref) do nothing;
  end if;');
    if d not like '%delivery_checks%' then raise exception '090: nursery_deliver has changed; the receipt block wasn''t found'; end if;
    execute d;
  end if;
end $$;

-- taking a delivery back also drops its check
do $$
declare d text;
begin
  select pg_get_functiondef('nursery_undo_delivery(uuid)'::regprocedure) into d;
  if d not like '%delivery_checks%' then
    d := replace(d, '  delete from nursery_deliveries where ref = p_ref;',
                    '  if exists (select 1 from delivery_checks where ref = p_ref and status = ''received'') then raise exception ''Production already received it. Fix it on their side first.''; end if;
  delete from delivery_checks where ref = p_ref;
  delete from nursery_deliveries where ref = p_ref;');
    execute d;
  end if;
end $$;

-- the manifest number the app made for a nursery delivery
create or replace function nursery_ref_manifest(p_ref uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select min(manifest) from nursery_deliveries where ref = p_ref and manifest is not null),
                  (select t.manifest from metrc_app_transfers t where t.key like '%' || p_ref::text || '%' and t.state <> 'voided' limit 1))
$$;

-- what's on the way / waiting (Production and Nursery screens)
create or replace function receiving_list(p_module text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_staff();
  if p_module not in ('cultivation', 'nursery') then raise exception 'Which module?'; end if;
  if mod_level(p_module) is null and not is_owner() then raise exception 'Not your module'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'ref', k.ref, 'site', k.site, 'status', k.status, 'counted', k.counted, 'dead', k.dead, 'note', k.note, 'fix_note', k.fix_note,
      'checked_by', k.checked_by, 'checked_at', k.checked_at, 'fixed_at', k.fixed_at, 'received_at', k.received_at,
      'order_id', o.id, 'so', o.so_number, 'strain', o.strain, 'nursery', o.nursery_site, 'manifest', nursery_ref_manifest(k.ref),
      'shipped_on', (select min(delivered_on) from nursery_deliveries where ref = k.ref),
      'lines', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'plants', x.plants, 'batch_id', x.batch_id,
                   'batch', coalesce(b.name, 'Batch ' || b.id), 'tag', b.package_tag, 'strain', coalesce(b.strain, o.strain)) order by x.id), '[]')
                  from nursery_deliveries x left join nursery_batches b on b.id = x.batch_id where x.ref = k.ref)) order by k.created_at)
    from delivery_checks k join cult_nursery_orders o on o.id = k.order_id
   where (k.status <> 'received' or k.received_at > now() - interval '3 days')
     and (p_module = 'cultivation' or k.status in ('counts_off', 'recount', 'in_transit'))), '[]');
end $$;

-- production counts a delivery. p_counts: [{id, counted}] per delivery line. p_dead: dead / damaged (received, then logged as a loss)
create or replace function delivery_count(p_ref uuid, p_counts jsonb, p_dead int default 0, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare k delivery_checks; o cult_nursery_orders; x record; cnt int; off text := ''; tot int := 0; rows jsonb := '[]'; rc cult_receipts; man text; tags jsonb;
begin
  perform no_view_as();
  if not can_edit('cultivation') then raise exception 'Only Production can receive plants'; end if;
  select * into k from delivery_checks where ref = p_ref for update;
  if k.ref is null then raise exception 'Delivery not found'; end if;
  if k.status = 'received' then raise exception 'Already received'; end if;
  if k.status = 'counts_off' then raise exception 'Waiting on the nursery to fix the manifest'; end if;
  select * into o from cult_nursery_orders where id = k.order_id;
  man := nursery_ref_manifest(k.ref);
  for x in select d.id, d.plants, coalesce(b.name, 'Batch ' || d.batch_id, o.strain) as nm, coalesce(b.strain, o.strain) as strain
             from nursery_deliveries d left join nursery_batches b on b.id = d.batch_id where d.ref = k.ref order by d.id loop
    cnt := (select (e ->> 'counted')::int from jsonb_array_elements(coalesce(p_counts, '[]')) e where (e ->> 'id')::bigint = x.id);
    if cnt is null then raise exception 'Enter the count for %', x.nm; end if;
    if cnt < 0 then raise exception 'Counts can''t be negative'; end if;
    rows := rows || jsonb_build_object('id', x.id, 'name', x.nm, 'strain', x.strain, 'plants', x.plants, 'counted', cnt);
    if cnt <> x.plants then off := off || format(E'%s (%s): manifest %s, counted %s\n', x.strain, x.nm, x.plants, cnt); end if;
    tot := tot + cnt;
  end loop;
  update delivery_checks set counted = rows, checked_by = current_email(), checked_at = now(), note = nullif(trim(p_note), ''), dead = greatest(coalesce(p_dead, 0), 0)
   where ref = k.ref;
  if off <> '' then
    update delivery_checks set status = 'counts_off' where ref = k.ref;
    perform _alert('nursery', true, 'counts_off',
      format('Counts off: %s to %s%s', coalesce(o.nursery_site, '1PN'), k.site, coalesce(' (manifest ' || man || ')', '')),
      off || coalesce('Note: ' || nullif(trim(p_note), '') || E'\n', '') || 'Fix the manifest in METRC, then press "Manifest fixed" in Nursery > Receiving.',
      jsonb_build_object('ref', k.ref, 'order_id', o.id, 'so', o.so_number, 'manifest', man, 'site', k.site));
    insert into events (user_email, type, note, details)
    values (current_email(), 'delivery_counts_off', o.strain, jsonb_build_object('ref', k.ref, 'order_id', o.id, 'site', k.site, 'manifest', man, 'counts', rows));
    return jsonb_build_object('status', 'counts_off', 'off', off);
  end if;
  -- counts match: received
  insert into cult_receipts (crop_year, site, strain, batch, nursery, source, order_id, received_on, received, rejected, notes)
  values (o.crop_year, k.site, o.strain, coalesce((select max(batch) + 1 from cult_receipts where crop_year = o.crop_year and site = k.site and strain = o.strain), 1),
          o.nursery_site, 'clone', o.id, _local_today(), tot, greatest(coalesce(p_dead, 0), 0),
          concat_ws(' · ', 'Delivered by ' || o.nursery_site, 'manifest ' || man, case when p_dead > 0 then p_dead || ' dead or damaged on arrival' end, nullif(trim(p_note), '')))
  returning * into rc;
  update nursery_deliveries set receipt_id = rc.id where ref = k.ref;
  update delivery_checks set status = 'received', received_by = current_email(), received_at = now(), receipt_id = rc.id where ref = k.ref;
  select coalesce(jsonb_agg(distinct upper(b.package_tag)) filter (where b.package_tag is not null), '[]') into tags
    from nursery_deliveries d join nursery_batches b on b.id = d.batch_id where d.ref = k.ref;
  -- METRC: receive the transfer; dead ones get a loss to-do
  insert into events (user_email, type, note, details)
  values (current_email(), 'nursery_received', o.strain, jsonb_build_object('ref', k.ref, 'order_id', o.id, 'site', k.site, 'to_site', k.site,
          'to_license', comp_site_cult_license(k.site), 'manifest', man, 'plants', tot, 'tag', tags ->> 0, 'tags', tags, 'strain', o.strain));
  if p_dead > 0 then
    insert into events (user_email, type, note, details)
    values (current_email(), 'receipt_loss', o.strain, jsonb_build_object('ref', k.ref, 'site', k.site, 'strain', o.strain, 'lost', p_dead, 'manifest', man,
            'tag', tags ->> 0, 'receipt_id', rc.id));
  end if;
  update app_alerts set done_at = now(), done_by = current_email() where done_at is null and ref ->> 'ref' = k.ref::text;
  return jsonb_build_object('status', 'received', 'plants', tot, 'receipt_id', rc.id);
end $$;

-- the nursery fixed the manifest in METRC (optionally the corrected plant counts): production recounts
create or replace function delivery_fixed(p_ref uuid, p_note text default null, p_counts jsonb default null) returns void
language plpgsql security definer set search_path = public as $$
declare k delivery_checks; o cult_nursery_orders; e jsonb;
begin
  perform no_view_as();
  if not can_edit('nursery') then raise exception 'Only the Nursery can mark the manifest fixed'; end if;
  select * into k from delivery_checks where ref = p_ref for update;
  if k.ref is null then raise exception 'Delivery not found'; end if;
  if k.status <> 'counts_off' then raise exception 'That delivery isn''t waiting on a manifest fix'; end if;
  select * into o from cult_nursery_orders where id = k.order_id;
  for e in select * from jsonb_array_elements(coalesce(p_counts, '[]')) loop
    if (e ->> 'plants')::int <= 0 then raise exception 'Plants must be more than 0 (take the delivery back instead)'; end if;
    update nursery_deliveries set plants = (e ->> 'plants')::int where id = (e ->> 'id')::bigint and ref = k.ref;
  end loop;
  update delivery_checks set status = 'recount', fixed_by = current_email(), fixed_at = now(), fix_note = nullif(trim(p_note), '') where ref = k.ref;
  update app_alerts set done_at = now(), done_by = current_email() where done_at is null and kind = 'counts_off' and ref ->> 'ref' = k.ref::text;
  perform _alert('cultivation', false, 'manifest_fixed',
    format('Manifest fixed: %s to %s%s. Recount and receive.', coalesce(o.nursery_site, '1PN'), k.site, coalesce(' (manifest ' || nursery_ref_manifest(k.ref) || ')', '')),
    nullif(trim(p_note), ''), jsonb_build_object('ref', k.ref, 'order_id', o.id, 'site', k.site));
  insert into events (user_email, type, note, details) values (current_email(), 'delivery_manifest_fixed', o.strain, jsonb_build_object('ref', k.ref, 'note', p_note, 'counts', p_counts));
end $$;

-- outside nursery (METRC delivery not made in the app): counts off > alert, and an email to them (sent once email is set up)
create table if not exists license_contacts (license text primary key, name text, email text, updated_by text, updated_at timestamptz not null default now());
alter table license_contacts enable row level security;
drop policy if exists license_contacts_read on license_contacts;
create policy license_contacts_read on license_contacts for select to authenticated using (is_staff());
grant select on license_contacts to authenticated;

create or replace function outside_counts_off(p_module text, p_license text, p_manifest text, p_from text, p_from_license text, p_email text, p_lines jsonb, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare off text := ''; e jsonb; mail text := nullif(lower(trim(p_email)), '');
begin
  perform no_view_as();
  if p_module not in ('cultivation', 'nursery', 'distribution') or not can_edit(p_module) then raise exception 'Not your module'; end if;
  for e in select * from jsonb_array_elements(coalesce(p_lines, '[]')) loop
    if (e ->> 'qty')::numeric is distinct from (e ->> 'counted')::numeric then
      off := off || format(E'%s %s: manifest %s, counted %s\n', coalesce(e ->> 'item', ''), coalesce(e ->> 'tag', ''), e ->> 'qty', e ->> 'counted');
    end if;
  end loop;
  if off = '' then raise exception 'The counts match. Receive it instead.'; end if;
  if p_from_license is not null and mail is not null then
    insert into license_contacts (license, name, email, updated_by) values (upper(p_from_license), p_from, mail, current_email())
    on conflict (license) do update set email = excluded.email, name = coalesce(excluded.name, license_contacts.name), updated_by = excluded.updated_by, updated_at = now();
  end if;
  perform _alert(p_module, true, 'counts_off_outside', format('Counts off from %s (manifest %s)', coalesce(p_from, p_from_license, '?'), coalesce(p_manifest, '?')),
    off || coalesce('Note: ' || nullif(trim(p_note), '') || E'\n', '') || case when mail is not null then 'Emailed ' || mail || '.' else 'No email on file for them: call them.' end,
    jsonb_build_object('license', p_license, 'manifest', p_manifest, 'from_license', p_from_license));
  if mail is not null then
    insert into email_outbox (to_email, subject, body, kind, ref)
    values (mail, format('Lifted Farms: counts don''t match manifest %s', coalesce(p_manifest, '')),
            format(E'Hi %s,\n\nWe counted the delivery on manifest %s to %s and the counts don''t match:\n\n%s%s\nPlease fix the manifest in METRC and let us know, then we''ll receive it.\n\nThanks,\nLifted Farms',
                   coalesce(p_from, ''), coalesce(p_manifest, ''), p_license, off, coalesce(E'\nNote: ' || nullif(trim(p_note), ''), '')),
            'counts_off', jsonb_build_object('license', p_license, 'manifest', p_manifest));
  end if;
  insert into events (user_email, type, details) values (current_email(), 'outside_counts_off', jsonb_build_object('license', p_license, 'manifest', p_manifest, 'from', p_from, 'lines', p_lines, 'email', mail));
  return jsonb_build_object('off', off, 'emailed', mail is not null);
end $$;

-- outside clones received in Production: a planting receipt (matched to an open clone order for that strain at that farm)
create or replace function outside_plants_received(p_site text, p_manifest text, p_from text, p_lines jsonb, p_dead int default 0) returns int
language plpgsql security definer set search_path = public as $$
declare e jsonb; o cult_nursery_orders; n int := 0; s text; q int;
begin
  perform no_view_as();
  if not can_edit('cultivation') then raise exception 'Only Production'; end if;
  for e in select * from jsonb_array_elements(coalesce(p_lines, '[]')) loop
    s := coalesce(canonical_strain(e ->> 'strain'), e ->> 'strain');
    q := coalesce((e ->> 'counted')::numeric, (e ->> 'qty')::numeric)::int;
    if s is null or q is null or q <= 0 then continue; end if;
    select * into o from cult_nursery_orders x where x.site = upper(p_site) and lower(x.strain) = lower(s) and x.status in ('ordered', 'confirmed')
      and x.crop_year = crop_year() order by x.deliver_on nulls last limit 1;
    insert into cult_receipts (crop_year, site, strain, batch, nursery, source, order_id, received_on, received, notes)
    values (crop_year(), upper(p_site), s, coalesce((select max(batch) + 1 from cult_receipts where crop_year = crop_year() and site = upper(p_site) and strain = s), 1),
            p_from, 'clone', o.id, _local_today(), q, concat_ws(' · ', 'From ' || p_from, 'manifest ' || p_manifest, 'tag ' || (e ->> 'tag')));
    n := n + 1;
  end loop;
  if p_dead > 0 then
    insert into events (user_email, type, details) values (current_email(), 'receipt_loss', jsonb_build_object('site', upper(p_site), 'lost', p_dead, 'manifest', p_manifest, 'from', p_from));
  end if;
  return n;
end $$;

-- METRC to-dos for the new events
create or replace function metrc_kind(p_type text) returns text
language sql immutable as $$
  select case p_type
    when 'weight_adjust' then 'adjust'
    when 'split_from' then 'split'
    when 'merge' then 'combine'
    when 'removed' then 'finish'
    when 'tag_set' then 'tag'
    when 'created' then 'new_package'
    when 'stop_departed' then 'manifest'
    when 'proc_sent' then 'transfer'
    when 'move' then 'ship_check'
    when 'shipped' then 'ship_check'
    when 'received' then 'receive'
    when 'proc_received' then 'receive'
    when 'nursery_received' then 'receive'
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
    when 'receipt_loss' then 'plant_loss'
    when 'planting_flip' then 'flower'
    when 'nursery_shipped' then 'transfer'
    else 'other' end
$$;

do $$
declare d text;
begin
  select pg_get_functiondef('_metrc_queue_more()'::regprocedure) into d;
  if d not like '%nursery_received%' then
    d := replace(d, '''planting_made'', ''planting_loss'', ''planting_flip'') then return new; end if;',
                    '''planting_made'', ''planting_loss'', ''planting_flip'', ''nursery_received'', ''receipt_loss'') then return new; end if;');
    d := replace(d, '    when ''planting_flip'' then ''Flip to flowering (plant tags)'' end;',
                    '    when ''planting_flip'' then ''Flip to flowering (plant tags)''
    when ''nursery_received'' then ''Receive clones at '' || coalesce(d ->> ''site'', ''?'') || '' (manifest '' || coalesce(d ->> ''manifest'', ''?'') || '')''
    when ''receipt_loss'' then ''Destroy plants dead on arrival at '' || coalesce(d ->> ''site'', ''?'') end;');
    d := replace(d, '    when new.type like ''nursery%'' then (select license from nursery_sites where code = d ->> ''site'')',
                    '    when new.type = ''nursery_received'' then d ->> ''to_license''
    when new.type like ''nursery%'' then (select license from nursery_sites where code = d ->> ''site'')');
    d := replace(d, '                 case when new.type = ''planting_flip'' then (d ->> ''plants'') || '' plants'' end);',
                    '                 case when new.type = ''planting_flip'' then (d ->> ''plants'') || '' plants'' end,
                 case when new.type = ''nursery_received'' then (d ->> ''plants'') || '' plants'' end,
                 case when new.type = ''receipt_loss'' then (d ->> ''lost'') || '' dead'' end);');
    execute d;
  end if;
end $$;

-- the server: a nursery Ship whose METRC transfer failed is taken back (nothing left)
create or replace function nursery_ship_undo(p_ref uuid, p_by text, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare x record;
begin
  if auth.role() <> 'service_role' then raise exception 'Server only'; end if;
  select min(order_id) order_id, min(invoice_id) invoice_id, sum(plants) plants into x from nursery_deliveries where ref = p_ref;
  if x.order_id is null then return; end if;
  update invoices set status = 'void', notes = concat_ws(E'\n', notes, 'Shipping cancelled: the METRC transfer failed'), updated_at = now() where id = x.invoice_id;
  delete from delivery_checks where ref = p_ref;
  delete from nursery_deliveries where ref = p_ref;
  update nursery_batches b set stage = 'ready' where stage = 'done' and b.cuttings - b.lost > coalesce((select sum(plants) from nursery_deliveries where batch_id = b.id), 0);
  update cult_nursery_orders set status = 'confirmed', updated_at = now() where id = x.order_id and status = 'received';
  update comp_metrc_actions set status = 'skipped', note = 'Ship cancelled: ' || left(coalesce(p_reason, ''), 300), done_by = p_by, done_at = now()
   where details ->> 'type' = 'nursery_shipped' and details ->> 'ref' = p_ref::text and status in ('todo', 'error');
  insert into events (user_email, type, details) values (coalesce(p_by, 'system'), 'nursery_ship_cancelled', jsonb_build_object('ref', p_ref, 'order_id', x.order_id, 'plants', x.plants, 'reason', p_reason));
end $$;
revoke all on function nursery_ship_undo(uuid, text, text) from public, anon, authenticated;
grant execute on function nursery_ship_undo(uuid, text, text) to service_role;

-- who can receive in METRC from the app: Compliance, Distribution / Processing Admins, and Production / Nursery for their own deliveries
create or replace function metrc_me() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'email', current_email(),
    'admin', coalesce(comp_is_admin(), false),
    'can_send', coalesce((comp_can_edit() or is_mod_admin('distribution') or is_mod_admin('processing') or is_owner()) and not impersonating(), false),
    'can_receive_plants', coalesce((comp_can_edit() or can_edit('cultivation') or is_owner()) and not impersonating(), false),
    'can_receive_nursery', coalesce((comp_can_edit() or can_edit('nursery') or is_owner()) and not impersonating(), false),
    'can_ship_nursery', coalesce((comp_can_edit() or can_edit('nursery') or is_owner()) and not impersonating(), false))
$$;

-- =====================================================================================================
-- 3. quick transfer: pallets moved OHR <> GVR on the map get a real load (Depart then makes the METRC transfer)
-- =====================================================================================================
create or replace function quick_transfer(p_pallets bigint[], p_to_site text, p_vehicle int, p_driver text) returns int
language plpgsql security definer set search_path = public as $$
declare l loads; cust int; pid bigint; it load_items;
begin
  perform require_distribution();
  perform no_view_as();
  select id into cust from customers where kind = 'internal' and upper(name) = upper(p_to_site);
  if cust is null then raise exception '% isn''t set up as a stop', p_to_site; end if;
  if coalesce(array_length(p_pallets, 1), 0) = 0 then raise exception 'Pick the pallets'; end if;
  if nullif(trim(p_driver), '') is null then raise exception 'Pick the driver'; end if;
  l := create_load(p_vehicle, _local_today(), jsonb_build_array(jsonb_build_object('customer_id', cust)), p_driver, 'Transfer from the freezer map');
  foreach pid in array p_pallets loop
    it := plan_pallet(l.id, (select id from load_stops where load_id = l.id limit 1), pid);
    perform load_pallet(it.id);
  end loop;
  return l.id;
end $$;

do $$
declare f text;
begin
  foreach f in array array['my_alerts(text)', 'alert_done(bigint)', 'receiving_list(text)', 'delivery_count(uuid,jsonb,int,text)',
    'delivery_fixed(uuid,text,jsonb)', 'outside_counts_off(text,text,text,text,text,text,jsonb,text)', 'outside_plants_received(text,text,text,jsonb,int)',
    'quick_transfer(bigint[],text,int,text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke all on function nursery_ref_manifest(uuid) from public, anon, authenticated;
