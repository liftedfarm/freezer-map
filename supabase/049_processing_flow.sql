-- Migration 049: Processing made simpler (actions on each package), forecasts, commit forecast from bucked, manifest sheets for processors.
-- Run once in Supabase after 048_piece_rate.sql: SQL Editor > New query > paste > Run. Safe to re-run.
--
--  * Bucking can start straight from a wet package (it's counted as dried in house).
--  * Forecast per strain: wet -> bucked (and buck trim), bucked -> standards / smalls / trim / mold.
--      From this strain's finished runs first, then the FL25 workbook Totals tab (loaded here), then all strains,
--      and for wet -> bucked with no runs yet, a default (20%, Processing Admins change it in Settings).
--  * Sales/Processing can commit FORECAST standards / smalls / trim from a bucked package to an order line (only from bucked).
--    When that package is trimmed, the real packages go on the order automatically (split if needed, tag pending).
--  * Processors get address, contact and phone; a manifest sheet can be printed for what was sent to them.
--  * Labor cost (piece pay) per strain for Yields.
set client_min_messages = warning;

-- ---------- processors: details for the manifest sheet ----------
alter table proc_processors add column if not exists address text;
alter table proc_processors add column if not exists contact text;
alter table proc_processors add column if not exists phone text;
create or replace function proc_save_processor(p jsonb) returns proc_processors
language plpgsql security definer set search_path = public as $$
declare x proc_processors;
begin
  perform no_view_as();
  if not (is_mod_admin('processing') or is_owner()) then raise exception 'Only a Processing Admin can change processors'; end if;
  if nullif(trim(p ->> 'name'), '') is null then raise exception 'Name?'; end if;
  if nullif(p ->> 'id', '') is null then
    insert into proc_processors (name, short, in_house, license, active, sort, notes, address, contact, phone)
    values (trim(p ->> 'name'), nullif(trim(p ->> 'short'), ''), coalesce((p ->> 'in_house')::boolean, false), nullif(trim(p ->> 'license'), ''),
            coalesce((p ->> 'active')::boolean, true), coalesce(nullif(p ->> 'sort', '')::int, 9), nullif(trim(p ->> 'notes'), ''),
            nullif(trim(p ->> 'address'), ''), nullif(trim(p ->> 'contact'), ''), nullif(trim(p ->> 'phone'), ''))
    returning * into x;
  else
    update proc_processors set name = trim(p ->> 'name'), short = nullif(trim(p ->> 'short'), ''), in_house = coalesce((p ->> 'in_house')::boolean, false),
           license = nullif(trim(p ->> 'license'), ''), active = coalesce((p ->> 'active')::boolean, true), notes = nullif(trim(p ->> 'notes'), ''),
           address = nullif(trim(p ->> 'address'), ''), contact = nullif(trim(p ->> 'contact'), ''), phone = nullif(trim(p ->> 'phone'), '')
     where id = (p ->> 'id')::int returning * into x;
  end if;
  insert into events (user_email, type, note) values (current_email(), 'proc_settings', 'processor ' || x.name);
  return x;
end $$;

-- manifest sheet for packages sent to a processor (same layout as a load stop's manifest sheet)
create or replace function proc_manifest(p_ids bigint[]) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare pr proc_processors; d date; sites text[];
begin
  if not (has_module('processing') or has_module('distribution')) then raise exception 'Not allowed'; end if;
  select x.* into pr from proc_processors x where x.id = (select min(processor_id) from pallets where id = any(p_ids));
  if pr.id is null then raise exception 'These packages aren''t at a processor'; end if;
  if (select count(distinct processor_id) from pallets where id = any(p_ids)) > 1 then raise exception 'Pick packages going to one processor'; end if;
  select max(sent_on), array_agg(distinct coalesce(split_part(origin_site, '+', 1), 'OHR')) into d, sites from pallets where id = any(p_ids);
  return jsonb_build_object(
    'load', 'To ' || coalesce(pr.short, pr.name), 'load_date', coalesce(d, current_date), 'status', 'sent', 'driver', null, 'vehicle', null, 'plate', null,
    'stop', 1, 'stop_status', 'sent', 'manifest', null, 'transfer', false, 'orders', '[]'::jsonb,
    'from', (select coalesce(jsonb_agg(_lic(site_license(s)) || jsonb_build_object('from_site', s)), '[]'::jsonb) from unnest(sites) s),
    'to', jsonb_build_object('name', pr.name, 'license', pr.license, 'address', pr.address, 'contact', pr.contact, 'phone', pr.phone, 'kind', 'processor, drying'),
    'transporter', _lic(transport_license()),
    'packages', (select coalesce(jsonb_agg(jsonb_build_object('pallet', p.code, 'code', p.code, 'tag', p.package_tag, 'tag_pending', p.tag_pending, 'strain', p.strain,
                   'origin', p.origin_site, 'from', p.origin_site, 'lbs', p.current_weight, 'crop_year', p.crop_year, 'harvested', p.harvest_date,
                   'batch', batch_name(coalesce(p.crop_year, extract(year from p.harvest_date)::int), split_part(p.origin_site, '+', 1), p.strain, p.product)) order by p.code), '[]')
                 from pallets p where p.id = any(p_ids)));
end $$;

-- ---------- bucking straight from wet ----------
do $$
declare d text;
begin
  select pg_get_functiondef('_proc_set_inputs(proc_runs,jsonb)'::regprocedure) into d;
  if d not like '%counted as dried in house%' then
    d := replace(d, 'if r.kind = ''buck'' and p.product <> ''unbucked'' then raise exception ''% is %. Bucking takes unbucked packages.''',
                    'if r.kind = ''buck'' and p.product not in (''unbucked'',''wet'') then raise exception ''% is %. Bucking takes wet or unbucked packages.''');
    d := replace(d, '    insert into proc_run_inputs (run_id, pallet_id, lbs, whole)',
      '    if p.product = ''wet'' then   -- counted as dried in house' || chr(10) ||
      '      update pallets set product = ''unbucked'', processor_id = coalesce(processor_id, (select id from proc_processors where in_house order by sort, id limit 1)), updated_at = now() where id = p.id;' || chr(10) ||
      '      insert into events (user_email, type, pallet_id, lbs, details) values (current_email(), ''proc_dried'', p.id, p.current_weight, jsonb_build_object(''in_house'', true, ''with_bucking'', true));' || chr(10) ||
      '    end if;' || chr(10) ||
      '    insert into proc_run_inputs (run_id, pallet_id, lbs, whole)');
    execute d;
  end if;
end $$;

-- ---------- FL25 yields from the workbook's Totals tab ----------
create table if not exists proc_yield_history (
  id         serial primary key,
  strain     text not null,
  crop_year  int not null,
  source     text not null,
  wet_lbs    numeric,
  bucked     numeric not null default 0,
  buck_mold  numeric not null default 0,
  buck_trim  numeric not null default 0,
  standards  numeric not null default 0,
  trim_mold  numeric not null default 0,
  smalls     numeric not null default 0,
  trim_lbs   numeric not null default 0,
  notes      text,
  unique (strain, crop_year, source)
);
alter table proc_yield_history enable row level security;
drop policy if exists read_proc on proc_yield_history;
create policy read_proc on proc_yield_history for select to authenticated using (is_staff());
grant select on proc_yield_history to authenticated;
insert into proc_yield_history (strain, crop_year, source, bucked, buck_mold, buck_trim, standards, trim_mold, smalls, trim_lbs, notes)
select coalesce(canonical_strain(v.s), v.s), 2025, 'FL25 workbook', v.b, v.bm, v.bt, v.st, v.tm, v.sm, v.tr, v.n from (values
  ('Cereal Milk', 662.93, 31.16, 52, 290.04, 7.34, 58.2, 59.1, 'Dried at Strong Ag (Pandas)'),
  ('Crush Mintz', 678.92, 57.08, 75, 456.18, 36.84, 68.6, 96.88, 'Dried at Strong Ag'),
  ('Gurple', 238.6, 208.22, 20.3, 0, 0, 0, 0, 'Dried at CCP; trimmed at Strong'),
  ('Jelly Cake', 302.76, 101.68, 30.96, 206.64, 12.32, 23.06, 54.82, 'Dried in GV trailers; 201.3 lbs total DF after mold re-sort'),
  ('Modified Mintz', 246.66, 20.5, 15.6, 0, 0, 0, 0, 'Dried at CCP; trimmed at Strong'),
  ('Strawnana Mac', 515.66, 3.9, 26.8, 341.1, 5.44, 44.24, 103.76, 'Dried at CCP')
) v(s, b, bm, bt, st, tm, sm, tr, n)
on conflict (strain, crop_year, source) do update set bucked = excluded.bucked, buck_mold = excluded.buck_mold, buck_trim = excluded.buck_trim,
  standards = excluded.standards, trim_mold = excluded.trim_mold, smalls = excluded.smalls, trim_lbs = excluded.trim_lbs, notes = excluded.notes;

-- ---------- forecast rates ----------
-- per strain: dry (bucked flower / wet), bt (buck trim / bucked flower), std / sml / trm / mold (share of bucked lbs that go into trimming)
create or replace function proc_rates() returns jsonb
language sql stable security definer set search_path = public as $$
  with buck as (   -- finished bucking runs
    select lower(r.strain) k, sum(r.input_lbs) wet,
           sum((select coalesce(sum(p.og_weight), 0) from pallets p where p.run_id = r.id and p.product = 'bucked')) bucked,
           sum((select coalesce(sum(p.og_weight), 0) from pallets p where p.run_id = r.id and p.product = 'trim')) bt, count(*) n
      from proc_runs r where r.status = 'done' and r.kind = 'buck' group by 1),
  bhist as (select lower(strain) k, sum(bucked) bucked, sum(buck_trim) bt from proc_yield_history where bucked > 0 group by 1),
  trim_ as (       -- finished trimming runs + workbook history
    select k, sum(inp) inp, sum(std) std, sum(sml) sml, sum(trm) trm, sum(mold) mold, sum(n) n, sum(h) h from (
      select lower(r.strain) k, r.input_lbs inp,
             (select coalesce(sum(p.og_weight), 0) from pallets p where p.run_id = r.id and p.product = 'standards') std,
             (select coalesce(sum(p.og_weight), 0) from pallets p where p.run_id = r.id and p.product = 'smalls') sml,
             (select coalesce(sum(p.og_weight), 0) from pallets p where p.run_id = r.id and p.product = 'trim') trm, coalesce(r.mold_lbs, 0) mold, 1 n, 0 h
        from proc_runs r where r.status = 'done' and r.kind = 'trim'
      union all
      select lower(strain), standards + smalls + trim_lbs + trim_mold, standards, smalls, trim_lbs, trim_mold, 0, 1 from proc_yield_history where standards > 0) x
     group by 1),
  conv as (select nullif(value, '')::numeric c from app_settings where key = 'proc.dry_default')
  select jsonb_build_object(
    'default_dry', coalesce((select c from conv), 0.2),
    'all', jsonb_build_object(
      'dry', (select case when sum(wet) > 0 then sum(bucked) / sum(wet) end from buck),
      'bt', (select case when sum(b) > 0 then sum(t) / sum(b) end from (select bucked b, bt t from buck union all select bucked, bt from bhist) z),
      'std', (select sum(std) / nullif(sum(inp), 0) from trim_), 'sml', (select sum(sml) / nullif(sum(inp), 0) from trim_),
      'trm', (select sum(trm) / nullif(sum(inp), 0) from trim_), 'mold', (select sum(mold) / nullif(sum(inp), 0) from trim_)),
    'strains', coalesce((select jsonb_object_agg(k, v) from (
      select coalesce(b.k, t.k, bh.k) k, jsonb_build_object(
        'dry', case when b.wet > 0 then b.bucked / b.wet end, 'buck_runs', coalesce(b.n, 0),
        'bt', case when coalesce(b.bucked, 0) + coalesce(bh.bucked, 0) > 0 then (coalesce(b.bt, 0) + coalesce(bh.bt, 0)) / (coalesce(b.bucked, 0) + coalesce(bh.bucked, 0)) end,
        'std', t.std / nullif(t.inp, 0), 'sml', t.sml / nullif(t.inp, 0), 'trm', t.trm / nullif(t.inp, 0), 'mold', t.mold / nullif(t.inp, 0),
        'trim_runs', coalesce(t.n, 0), 'history', coalesce(t.h, 0) > 0 or bh.k is not null) v
        from buck b full join trim_ t on t.k = b.k full join bhist bh on bh.k = coalesce(b.k, t.k)) z), '{}'));
$$;

-- the wet -> bucked default until there are bucking runs (Processing Admins)
create or replace function proc_set_dry_default(p_pct numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform no_view_as();
  if not (is_mod_admin('processing') or is_owner()) then raise exception 'Only a Processing Admin'; end if;
  if p_pct is null or p_pct <= 0 or p_pct >= 1 then raise exception 'Give it as a share between 0 and 1 (20%% = 0.2)'; end if;
  insert into app_settings (key, value) values ('proc.dry_default', p_pct::text) on conflict (key) do update set value = excluded.value;
  insert into events (user_email, type, note) values (current_email(), 'proc_settings', 'wet to bucked default ' || round(p_pct * 100, 1) || '%');
end $$;

-- what a bucked package should give, in lbs of one product
create or replace function proc_forecast_lbs(p_pallet bigint, p_product text) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare p pallets; r jsonb := proc_rates(); s jsonb; f numeric;
begin
  select * into p from pallets where id = p_pallet;
  s := r -> 'strains' -> lower(coalesce(canonical_strain(p.strain), p.strain));
  f := coalesce((s ->> case p_product when 'standards' then 'std' when 'smalls' then 'sml' else 'trm' end)::numeric,
                (r -> 'all' ->> case p_product when 'standards' then 'std' when 'smalls' then 'sml' else 'trm' end)::numeric,
                case p_product when 'standards' then 0.65 when 'smalls' then 0.12 else 0.18 end);
  return round(coalesce(p.current_weight, 0) * f, 1);
end $$;

-- ---------- forecast commitments (from bucked only) ----------
create table if not exists proc_commitments (
  id            bigserial primary key,
  order_line_id int not null references order_lines(id) on delete cascade,
  pallet_id     bigint not null references pallets(id),
  product       text not null check (product in ('standards','smalls','trim')),
  lbs           numeric not null check (lbs > 0),
  status        text not null default 'open' check (status in ('open','filled','cancelled')),
  filled_lbs    numeric,
  created_by    text,
  created_at    timestamptz not null default now(),
  filled_at     timestamptz
);
create index if not exists proc_commitments_pallet_idx on proc_commitments (pallet_id) where status = 'open';
alter table proc_commitments enable row level security;
drop policy if exists read_proc on proc_commitments;
create policy read_proc on proc_commitments for select to authenticated using (is_staff());
grant select on proc_commitments to authenticated;

create or replace function proc_commit_forecast(p_line int, p_pallet bigint, p_lbs numeric) returns proc_commitments
language plpgsql security definer set search_path = public as $$
declare ln order_lines; o orders; p pallets; c proc_commitments; fc numeric; used numeric;
begin
  perform no_view_as();
  if not (can_edit('processing') or can_edit('sales') or can_edit('distribution')) then raise exception 'Not allowed'; end if;
  select * into ln from order_lines where id = p_line;
  select * into o from orders where id = ln.order_id;
  if o.status <> 'pending' then raise exception 'Only confirmed, open orders'; end if;
  if ln.product not in ('standards','smalls','trim') then raise exception 'Forecasts are for standards, smalls and trim lines'; end if;
  select * into p from pallets where id = p_pallet for update;
  if p.product <> 'bucked' then raise exception 'Forecast product can only be committed from bucked packages'; end if;
  if p.status not in ('in_freezer','unslotted') then raise exception '% is %', p.code, replace(p.status, '_', ' '); end if;
  if lower(coalesce(canonical_strain(p.strain), p.strain, '')) <> lower(coalesce(canonical_strain(ln.strain), ln.strain)) then
    raise exception '% is %, this line is %', p.code, p.strain, ln.strain;
  end if;
  if exists (select 1 from order_picks where pallet_id = p.id) then raise exception '% is sold as bucked', p.code; end if;
  fc := proc_forecast_lbs(p.id, ln.product);
  select coalesce(sum(lbs), 0) into used from proc_commitments where pallet_id = p.id and product = ln.product and status = 'open';
  if coalesce(p_lbs, 0) <= 0 then raise exception 'How many lbs?'; end if;
  if p_lbs > fc - used + 0.05 then raise exception '% should give about % lbs of %; % already promised', p.code, fc, product_label(ln.product), used; end if;
  insert into proc_commitments (order_line_id, pallet_id, product, lbs, created_by) values (ln.id, p.id, ln.product, p_lbs, current_email()) returning * into c;
  insert into events (user_email, type, pallet_id, lbs, details)
  values (current_email(), 'proc_promised', p.id, p_lbs, jsonb_build_object('so', o.so_number, 'product', ln.product, 'strain', ln.strain, 'line', ln.id));
  return c;
end $$;

create or replace function proc_uncommit(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare c proc_commitments;
begin
  perform no_view_as();
  if not (can_edit('processing') or can_edit('sales') or can_edit('distribution')) then raise exception 'Not allowed'; end if;
  update proc_commitments set status = 'cancelled' where id = p_id and status = 'open' returning * into c;
  if c.id is not null then
    insert into events (user_email, type, pallet_id, lbs, details) values (current_email(), 'proc_unpromised', c.pallet_id, c.lbs, jsonb_build_object('line', c.order_line_id, 'product', c.product));
  end if;
end $$;

-- after trimming: put the real packages on the promised order lines (oldest promise first; split the last one if needed)
create or replace function _proc_fill_commitments(p_run bigint) returns void
language plpgsql security definer set search_path = public as $$
declare c proc_commitments; o orders; ln order_lines; rem numeric; x pallets; child pallets; left_in numeric;
begin
  for c in select pc.* from proc_commitments pc join proc_run_inputs i on i.pallet_id = pc.pallet_id and i.run_id = p_run
            where pc.status = 'open' order by pc.id for update of pc loop
    select * into ln from order_lines where id = c.order_line_id;
    select * into o from orders where id = ln.order_id;
    if o.status <> 'pending' or o.stop_id is not null then continue; end if;
    rem := c.lbs;
    for x in select * from pallets where run_id = p_run and product = c.product and status in ('in_freezer','unslotted') and coalesce(current_weight, 0) > 0
              and not exists (select 1 from order_picks k where k.pallet_id = pallets.id) order by current_weight desc loop
      exit when rem <= 0.01;
      if x.current_weight <= rem + 0.01 then
        insert into order_picks (order_id, order_line_id, pallet_id, lbs, created_by) values (o.id, ln.id, x.id, x.current_weight, 'forecast promise');
        rem := rem - x.current_weight;
      else
        insert into pallets (code, strain, zone, harvest_date, og_weight, current_weight, tag_pending, parent_id, status, slot_id, received_site, origin_site)
        values (x.code || '-' || (select count(*) + 1 from pallets where parent_id = x.id), x.strain, x.zone, x.harvest_date, rem, rem, true, x.id,
                x.status, x.slot_id, x.received_site, x.origin_site)
        returning * into child;
        update pallets set current_weight = current_weight - rem, updated_at = now() where id = x.id;
        insert into events (user_email, type, pallet_id, lbs, note, details) values (current_email(), 'split', x.id, rem, 'for an order',
               jsonb_build_object('child', child.code, 'child_id', child.id, 'remaining', x.current_weight - rem));
        insert into order_picks (order_id, order_line_id, pallet_id, lbs, created_by) values (o.id, ln.id, child.id, rem, 'forecast promise');
        rem := 0;
      end if;
    end loop;
    -- whatever the package still has left can fill the rest later (partial trims)
    select current_weight into left_in from pallets where id = c.pallet_id;
    if rem > 0.01 and coalesce(left_in, 0) > 0 then
      update proc_commitments set lbs = rem where id = c.id;
    else
      update proc_commitments set status = 'filled', filled_lbs = c.lbs - greatest(rem, 0), filled_at = now() where id = c.id;
    end if;
    insert into events (user_email, type, lbs, details)
    values (current_email(), 'proc_promise_filled', c.lbs - greatest(rem, 0), jsonb_build_object('so', o.so_number, 'product', c.product, 'strain', ln.strain, 'short', greatest(rem, 0)));
  end loop;
end $$;

do $$
declare d text;
begin
  select pg_get_functiondef('proc_finish_run(bigint,jsonb,numeric,text,date)'::regprocedure) into d;
  if d not like '%_proc_fill_commitments%' then
    d := regexp_replace(d, E'  return out;\\s*end\\s*\\$function\\$', E'  perform _proc_fill_commitments(r.id);\n  return out;\nend $function$');
    execute d;
  end if;
  -- a bucked package with forecast promises can't be sold whole as bucked
  select pg_get_functiondef('proc_commit(integer,bigint,numeric,text)'::regprocedure) into d;
  if d not like '%promised from it%' then
    execute replace(d, '  perform _proc_free(p, ''committed'');',
      '  perform _proc_free(p, ''committed'');' || chr(10) ||
      '  if exists (select 1 from proc_commitments where pallet_id = p.id and status = ''open'') then raise exception ''% has forecast standards / smalls / trim promised from it. Trim it, or take the promise off first.'', p.code; end if;');
  end if;
end $$;

-- ---------- Processing screens: lines show what's promised ----------
create or replace function proc_data() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_module('processing') or has_module('sales') or has_module('distribution')) then raise exception 'The Processing module isn''t switched on for your account'; end if;
  return jsonb_build_object(
    'harvests', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'crop_year', h.crop_year, 'site', h.site, 'field', f.name, 'strain', h.strain, 'status', h.status,
          'planned_on', h.planned_on, 'harvested_on', h.harvested_on, 'raw_lbs', coalesce(h.raw_lbs, (select sum(b) from unnest(h.raw_bins) b)),
          'plants', coalesce(h.plants_harvested, h.plants), 'dry_conversion', coalesce(h.dry_conversion, s.dry_conversion)) order by coalesce(h.harvested_on, h.planned_on) desc)
        from cult_harvests h left join fields f on f.id = h.field_id left join sites s on s.code = h.site
       where h.kind = 'dry' and h.status <> 'cancelled' and h.crop_year >= extract(year from current_date)::int - 1), '[]'),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'order_id', o.id, 'so', o.so_number, 'customer_id', o.customer_id, 'customer', c.name,
          'strain', l.strain, 'product', l.product, 'lbs', l.lbs, 'crop_year', l.crop_year, 'wanted', o.wanted_date, 'on_load', o.stop_id is not null,
          'picked', (select coalesce(sum(x.lbs), 0) from order_picks x where x.order_line_id = l.id),
          'promised', (select coalesce(sum(pc.lbs), 0) from proc_commitments pc where pc.order_line_id = l.id and pc.status = 'open')) order by o.wanted_date nulls last, o.id)
        from order_lines l join orders o on o.id = l.order_id join customers c on c.id = o.customer_id
       where o.status = 'pending' and l.product <> 'fresh_frozen' and l.lbs > 0), '[]'),
    'customers', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.name) from customers c where c.active), '[]'),
    'held', coalesce((select jsonb_agg(jsonb_build_object('pallet_id', x.pallet_id, 'so', o.so_number, 'customer', c.name))
        from order_picks x join orders o on o.id = x.order_id join customers c on c.id = o.customer_id
        join pallets p on p.id = x.pallet_id where p.product <> 'fresh_frozen' and o.status = 'pending'), '[]'),
    'promises', coalesce((select jsonb_agg(jsonb_build_object('id', pc.id, 'pallet_id', pc.pallet_id, 'line_id', pc.order_line_id, 'product', pc.product, 'lbs', pc.lbs,
          'so', o.so_number, 'customer', c.name))
        from proc_commitments pc join order_lines l on l.id = pc.order_line_id join orders o on o.id = l.order_id join customers c on c.id = o.customer_id
       where pc.status = 'open'), '[]'),
    'rates', proc_rates());
end $$;

-- labor (piece pay) per strain and crop year, for Yields
create or replace function proc_labor(p_year int default null) returns table(strain text, crop_year int, task text, lbs numeric, hours numeric, pay numeric)
language sql stable security definer set search_path = public as $$
  select coalesce(canonical_strain(x.strain), x.strain), x.crop_year, x.task, sum(x.lbs), sum(x.hours), sum(x.pay)
    from piece_pay x where can_see_pay() and (p_year is null or x.crop_year = p_year) group by 1, 2, 3
$$;

do $$
declare f text;
begin
  foreach f in array array['proc_manifest(bigint[])','proc_rates()','proc_forecast_lbs(bigint,text)','proc_commit_forecast(integer,bigint,numeric)',
    'proc_uncommit(bigint)','proc_data()','proc_labor(integer)','proc_save_processor(jsonb)','proc_set_dry_default(numeric)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  revoke all on function _proc_fill_commitments(bigint) from public, anon, authenticated;
end $$;

select 'yield history' as what, count(*) from proc_yield_history union all select 'processors', count(*) from proc_processors;
