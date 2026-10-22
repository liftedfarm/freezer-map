-- Migration 028: licenses, and the Nursery module (mothers, cutting batches, clone orders, deliveries, invoices from the nursery).
-- Run once in Supabase after 027_sales_docs.sql: SQL Editor > New query > paste > Run. Safe to re-run.
--
--  * Licenses: every state license (premises) is on one list (Admin > Settings > Licenses). Sites, freezers, nursery sites
--    and METRC tag ranges each belong to a license. OHR freezers = OHR cultivation license; GVR freezers = the GVR processor.
--  * Nursery module (new; Admin > Users gives people Nursery as User or Admin):
--      Mothers   one row per mother plant (METRC plant tag), by strain and room
--      Batches   cuttings taken (strain, date, count, METRC tags), rooting > ready > done, losses
--      Orders    the clone deliveries Production plans (Production > Plan > Nursery deliveries, nursery "1PN") show up here,
--                plus orders for outside farms. Confirming gives an SO number.
--      Deliver   pick the batches, enter the manifest: makes the invoice (from the nursery's entity, e.g. 1PN, LLC)
--                and, for our own farms, the "plants received" row in Production.
set client_min_messages = warning;

-- ---------- licenses ----------
create table if not exists licenses (
  license_no  text primary key,
  kind        text not null check (kind in ('cultivation','processor','nursery','distributor','transport','manufacturer','retail','other')),
  tier        text,                 -- Large outdoor, Type 13 transport only…
  entity      text not null,        -- legal name on invoices and manifests
  dba         text,
  site        text,                 -- OHR, GVR, 1PN (null for a license with no premises of its own, like transport)
  premises    text,                 -- premises name
  address     text,
  email       text,
  phone       text,
  remit       text,                 -- how to pay (invoices from this license)
  hub         boolean not null default false,   -- distribution hub (loads from other sites go here)
  expires     date,
  active      boolean not null default true,
  notes       text,
  sort        int not null default 0,
  updated_at  timestamptz not null default now()
);
alter table licenses enable row level security;
drop policy if exists read_lic on licenses;
create policy read_lic on licenses for select to authenticated using (is_staff());
grant select on licenses to authenticated;

insert into licenses (license_no, kind, tier, entity, dba, site, premises, hub, sort, notes) values
  ('CCL25-0000017', 'cultivation', 'Large', 'DNA Organics, Inc.', 'Lifted Farms', 'OHR', 'Oak Hill Ranch', false, 1, 'All cultivation, material storage and distribution from OHR'),
  ('CCL25-0000175', 'cultivation', 'Large', 'DNA Organics, Inc.', 'Lifted Farms', 'GVR', 'Green Valley Ranch', false, 2, 'All GVR cultivation'),
  ('CCL21-0000679', 'processor',   null,    'DNA Organics, Inc.', 'Lifted Farms', 'GVR', 'Green Valley Ranch', true,  3, 'Hub for distribution of material from both sites; holds all GVR freezers'),
  ('C13-0000310-LIC', 'transport', 'Type 13 transport only', 'DNA Organics, Inc.', 'Lifted Farms', null, null, false, 4, 'Moves product between licensed premises only'),
  ('CCL24-0000156', 'nursery',     null,    '1PN, LLC', null, '1PN', '1PN', false, 5, 'Mother plants and cuttings delivered to the farms')
on conflict (license_no) do nothing;
update licenses set address = '361 Webb Rd' || chr(10) || 'Watsonville, CA' where license_no = 'CCL24-0000156' and address is null;

create or replace function save_license(p jsonb) returns licenses
language plpgsql security definer set search_path = public as $$
declare l licenses; no text := upper(trim(p ->> 'license_no')); was jsonb;
begin
  perform no_view_as();
  if not is_admin() then raise exception 'Only someone with the Admin module can change licenses'; end if;
  if coalesce(no, '') = '' then raise exception 'Enter the license number'; end if;
  if coalesce(trim(p ->> 'entity'), '') = '' then raise exception 'Enter the legal entity'; end if;
  select to_jsonb(x) into was from licenses x where license_no = no;
  insert into licenses (license_no, kind, tier, entity, dba, site, premises, address, email, phone, remit, hub, expires, active, notes, sort)
  values (no, coalesce(p ->> 'kind', 'other'), nullif(trim(p ->> 'tier'), ''), trim(p ->> 'entity'), nullif(trim(p ->> 'dba'), ''),
          nullif(upper(trim(p ->> 'site')), ''), nullif(trim(p ->> 'premises'), ''), nullif(trim(p ->> 'address'), ''), nullif(trim(p ->> 'email'), ''),
          nullif(trim(p ->> 'phone'), ''), nullif(trim(p ->> 'remit'), ''), coalesce((p ->> 'hub')::boolean, false), nullif(p ->> 'expires', '')::date,
          coalesce((p ->> 'active')::boolean, true), nullif(trim(p ->> 'notes'), ''), coalesce((p ->> 'sort')::int, 99))
  on conflict (license_no) do update set kind = excluded.kind, tier = excluded.tier, entity = excluded.entity, dba = excluded.dba, site = excluded.site,
    premises = excluded.premises, address = excluded.address, email = excluded.email, phone = excluded.phone, remit = excluded.remit, hub = excluded.hub,
    expires = excluded.expires, active = excluded.active, notes = excluded.notes, updated_at = now()
  returning * into l;
  insert into events (user_email, type, note, details) values (current_email(), 'license_saved', no, jsonb_build_object('license', to_jsonb(l), 'was', was));
  return l;
end $$;

-- freezers belong to a license (OHR: the OHR cultivation license; GVR: the processor)
alter table freezers add column if not exists license text references licenses(license_no);
update freezers set license = case site when 'OHR' then 'CCL25-0000017' else 'CCL21-0000679' end where license is null;
create or replace function freezer_license() returns trigger
language plpgsql as $$
begin
  if new.license is null then new.license := case new.site when 'OHR' then 'CCL25-0000017' when 'GVR' then 'CCL21-0000679' end; end if;
  return new;
end $$;
drop trigger if exists freezer_license on freezers;
create trigger freezer_license before insert on freezers for each row execute function freezer_license();

create or replace function set_freezer_license(p_freezer int, p_license text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform no_view_as();
  if not is_admin() then raise exception 'Only someone with the Admin module can change licenses'; end if;
  update freezers set license = p_license where id = p_freezer;
  insert into events (user_email, type, freezer_id, note) values (current_email(), 'license_freezer', p_freezer, p_license);
end $$;

-- METRC tags are issued per license: tag ranges carry their license; nursery sites can have ranges too
alter table tag_ranges add column if not exists license text references licenses(license_no);
alter table tag_ranges drop constraint if exists tag_ranges_site_check;
update tag_ranges t set license = s.license from sites s where s.code = t.site and t.license is null;

create or replace function save_tag_range(p jsonb) returns tag_ranges
language plpgsql security definer set search_path = public as $$
declare r tag_ranges; lic licenses; f text := upper(trim(p ->> 'first')); l text := upper(trim(p ->> 'last')); pre text; i int := 0;
begin
  perform no_view_as();
  if not (is_admin() or is_mod_admin('nursery')) then raise exception 'Only an Admin can add tag ranges'; end if;
  select * into lic from licenses where license_no = p ->> 'license';
  if lic.license_no is null then raise exception 'Pick the license the tags were issued to'; end if;
  if lic.kind = 'nursery' and not is_admin() and not is_mod_admin('nursery') then raise exception 'Not allowed'; end if;
  if lic.kind <> 'nursery' and not is_admin() then raise exception 'Only someone with the Admin module can add these tags'; end if;
  if (p ->> 'id') is not null then
    update tag_ranges set active = coalesce((p ->> 'active')::boolean, active), notes = coalesce(nullif(trim(p ->> 'notes'), ''), notes), purpose = coalesce(nullif(p ->> 'purpose', ''), purpose)
     where id = (p ->> 'id')::int returning * into r;
  else
    if f is null or l is null or length(f) <> length(l) then raise exception 'Enter the first and last tag (same length)'; end if;
    -- shared start, then the counting digits
    while i < length(f) and substr(f, i + 1, 1) = substr(l, i + 1, 1) loop i := i + 1; end loop;
    pre := left(f, i);
    if substr(f, i + 1) !~ '^[0-9]+$' or substr(l, i + 1) !~ '^[0-9]+$' then raise exception 'The tags should differ only in their last digits'; end if;
    insert into tag_ranges (site, purpose, prefix, first_n, last_n, digits, notes, license)
    values (coalesce(lic.site, 'ANY'), coalesce(nullif(p ->> 'purpose', ''), case lic.kind when 'nursery' then 'plant' else 'mixed' end), pre,
            substr(f, i + 1)::bigint, substr(l, i + 1)::bigint, length(f) - i, nullif(trim(p ->> 'notes'), ''), lic.license_no)
    returning * into r;
  end if;
  insert into events (user_email, type, note, details) values (current_email(), 'license_tags', lic.license_no, to_jsonb(r));
  return r;
end $$;

-- ---------- Nursery module: who has it ----------
alter table module_access drop constraint if exists module_access_module_check;
alter table module_access add constraint module_access_module_check check (module in ('distribution','sales','cultivation','nursery','admin'));

create or replace function is_any_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(mod_level('distribution') = 'admin', false) or coalesce(mod_level('sales') = 'admin', false)
      or coalesce(mod_level('cultivation') = 'admin', false) or coalesce(mod_level('nursery') = 'admin', false) or mod_level('admin') is not null
$$;
create or replace function my_modules() returns text[]
language sql stable security definer set search_path = public as $$
  select case when not coalesce(is_staff(), false) then '{}'
              when coalesce((select owner from app_users where email = jwt_email()), false) then array['distribution','sales','cultivation','nursery','admin']
              else coalesce((select array_agg(module order by module) from module_access where email = jwt_email()), '{}') end
$$;
create or replace function my_access() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'owner', is_owner(),
    'modules', coalesce((select jsonb_object_agg(m, mod_level(m)) from unnest(array['distribution','sales','cultivation','nursery','admin']) m where mod_level(m) is not null), '{}'),
    'prefs', coalesce((select prefs from app_users where email = jwt_email()), '{}'))
$$;

-- save_user: same as 024, with Nursery allowed
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
      if m not in ('distribution','sales','cultivation','nursery','admin') then raise exception 'Unknown module %', m; end if;
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

-- ---------- nursery sites and rooms ----------
create table if not exists nursery_sites (
  code     text primary key,
  name     text not null,
  license  text references licenses(license_no),
  address  text,
  active   boolean not null default true,
  sort     int not null default 0
);
insert into nursery_sites (code, name, license, sort) values ('1PN', '1PN', 'CCL24-0000156', 1) on conflict (code) do nothing;

create table if not exists nursery_rooms (
  id      serial primary key,
  site    text not null references nursery_sites(code) on update cascade,
  name    text not null,
  kind    text not null default 'clone' check (kind in ('mother','clone','veg','other')),
  active  boolean not null default true,
  notes   text,
  sort    int not null default 0,
  unique (site, name)
);
insert into nursery_rooms (site, name, kind, sort) values ('1PN', 'Mother room', 'mother', 1), ('1PN', 'Clone room', 'clone', 2) on conflict do nothing;

-- one row per mother plant
create table if not exists nursery_mothers (
  id          bigserial primary key,
  site        text not null references nursery_sites(code) on update cascade,
  room_id     int references nursery_rooms(id) on delete set null,
  strain      text not null,
  plant_tag   text unique,
  started_on  date,
  status      text not null default 'active' check (status in ('active','retired','destroyed')),
  ended_on    date,
  notes       text,
  created_by  text default current_email(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists nursery_mothers_strain_idx on nursery_mothers (site, strain);

-- the clone orders: Production's nursery deliveries (cult_nursery_orders) plus orders for outside farms
alter table cult_nursery_orders add column if not exists nursery_site text references nursery_sites(code) on update cascade;
alter table cult_nursery_orders add column if not exists customer_id int references customers(id);
alter table cult_nursery_orders add column if not exists price_each numeric;
alter table cult_nursery_orders add column if not exists so_number text;
alter table cult_nursery_orders add column if not exists po_number text;
alter table cult_nursery_orders add column if not exists payment_terms text references payment_terms(code);
alter table cult_nursery_orders add column if not exists share_token uuid not null default gen_random_uuid();
alter table cult_nursery_orders add column if not exists confirmed_by text;
alter table cult_nursery_orders add column if not exists confirmed_at timestamptz;
alter table cult_nursery_orders alter column site drop not null;      -- outside farms have a customer, not one of our sites
alter table cult_nursery_orders drop constraint if exists cult_nursery_orders_where;
alter table cult_nursery_orders add constraint cult_nursery_orders_where check (site is not null or customer_id is not null);
create unique index if not exists cult_nursery_orders_so_idx on cult_nursery_orders (so_number);
create index if not exists cult_nursery_orders_ns_idx on cult_nursery_orders (nursery_site, status);

-- cuttings taken
create table if not exists nursery_batches (
  id          bigserial primary key,
  site        text not null references nursery_sites(code) on update cascade,
  room_id     int references nursery_rooms(id) on delete set null,
  strain      text not null,
  name        text,                       -- METRC plant batch name
  order_id    bigint references cult_nursery_orders(id) on delete set null,   -- cut for this order (optional)
  cut_on      date not null default current_date,
  cuttings    int not null check (cuttings > 0),
  lost        int not null default 0 check (lost >= 0),
  ready_on    date,                       -- expected, then actual
  stage       text not null default 'rooting' check (stage in ('rooting','ready','done','cancelled')),
  tags        text[] not null default '{}',   -- METRC tags on the batch (one per 100 immature plants)
  notes       text,
  created_by  text default current_email(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists nursery_batches_stage_idx on nursery_batches (site, stage);

create table if not exists nursery_deliveries (
  id            bigserial primary key,
  ref           uuid not null,                      -- one delivery can use several batches
  order_id      bigint not null references cult_nursery_orders(id) on delete cascade,
  batch_id      bigint references nursery_batches(id) on delete set null,
  delivered_on  date not null default current_date,
  plants        int not null check (plants > 0),
  manifest      text,
  notes         text,
  invoice_id    int references invoices(id) on delete set null,
  receipt_id    bigint references cult_receipts(id) on delete set null,
  created_by    text default current_email(),
  created_at    timestamptz not null default now()
);
create index if not exists nursery_deliveries_order_idx on nursery_deliveries (order_id);
create index if not exists nursery_deliveries_batch_idx on nursery_deliveries (batch_id);

-- strain names through the Strains list, like Production
do $$
declare t text;
begin
  foreach t in array array['nursery_mothers','nursery_batches'] loop
    execute format('drop trigger if exists %I on %I', t || '_strain', t);
    execute format('create trigger %I before insert or update of strain on %I for each row execute function cult_strain_name()', t || '_strain', t);
  end loop;
end $$;

-- ---------- who sees and changes what ----------
-- read: anyone with Nursery. Mothers and batches: Nursery users edit. Sites and rooms: Nursery Admins.
do $$
declare t text;
begin
  foreach t in array array['nursery_sites','nursery_rooms','nursery_mothers','nursery_batches','nursery_deliveries'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists n_read on %I', t);
    execute format('drop policy if exists n_add on %I', t);
    execute format('drop policy if exists n_edit on %I', t);
    execute format('drop policy if exists n_delete on %I', t);
    execute format('create policy n_read on %I for select to authenticated using (has_module(''nursery'') or has_module(''cultivation'') or is_admin())', t);
    execute format('grant select on %I to authenticated', t);
  end loop;
  foreach t in array array['nursery_mothers','nursery_batches'] loop
    execute format('create policy n_add on %I for insert to authenticated with check (has_module(''nursery'') and not impersonating())', t);
    execute format('create policy n_edit on %I for update to authenticated using (has_module(''nursery'')) with check (has_module(''nursery'') and not impersonating())', t);
    execute format('create policy n_delete on %I for delete to authenticated using (has_module(''nursery'') and not impersonating())', t);
    execute format('grant insert, update, delete on %I to authenticated', t);
    execute format('grant usage on sequence %I to authenticated', t || '_id_seq');
  end loop;
  foreach t in array array['nursery_sites','nursery_rooms'] loop
    execute format('create policy n_add on %I for insert to authenticated with check (is_mod_admin(''nursery'') and not impersonating())', t);
    execute format('create policy n_edit on %I for update to authenticated using (is_mod_admin(''nursery'')) with check (is_mod_admin(''nursery'') and not impersonating())', t);
    execute format('grant insert, update on %I to authenticated', t);
  end loop;
  execute 'grant usage on sequence nursery_rooms_id_seq to authenticated';
end $$;

-- the nursery reads its orders (Production keeps its own access to the same table)
drop policy if exists n_read on cult_nursery_orders;
create policy n_read on cult_nursery_orders for select to authenticated using (has_module('nursery') and nursery_site is not null);
drop policy if exists n_read_receipts on cult_receipts;

-- changes to mothers, batches and rooms go in Activity
create or replace function nursery_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare r jsonb := to_jsonb(coalesce(new, old)); w jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
begin
  if tg_op = 'UPDATE' then new.updated_at := now(); r := to_jsonb(new); end if;
  if tg_op = 'UPDATE' and (r - 'updated_at') = (w - 'updated_at') then return new; end if;
  insert into events (user_email, type, note, details)
  values (current_email(), 'nursery_' || replace(tg_table_name, 'nursery_', '') || '_' || lower(tg_op),
          r ->> 'strain', jsonb_build_object('row', r, 'was', w));
  return coalesce(new, old);
end $$;
do $$
declare t text;
begin
  foreach t in array array['nursery_mothers','nursery_batches'] loop
    execute format('drop trigger if exists %I on %I', t || '_audit', t);
    execute format('create trigger %I before insert or update or delete on %I for each row execute function nursery_audit()', t || '_audit', t);
  end loop;
end $$;

-- ---------- SO numbers across sales orders and clone orders ----------
create or replace function next_so(p_date date) returns text
language sql volatile security definer set search_path = public as $$
  select 'SO-' || to_char(p_date, 'YYMMDD') || lpad((coalesce(max(substring(n from 10 for 2)::int), 0) + 1)::text, 2, '0')
    from (select so_number n from orders union all select so_number from cult_nursery_orders) x
   where n ~ ('^SO-' || to_char(p_date, 'YYMMDD') || '[0-9]{2}$')
$$;

-- which nursery an order is for (Production types "1PN" in Nursery), who it bills, its SO number once confirmed
create or replace function nursery_order_fill() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.nursery_site is null and nullif(trim(new.nursery), '') is not null then
    select code into new.nursery_site from nursery_sites where lower(code) = lower(trim(new.nursery)) or lower(name) = lower(trim(new.nursery)) limit 1;
  end if;
  if new.nursery_site is not null then
    if nullif(trim(new.nursery), '') is null then new.nursery := new.nursery_site; end if;
    if new.customer_id is null and new.site is not null then
      select id into new.customer_id from customers where kind = 'internal' and upper(name) = upper(new.site) limit 1;
    end if;
    if new.status in ('confirmed','received') and nullif(trim(new.so_number), '') is null
       and (tg_op = 'INSERT' or old.status is distinct from new.status) then
      new.so_number := next_so(current_date);
      new.confirmed_by := coalesce(new.confirmed_by, current_email()); new.confirmed_at := coalesce(new.confirmed_at, now());
    end if;
  end if;
  if new.crop_year is null then new.crop_year := coalesce(extract(year from new.deliver_on)::int, crop_year()); end if;
  return new;
end $$;
drop trigger if exists nursery_order_fill on cult_nursery_orders;
create trigger nursery_order_fill before insert or update on cult_nursery_orders for each row execute function nursery_order_fill();

-- existing orders typed "1PN": point them at the nursery (quietly; no SO numbers for old deliveries)
alter table cult_nursery_orders disable trigger cult_nursery_orders_audit;
update cult_nursery_orders o set nursery_site = s.code from nursery_sites s
 where o.nursery_site is null and (lower(trim(o.nursery)) = lower(s.code) or lower(trim(o.nursery)) = lower(s.name));
alter table cult_nursery_orders enable trigger cult_nursery_orders_audit;

-- our own farms on clone invoices
update customers set legal_name = 'DNA Organics, Inc. - Oak Hill Ranch' where kind = 'internal' and upper(name) = 'OHR' and legal_name is null;
update customers set legal_name = 'DNA Organics, Inc. - Green Valley Ranch' where kind = 'internal' and upper(name) = 'GVR' and legal_name is null;
update customers set license = 'CCL25-0000017' where kind = 'internal' and upper(name) = 'OHR' and license is null;
update customers set license = 'CCL25-0000175' where kind = 'internal' and upper(name) = 'GVR' and license is null;

-- ---------- nursery settings ----------
create or replace function set_nursery_setting(p_key text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
declare was text;
begin
  perform no_view_as();
  if not is_mod_admin('nursery') then raise exception 'Only a Nursery Admin can change Nursery settings'; end if;
  if p_key not in ('nursery.clone_price','nursery.terms','nursery.root_days','nursery.ready_warn_days') then raise exception 'Unknown setting %', p_key; end if;
  if p_key in ('nursery.clone_price','nursery.root_days','nursery.ready_warn_days') and p_value !~ '^\d+(\.\d+)?$' then raise exception 'Enter a number'; end if;
  select value into was from app_settings where key = p_key;
  insert into app_settings values (p_key, coalesce(p_value, '')) on conflict (key) do update set value = excluded.value;
  insert into events (user_email, type, note, details) values (current_email(), 'nursery_setting', p_key, jsonb_build_object('key', p_key, 'value', p_value, 'was', was));
end $$;
create or replace function nursery_setting(p_key text, p_default text) returns text
language sql stable security definer set search_path = public as $$ select coalesce((select value from app_settings where key = p_key), p_default) $$;

-- ---------- orders (from the nursery side) ----------
-- p: {id?, nursery_site, site? (OHR/GVR) or customer_id, strain, plants, cut_on, deliver_on, price_each, po_number, payment_terms, notes}
create or replace function nursery_save_order(p jsonb) returns cult_nursery_orders
language plpgsql security definer set search_path = public as $$
declare o cult_nursery_orders; cust customers; s text := nullif(upper(trim(p ->> 'site')), '');
begin
  perform no_view_as();
  if not has_module('nursery') then raise exception 'The Nursery module isn''t switched on for your account'; end if;
  if coalesce(trim(p ->> 'strain'), '') = '' then raise exception 'Enter the strain'; end if;
  if coalesce((p ->> 'plants')::int, 0) <= 0 then raise exception 'Enter how many plants'; end if;
  if s is null and (p ->> 'customer_id') is null then raise exception 'Pick the farm'; end if;
  if s is null then
    select * into cust from customers where id = (p ->> 'customer_id')::int;
    if cust.kind = 'internal' and exists (select 1 from sites where code = upper(cust.name)) then s := upper(cust.name); end if;
  end if;
  if (p ->> 'id') is null then
    insert into cult_nursery_orders (crop_year, site, strain, nursery_site, nursery, customer_id, plants, cut_on, deliver_on, plant_on, status, notes, price_each, po_number, payment_terms)
    values (coalesce(extract(year from nullif(p ->> 'deliver_on', '')::date)::int, crop_year()), s, trim(p ->> 'strain'),
            coalesce(nullif(p ->> 'nursery_site', ''), (select code from nursery_sites where active order by sort limit 1)),
            coalesce(nullif(p ->> 'nursery_site', ''), (select code from nursery_sites where active order by sort limit 1)),
            case when s is null then (p ->> 'customer_id')::int end, (p ->> 'plants')::int,
            nullif(p ->> 'cut_on', '')::date, nullif(p ->> 'deliver_on', '')::date, nullif(p ->> 'plant_on', '')::date,
            coalesce(nullif(p ->> 'status', ''), 'confirmed'), nullif(trim(p ->> 'notes'), ''), nullif(p ->> 'price_each', '')::numeric,
            nullif(trim(p ->> 'po_number'), ''), nullif(p ->> 'payment_terms', ''))
    returning * into o;
  else
    update cult_nursery_orders set strain = trim(p ->> 'strain'), plants = (p ->> 'plants')::int,
           site = s, customer_id = case when s is null then (p ->> 'customer_id')::int end,
           cut_on = nullif(p ->> 'cut_on', '')::date, deliver_on = nullif(p ->> 'deliver_on', '')::date,
           notes = nullif(trim(p ->> 'notes'), ''), price_each = nullif(p ->> 'price_each', '')::numeric,
           po_number = nullif(trim(p ->> 'po_number'), ''), payment_terms = nullif(p ->> 'payment_terms', ''),
           updated_by = current_email(), updated_at = now()
     where id = (p ->> 'id')::bigint and nursery_site is not null
    returning * into o;
    if o.id is null then raise exception 'Order not found'; end if;
  end if;
  insert into events (user_email, type, note, details)
  values (current_email(), case when (p ->> 'id') is null then 'nursery_order_new' else 'nursery_order_edit' end, o.strain,
          jsonb_build_object('order_id', o.id, 'so', o.so_number, 'plants', o.plants, 'site', o.site, 'customer_id', o.customer_id, 'deliver_on', o.deliver_on));
  return o;
end $$;

create or replace function nursery_order_status(p_order bigint, p_status text, p_note text default null) returns cult_nursery_orders
language plpgsql security definer set search_path = public as $$
declare o cult_nursery_orders;
begin
  perform no_view_as();
  if not has_module('nursery') then raise exception 'The Nursery module isn''t switched on for your account'; end if;
  if p_status not in ('ordered','confirmed','received','cancelled') then raise exception 'Unknown status'; end if;
  if p_status = 'cancelled' and exists (select 1 from nursery_deliveries where order_id = p_order) then raise exception 'Some plants were already delivered on this order'; end if;
  update cult_nursery_orders set status = p_status, updated_by = current_email(), updated_at = now()
   where id = p_order and nursery_site is not null returning * into o;
  if o.id is null then raise exception 'Order not found'; end if;
  insert into events (user_email, type, note, details)
  values (current_email(), 'nursery_order_' || p_status, coalesce(p_note, o.strain), jsonb_build_object('order_id', o.id, 'so', o.so_number, 'plants', o.plants));
  return o;
end $$;

-- ---------- deliver: batches out, invoice from the nursery, plants received at our farm ----------
-- p_lines: [{"batch": 12, "plants": 100}, …] (batch may be null for plants not tracked by batch)
create or replace function nursery_deliver(p_order bigint, p_lines jsonb, p_date date default null, p_manifest text default null, p_notes text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o cult_nursery_orders; ns nursery_sites; c customers; ln jsonb; b nursery_batches; n int; tot int := 0; v_ref uuid := gen_random_uuid();
        d date := coalesce(p_date, current_date); rc cult_receipts; i invoices; il invoice_lines; num text; avail int; done int;
begin
  perform no_view_as();
  if not has_module('nursery') then raise exception 'The Nursery module isn''t switched on for your account'; end if;
  select * into o from cult_nursery_orders where id = p_order and nursery_site is not null for update;
  if o.id is null then raise exception 'Order not found'; end if;
  if o.status = 'cancelled' then raise exception 'That order is cancelled'; end if;
  select * into ns from nursery_sites where code = o.nursery_site;
  for ln in select * from jsonb_array_elements(coalesce(p_lines, '[]')) loop
    n := coalesce((ln ->> 'plants')::int, 0);
    if n <= 0 then continue; end if;
    if (ln ->> 'batch') is not null then
      select * into b from nursery_batches where id = (ln ->> 'batch')::bigint for update;
      if b.id is null then raise exception 'Batch not found'; end if;
      avail := b.cuttings - b.lost - coalesce((select sum(plants) from nursery_deliveries where batch_id = b.id), 0);
      if n > avail then raise exception 'Batch % only has % plants left', coalesce(b.name, '#' || b.id), avail; end if;
    end if;
    insert into nursery_deliveries (ref, order_id, batch_id, delivered_on, plants, manifest, notes)
    values (v_ref, o.id, (ln ->> 'batch')::bigint, d, n, nullif(trim(p_manifest), ''), nullif(trim(p_notes), ''));
    tot := tot + n;
    if (ln ->> 'batch') is not null then
      update nursery_batches set stage = 'done' where id = b.id and cuttings - lost - coalesce((select sum(plants) from nursery_deliveries where batch_id = b.id), 0) <= 0;
    end if;
  end loop;
  if tot = 0 then raise exception 'Enter how many plants went out'; end if;

  -- an SO number if it never got one
  if o.so_number is null then update cult_nursery_orders set so_number = next_so(d) where id = o.id returning * into o; end if;

  -- our own farm: Production sees the plants received
  if o.site is not null then
    insert into cult_receipts (crop_year, site, strain, batch, nursery, source, order_id, received_on, received, notes)
    values (o.crop_year, o.site, o.strain, coalesce((select max(batch) + 1 from cult_receipts where crop_year = o.crop_year and site = o.site and strain = o.strain), 1),
            o.nursery_site, 'clone', o.id, d, tot, concat_ws(' · ', 'Delivered by ' || o.nursery_site, 'manifest ' || nullif(trim(p_manifest), '')))
    returning * into rc;
    update nursery_deliveries set receipt_id = rc.id where nursery_deliveries.ref = v_ref;
  end if;

  -- the invoice, from the nursery's license entity
  select * into c from customers where id = o.customer_id;
  if c.id is not null then
    num := 'INV-' || regexp_replace(o.so_number, '^SO-', '');
    if exists (select 1 from invoices where inv_number = num) then
      num := num || '-' || ((select count(*) from invoices where inv_number like num || '%') + 1);
    end if;
    insert into invoices (inv_number, order_id, customer_id, invoice_date, terms_code, po_number, notes, seller_license, nursery_order_id)
    values (num, null, c.id, d, coalesce(o.payment_terms, nursery_setting('nursery.terms', 'COD')), o.po_number, null, ns.license, o.id)
    returning * into i;
    insert into invoice_lines (invoice_id, sort, kind, item, description, strain, qty, uom, price)
    values (i.id, 1, 'product', 'Clones', o.strain || ' - Rooted Clone', o.strain, tot, 'ea',
            coalesce(o.price_each, nursery_setting('nursery.clone_price', '5')::numeric))
    returning * into il;
    insert into invoice_packages (invoice_line_id, package_tag, lbs, batch)
    select il.id, nullif(array_to_string(nb.tags, ', '), ''), x.plants, coalesce(nb.name, 'Batch ' || nb.id)
      from nursery_deliveries x join nursery_batches nb on nb.id = x.batch_id where x.ref = v_ref order by nb.id;
    i := recompute_invoice(i.id);
    update nursery_deliveries set invoice_id = i.id where nursery_deliveries.ref = v_ref;
  end if;

  select coalesce(sum(plants), 0) into done from nursery_deliveries where order_id = o.id;
  update cult_nursery_orders set status = case when done >= plants then 'received' else 'confirmed' end, updated_by = current_email(), updated_at = now() where id = o.id;
  insert into events (user_email, type, note, details)
  values (current_email(), 'nursery_delivered', o.strain, jsonb_build_object('order_id', o.id, 'so', o.so_number, 'plants', tot, 'site', o.site, 'customer', c.name,
          'manifest', p_manifest, 'invoice', i.inv_number, 'invoice_id', i.id, 'ref', v_ref));
  return jsonb_build_object('ref', v_ref, 'plants', tot, 'invoice_id', i.id, 'invoice', i.inv_number, 'so', o.so_number);
end $$;

-- take back a delivery entered by mistake (its invoice is voided; the plants received row in Production goes too)
create or replace function nursery_undo_delivery(p_ref uuid) returns void
language plpgsql security definer set search_path = public as $$
declare x record;
begin
  perform no_view_as();
  if not is_mod_admin('nursery') then raise exception 'Only a Nursery Admin can take back a delivery'; end if;
  select min(order_id) order_id, min(invoice_id) invoice_id, min(receipt_id) receipt_id, sum(plants) plants into x from nursery_deliveries where ref = p_ref;
  if x.order_id is null then raise exception 'Delivery not found'; end if;
  if exists (select 1 from invoices where id = x.invoice_id and acct_status = 'sent') then raise exception 'Its invoice is already in accounting. Fix it there first.'; end if;
  update invoices set status = 'void', notes = concat_ws(E'\n', notes, 'Delivery taken back'), updated_at = now() where id = x.invoice_id;
  delete from nursery_deliveries where ref = p_ref;
  delete from cult_receipts where id = x.receipt_id;
  update nursery_batches b set stage = 'ready' where stage = 'done' and b.cuttings - b.lost > coalesce((select sum(plants) from nursery_deliveries where batch_id = b.id), 0);
  update cult_nursery_orders set status = 'confirmed', updated_at = now() where id = x.order_id and status = 'received';
  insert into events (user_email, type, details) values (current_email(), 'nursery_delivery_undone', jsonb_build_object('order_id', x.order_id, 'plants', x.plants, 'invoice_id', x.invoice_id));
end $$;

-- next unused plant tags for a nursery (ranges for its license, purpose 'plant')
create or replace function nursery_next_tags(p_site text, p_count int default 10) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare out text[];
begin
  if not has_module('nursery') then raise exception 'Not allowed'; end if;
  select array_agg(t order by r_id, n) into out from (
    select r.prefix || lpad(g::text, r.digits, '0') as t, g as n, r.id r_id
      from tag_ranges r join nursery_sites s on s.code = p_site and r.license = s.license
     cross join lateral generate_series(r.first_n, r.last_n) g
     where r.active and r.purpose = 'plant'
       and not exists (select 1 from nursery_mothers m where m.plant_tag = r.prefix || lpad(g::text, r.digits, '0'))
       and not exists (select 1 from nursery_batches b where (r.prefix || lpad(g::text, r.digits, '0')) = any(b.tags))
     order by r.id, g limit greatest(least(p_count, 500), 1)) x;
  return coalesce(out, '{}');
end $$;

-- ---------- invoices from a license other than DNA Organics ----------
alter table invoices add column if not exists seller_license text references licenses(license_no);
alter table invoices add column if not exists nursery_order_id bigint references cult_nursery_orders(id) on delete set null;

drop policy if exists read_inv on invoices; drop policy if exists read_inv on invoice_lines; drop policy if exists read_inv on invoice_packages;
create or replace function can_see_invoice(p_inv int) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from invoices i where i.id = p_inv and (is_sales() or (i.nursery_order_id is not null and has_module('nursery'))
                                                                  or (i.customer_id = my_customer() and i.status <> 'void')))
$$;
create policy read_inv on invoices for select to authenticated using (is_sales() or (nursery_order_id is not null and has_module('nursery')) or (customer_id = my_customer() and status <> 'void'));
create policy read_inv on invoice_lines for select to authenticated using (can_see_invoice(invoice_id));
create policy read_inv on invoice_packages for select to authenticated using (exists (select 1 from invoice_lines l where l.id = invoice_line_id and can_see_invoice(l.invoice_id)));

-- who can change an invoice: Sales; for clone invoices, the Nursery too
create or replace function _can_bill(p_inv int) returns boolean
language sql stable security definer set search_path = public as $$
  select is_sales() or exists (select 1 from invoices where id = p_inv and nursery_order_id is not null and has_module('nursery'))
$$;
create or replace function _inv_editable(p_inv int) returns invoices
language plpgsql security definer set search_path = public as $$
declare i invoices;
begin
  perform no_view_as();
  if not _can_bill(p_inv) then raise exception 'Only Sales can change invoices'; end if;
  select * into i from invoices where id = p_inv for update;
  if i.id is null then raise exception 'Invoice not found'; end if;
  if i.status = 'void' then raise exception 'That invoice is void'; end if;
  if i.acct_status = 'sent' then raise exception '% is already in accounting. Change it there.', i.inv_number; end if;
  return i;
end $$;
create or replace function set_invoice_status(p_inv int, p_status text, p_note text default null) returns invoices
language plpgsql security definer set search_path = public as $$
declare i invoices;
begin
  perform no_view_as();
  if not _can_bill(p_inv) then raise exception 'Only Sales'; end if;
  if p_status not in ('open','paid','void') then raise exception 'Unknown status'; end if;
  select * into i from invoices where id = p_inv;
  if p_status = 'void' and not (is_sales_admin() or (i.nursery_order_id is not null and is_mod_admin('nursery'))) then raise exception 'Only an Admin can void an invoice'; end if;
  update invoices set status = p_status, paid_at = case when p_status = 'paid' then coalesce(paid_at, current_date) else null end,
         notes = case when nullif(trim(p_note), '') is null then notes else concat_ws(E'\n', notes, trim(p_note)) end, updated_at = now()
   where id = p_inv returning * into i;
  insert into events (user_email, type, note, details)
  values (current_email(), case when i.nursery_order_id is not null then 'nursery_invoice_' else 'invoice_' end || p_status, p_note,
          jsonb_build_object('invoice_id', i.id, 'inv', i.inv_number, 'total', i.total));
  return i;
end $$;
create or replace function mark_invoice_sent(p_inv int, p_to text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform no_view_as();
  if not _can_bill(p_inv) then raise exception 'Only Sales'; end if;
  update invoices set sent_at = now(), updated_at = now() where id = p_inv;
  insert into events (user_email, type, details)
  values (current_email(), case when (select nursery_order_id from invoices where id = p_inv) is not null then 'nursery_invoice_sent' else 'invoice_sent' end,
          jsonb_build_object('invoice_id', p_inv, 'inv', (select inv_number from invoices where id = p_inv), 'to', p_to));
end $$;

-- the seller block on documents: DNA Organics (App settings) unless the invoice is from another license
create or replace function _seller(p_license text) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when l.license_no is null then _company()
    else _company() || jsonb_build_object('web', '') || jsonb_strip_nulls(jsonb_build_object('legal', l.entity || coalesce(' (dba ' || l.dba || ')', ''), 'address', l.address, 'email', l.email, 'phone', l.phone,
         'license', l.license_no,
         'remit', coalesce(l.remit, 'Check payable to: ' || l.entity || '. We accept ACH, wire transfer, cash, and check.'))) end
    from (select 1) one left join licenses l on l.license_no = p_license
$$;

create or replace function _doc(p_kind text, p_id int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o orders; i invoices; t payment_terms; n cult_nursery_orders; seller text;
begin
  if p_kind = 'invoice' then
    select * into i from invoices where id = p_id;
    if i.id is null then return null; end if;
    select * into o from orders where id = i.order_id;
    select * into n from cult_nursery_orders where id = i.nursery_order_id;
    return jsonb_build_object('kind', 'invoice', 'id', i.id, 'number', i.inv_number, 'so', coalesce(o.so_number, n.so_number), 'po', coalesce(i.po_number, o.po_number, n.po_number),
      'date', i.invoice_date, 'due', i.due_date, 'terms', i.terms_label, 'terms_code', i.terms_code, 'schedule', i.schedule, 'total', i.total, 'status', i.status,
      'ship_date', coalesce(o.shipped_date, (select max(delivered_on) from nursery_deliveries where invoice_id = i.id)), 'notes', i.notes, 'token', i.share_token,
      'acct_status', i.acct_status, 'sent_at', i.sent_at, 'nursery', i.nursery_order_id is not null,
      'company', _seller(i.seller_license), 'customer', _customer_doc(i.customer_id),
      'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'kind', l.kind, 'item', l.item, 'description', l.description, 'strain', l.strain, 'crop_year', l.crop_year,
          'qty', l.qty, 'uom', l.uom, 'price', l.price, 'amount', l.amount,
          'packages', coalesce((select jsonb_agg(jsonb_build_object('tag', p.package_tag, 'pallet', p.pallet_code, 'lbs', p.lbs, 'batch', p.batch) order by p.id) from invoice_packages p where p.invoice_line_id = l.id), '[]'))
          order by l.sort, l.id) from invoice_lines l where l.invoice_id = i.id), '[]'));
  elsif p_kind = 'nso' then
    select * into n from cult_nursery_orders where id = p_id and nursery_site is not null;
    if n.id is null then return null; end if;
    select * into t from payment_terms where code = coalesce(n.payment_terms, nursery_setting('nursery.terms', 'COD'));
    select license into seller from nursery_sites where code = n.nursery_site;
    return jsonb_build_object('kind', 'so', 'id', n.id, 'number', coalesce(n.so_number, 'Clone order #' || n.id), 'so', n.so_number, 'po', n.po_number,
      'date', coalesce(n.confirmed_at::date, n.updated_at::date), 'wanted', n.deliver_on, 'terms', t.label, 'terms_code', t.code, 'status', n.status, 'notes', n.notes,
      'token', n.share_token, 'nursery', true, 'company', _seller(seller), 'customer', _customer_doc(n.customer_id),
      'total', round(n.plants * coalesce(n.price_each, nursery_setting('nursery.clone_price', '5')::numeric), 2),
      'lines', jsonb_build_array(jsonb_build_object('id', n.id, 'kind', 'product', 'item', 'Clones', 'description', n.strain || ' - Rooted Clone', 'strain', n.strain, 'crop_year', null,
          'qty', n.plants, 'uom', 'ea', 'price', coalesce(n.price_each, nursery_setting('nursery.clone_price', '5')::numeric),
          'amount', round(n.plants * coalesce(n.price_each, nursery_setting('nursery.clone_price', '5')::numeric), 2), 'packages', '[]'::jsonb)));
  else
    select * into o from orders where id = p_id;
    if o.id is null then return null; end if;
    select * into t from payment_terms where code = coalesce(o.payment_terms, (select payment_terms from customers where id = o.customer_id), 'RECEIPT');
    return jsonb_build_object('kind', 'so', 'id', o.id, 'number', coalesce(o.so_number, 'Order #' || o.id), 'so', o.so_number, 'po', o.po_number,
      'date', o.order_date, 'wanted', o.wanted_date, 'terms', t.label, 'terms_code', t.code, 'status', o.status, 'notes', o.notes, 'token', o.share_token,
      'company', _company(), 'customer', _customer_doc(o.customer_id),
      'total', (select coalesce(sum(round(lbs * coalesce(price_per_lb, 0), 2)), 0) from order_lines where order_id = o.id and lbs > 0),
      'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'kind', 'product', 'item', 'Fresh Frozen - ' || l.crop_year, 'description', l.strain || ' - Fresh Frozen',
          'strain', l.strain, 'crop_year', l.crop_year, 'qty', l.lbs, 'uom', 'lb', 'price', coalesce(l.price_per_lb, 0), 'amount', round(l.lbs * coalesce(l.price_per_lb, 0), 2), 'packages', '[]'::jsonb)
          order by l.crop_year desc, l.strain) from order_lines l where l.order_id = o.id and l.lbs > 0), '[]'));
  end if;
end $$;

create or replace function get_doc(p_kind text, p_id int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare cust int;
begin
  if p_kind = 'invoice' then
    if not can_see_invoice(p_id) then raise exception 'Not allowed'; end if;
  elsif p_kind = 'nso' then
    if not (has_module('nursery') or is_sales()) then raise exception 'Not allowed'; end if;
  else
    select customer_id into cust from orders where id = p_id;
    if not (is_sales() or (cust is not null and cust = my_customer())) then raise exception 'Not allowed'; end if;
  end if;
  return _doc(p_kind, p_id);
end $$;

create or replace function get_shared_doc(p_token uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare iid int; oid int; nid bigint;
begin
  select id into iid from invoices where share_token = p_token and status <> 'void';
  if iid is not null then return _doc('invoice', iid); end if;
  select id into oid from orders where share_token = p_token and status not in ('draft','cancelled');
  if oid is not null then return _doc('so', oid); end if;
  select id into nid from cult_nursery_orders where share_token = p_token and nursery_site is not null and status <> 'cancelled';
  if nid is not null then return _doc('nso', nid::int); end if;
  return null;
end $$;

-- bill-to / ship-to on documents: our own farms fall back to their license's premises address
create or replace function _customer_doc(p_customer int) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', c.id, 'name', c.name, 'legal_name', c.legal_name, 'license', c.license, 'kind', c.kind,
    'billing_address', coalesce(c.billing_address, c.address, l.address), 'billing_contact', coalesce(c.billing_contact, c.contact), 'billing_email', c.billing_email, 'billing_phone', c.billing_phone,
    'ship_to_name', coalesce(c.ship_to_name, c.legal_name, c.name), 'ship_to_address', coalesce(c.ship_to_address, c.address, l.address), 'receiving_contact', c.receiving_contact,
    'terms', c.payment_terms)
    from customers c left join licenses l on l.license_no = c.license where c.id = p_customer
$$;

-- ---------- permissions ----------
revoke execute on function nursery_order_fill(), nursery_audit(), freezer_license(), _seller(text), _can_bill(int), nursery_setting(text, text) from public, anon, authenticated;
revoke execute on function save_license(jsonb), set_freezer_license(int, text), save_tag_range(jsonb), set_nursery_setting(text, text), nursery_save_order(jsonb),
  nursery_order_status(bigint, text, text), nursery_deliver(bigint, jsonb, date, text, text), nursery_undo_delivery(uuid), nursery_next_tags(text, int), can_see_invoice(int) from public, anon;
grant execute on function save_license(jsonb), set_freezer_license(int, text), save_tag_range(jsonb), set_nursery_setting(text, text), nursery_save_order(jsonb),
  nursery_order_status(bigint, text, text), nursery_deliver(bigint, jsonb, date, text, text), nursery_undo_delivery(uuid), nursery_next_tags(text, int), can_see_invoice(int) to authenticated;
grant execute on function get_shared_doc(uuid) to anon, authenticated;

select 'ok' as licenses_nursery,
       (select count(*) from licenses) as licenses,
       (select count(*) from cult_nursery_orders where nursery_site is not null) as nursery_orders;
