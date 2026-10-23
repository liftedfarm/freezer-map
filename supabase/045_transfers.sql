-- Migration 045: moving product between our licenses, and the farm it was grown at following each package.
--  * Every pallet keeps the farm it was grown at (origin_site: OHR, GVR, or GVR+OHR for a rare package made from both).
--    Splits keep it, merges combine it. Invoices and manifests use it for the batch, not the freezer it shipped from.
--  * A site's freezers sit under one license: the hub license at that site if there is one (GVR processor), else the
--    site's cultivation license (OHR). Set in Admin > Licenses.
--  * A load stop to OHR or GVR is a transfer between licenses. Pallets held for an order can go on it, and stay held.
--  * A pallet received at a site (not in a freezer yet) can go straight onto the next load.
--  * Fulfillment can send an order's pallets to the other site (order_transfer).
--  * stop_manifest(stop): what someone needs to complete the METRC manifest: from/to licenses, transporter, packages.
--  * Fresh frozen invoices are from the license the order shipped from.
-- Run after 042. Safe to re-run.
set client_min_messages = warning;

-- ---------- where it was grown ----------
alter table pallets add column if not exists origin_site text;

create or replace function pallet_origin_guess(p pallets) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select h.site from cult_harvests h where h.id = p.harvest_id),
    (select pp.origin_site from pallets pp where pp.id = p.parent_id),
    (select f.site from fields f where lower(f.name) = lower(trim(p.zone)) limit 1),
    case when p.zone ~* '^\s*(field\s*)?[1-6]\s*(gvr)?\s*$' then 'GVR' when p.zone ~* '^\s*block' then 'OHR' end,
    case when p.code ~ '^G' then 'GVR' when p.code ~ '^[PWT]' then 'OHR' end)
$$;

create or replace function pallet_origin_set() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.origin_site is null and new.kind is distinct from 'mixed' then new.origin_site := pallet_origin_guess(new); end if;
  return new;
end $$;
drop trigger if exists pallet_origin_set on pallets;
create trigger pallet_origin_set before insert on pallets for each row execute function pallet_origin_set();

-- merging packages: the new one carries every farm its sources came from
create or replace function pallet_merge_origin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.merged_into is not null and old.merged_into is distinct from new.merged_into then
    update pallets t set origin_site = (
      select string_agg(distinct x, '+' order by x) from (
        select unnest(string_to_array(coalesce(s.origin_site, ''), '+')) x from pallets s where s.merged_into = t.id
        union select unnest(string_to_array(coalesce(t.origin_site, ''), '+'))) u where x <> '')
     where t.id = new.merged_into;
  end if;
  return new;
end $$;
drop trigger if exists pallet_merge_origin on pallets;
create trigger pallet_merge_origin after update of merged_into on pallets for each row execute function pallet_merge_origin();

-- fill in what's already there (parents first so splits copy them)
do $$
declare n int := 1; k int := 0;
begin
  while n > 0 and k < 10 loop
    update pallets p set origin_site = pallet_origin_guess(p) where p.origin_site is null and p.kind is distinct from 'mixed' and pallet_origin_guess(p) is not null;
    get diagnostics n = row_count; k := k + 1;
  end loop;
end $$;

-- a Distribution Admin can correct it
create or replace function set_pallet_origin(p_pallet bigint, p_site text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_distribution();
  if not is_mod_admin('distribution') then raise exception 'Only a Distribution Admin can change where a package was grown'; end if;
  if upper(coalesce(p_site, '')) not in ('OHR', 'GVR', 'GVR+OHR') then raise exception 'Grown at OHR, GVR or both'; end if;
  update pallets set origin_site = upper(p_site), updated_at = now() where id = p_pallet;
  insert into events (user_email, type, pallet_id, details) values (current_email(), 'origin_set', p_pallet, jsonb_build_object('origin', upper(p_site)));
end $$;
revoke execute on function set_pallet_origin(bigint, text) from public, anon;
grant execute on function set_pallet_origin(bigint, text) to authenticated;

-- ---------- licenses by site ----------
create or replace function site_license(p_site text) returns text
language sql stable security definer set search_path = public as $$
  select license_no from licenses
   where active and upper(site) = upper(p_site) and kind in ('processor', 'distributor', 'cultivation')
   order by hub desc, (kind = 'processor') desc, sort, license_no limit 1
$$;
create or replace function transport_license() returns text
language sql stable security definer set search_path = public as $$
  select license_no from licenses where active and kind in ('transport', 'distributor') order by (kind = 'transport') desc, sort limit 1
$$;
create or replace function pallet_site(p pallets) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select f.site from slots s join freezers f on f.id = s.freezer_id where s.id = coalesce(p.slot_id, (select c.slot_id from pallets c where c.id = p.container_id))),
                  p.received_site)
$$;
grant execute on function site_license(text), transport_license(), pallet_site(pallets) to authenticated;

-- ---------- loads remember where each pallet was picked up ----------
alter table load_items add column if not exists from_site text;
update load_items i set from_site = f.site from slots s join freezers f on f.id = s.freezer_id where s.id = i.from_slot and i.from_site is null;

create or replace function load_pallet(p_item int) returns void
language plpgsql security definer set search_path = public as $$
declare it load_items; l loads; p pallets;
begin
  perform require_staff();
  select * into it from load_items where id = p_item for update;
  if not found then raise exception 'Not found'; end if;
  select * into l from loads where id = it.load_id for update;
  if l.status not in ('planning','loading') then raise exception 'Load % has already left', l.code; end if;
  if it.loaded then raise exception 'Already on the truck'; end if;
  select * into p from pallets where id = it.pallet_id for update;
  update load_items set loaded = true, from_slot = p.slot_id, from_site = pallet_site(p) where id = it.id;
  update pallets set status = 'in_transit', slot_id = null, received_site = null, updated_at = now() where id = p.id or container_id = p.id;
  if l.status = 'planning' then update loads set status = 'loading' where id = l.id; end if;
  insert into events (user_email, type, pallet_id, load_id, from_slot_id, lbs, details)
  values (current_email(), 'loaded', p.id, l.id, p.slot_id, p.current_weight, jsonb_build_object('load', l.code, 'position', it.position, 'site', pallet_site(p)));
end $$;

-- received at a site but not in a freezer yet: can go out on the next load
do $$
declare d text;
begin
  select pg_get_functiondef('plan_pallet(int,int,bigint,int,boolean)'::regprocedure) into d;
  if d like '%isn''''t in a freezer%' then
    execute replace(d, 'if p.status <> ''in_freezer'' then raise exception ''% isn''''t in a freezer'', p.code; end if;',
      'if p.status <> ''in_freezer'' and not (p.status = ''unslotted'' and p.received_site is not null) then raise exception ''% isn''''t in a freezer or received at a site'', p.code; end if;');
  end if;
end $$;

-- holds: a pallet held for an order goes on that customer's stop, or on a transfer to one of our sites
create or replace function check_hold() returns trigger
language plpgsql security definer set search_path = public as $$
declare h record; c customers;
begin
  select o.customer_id, o.so_number, cu.name into h from order_picks x join orders o on o.id = x.order_id join customers cu on cu.id = o.customer_id
   where x.pallet_id = new.pallet_id;
  if h.customer_id is null then return new; end if;
  select cu.* into c from load_stops s join customers cu on cu.id = s.customer_id where s.id = new.stop_id;
  if c.id = h.customer_id or (c.kind = 'internal' and upper(c.name) in ('OHR', 'GVR')) then return new; end if;
  raise exception 'That pallet is held for % (%). It can only go to them or to OHR/GVR. Unassign it in Fulfillment first.', h.name, coalesce(h.so_number, 'order');
end $$;

-- delivery: record which licenses it moved between
do $$
declare d text;
begin
  select pg_get_functiondef('deliver_stop(int)'::regprocedure) into d;
  if d not like '%from_license%' then
    execute replace(d, 'jsonb_build_object(''load'', l.code, ''customer'', c.name, ''manifest'', s.manifest)',
      'jsonb_build_object(''load'', l.code, ''customer'', c.name, ''manifest'', s.manifest, ''from_site'', it.from_site, ''from_license'', site_license(it.from_site), ''to_license'', coalesce(site_license(site), c.license))');
  end if;
end $$;

-- ---------- Fulfillment: send an order's pallets to one of our sites ----------
create or replace function order_transfer(p_order int, p_load int, p_site text) returns int
language plpgsql security definer set search_path = public as $$
declare o orders; l loads; cid int; sid int; pk record; n int := 0; site text := upper(p_site);
begin
  perform require_distribution();
  select * into o from orders where id = p_order;
  if o.id is null then raise exception 'Order not found'; end if;
  if site not in ('OHR', 'GVR') then raise exception 'Send to OHR or GVR'; end if;
  select * into l from loads where id = p_load for update;
  if l.id is null then raise exception 'Load not found'; end if;
  if l.status not in ('planning', 'loading') then raise exception 'Load % has already left', l.code; end if;
  select id into cid from customers where kind = 'internal' and upper(name) = site limit 1;
  select id into sid from load_stops where load_id = l.id and customer_id = cid and status = 'pending' order by seq limit 1;
  if sid is null then
    insert into load_stops (load_id, seq, customer_id) values (l.id, coalesce((select max(seq) from load_stops where load_id = l.id), 0) + 1, cid) returning id into sid;
  end if;
  for pk in select p.id from order_picks x join pallets p on p.id = x.pallet_id
             where x.order_id = o.id and p.container_id is null and coalesce(pallet_site(p), '') <> site and p.status in ('in_freezer', 'unslotted') order by p.code loop
    if pallet_open_load(pk.id) is null then perform plan_pallet(l.id, sid, pk.id); n := n + 1; end if;
  end loop;
  if n = 0 then raise exception 'Nothing to send: every pallet on this order is at % or already on a load', site; end if;
  perform arrange_load(l.id);
  insert into events (user_email, type, load_id, details)
  values (current_email(), 'fulfill_transfer', l.id, jsonb_build_object('load', l.code, 'order_id', o.id, 'so', o.so_number, 'to', site, 'pallets', n));
  return n;
end $$;
create or replace function order_transfer_new(p_order int, p_vehicle int, p_date date, p_site text) returns int
language plpgsql security definer set search_path = public as $$
declare l loads; cid int;
begin
  perform require_distribution();
  select id into cid from customers where kind = 'internal' and upper(name) = upper(p_site) limit 1;
  if cid is null then raise exception 'Send to OHR or GVR'; end if;
  l := create_load(p_vehicle, p_date, jsonb_build_array(jsonb_build_object('customer_id', cid)), null, 'Transfer for an order');
  return order_transfer(p_order, l.id, p_site);
end $$;
revoke execute on function order_transfer(int, int, text), order_transfer_new(int, int, date, text) from public, anon;
grant execute on function order_transfer(int, int, text), order_transfer_new(int, int, date, text) to authenticated;

-- ---------- the manifest sheet ----------
create or replace function _lic(p_no text) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when l.license_no is null then null else jsonb_build_object('license', l.license_no, 'kind', l.kind, 'entity', l.entity, 'dba', l.dba,
    'site', l.site, 'premises', l.premises, 'address', l.address, 'phone', l.phone) end
    from (select 1) one left join licenses l on l.license_no = p_no
$$;

create or replace function stop_manifest(p_stop int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s load_stops; l loads; c customers; v vehicles; site text; froms text[]; pk jsonb;
begin
  perform require_staff();
  select * into s from load_stops where id = p_stop;
  if s.id is null then raise exception 'Stop not found'; end if;
  select * into l from loads where id = s.load_id;
  select * into c from customers where id = s.customer_id;
  select * into v from vehicles where id = l.vehicle_id;
  site := case when c.kind = 'internal' and upper(c.name) in ('OHR', 'GVR') then upper(c.name) end;
  -- each package (a mixed pallet is several packages); where it's coming from
  select coalesce(jsonb_agg(jsonb_build_object('pallet', x.top, 'code', x.code, 'tag', x.package_tag, 'tag_pending', x.tag_pending, 'strain', x.strain,
           'origin', x.origin_site, 'from', x.from_site, 'lbs', x.current_weight, 'crop_year', x.yr, 'harvested', x.harvest_date,
           'batch', batch_name(x.yr, split_part(coalesce(x.origin_site, x.from_site), '+', 1), x.strain)) order by x.from_site, x.strain, x.code), '[]'::jsonb),
         array_agg(distinct x.from_site) filter (where x.from_site is not null)
    into pk, froms
    from (select t.code as top, p.code, p.package_tag, p.tag_pending, p.strain, p.origin_site, p.current_weight, p.harvest_date,
                 coalesce(extract(year from p.harvest_date)::int, extract(year from now())::int) as yr,
                 coalesce(i.from_site, pallet_site(t)) as from_site
            from load_items i join pallets t on t.id = i.pallet_id
            join pallets p on ((p.id = t.id and t.kind is distinct from 'mixed') or (p.container_id = t.id and t.kind = 'mixed'))
           where i.stop_id = s.id) x;
  return jsonb_build_object(
    'load', l.code, 'load_date', l.load_date, 'status', l.status, 'driver', l.driver, 'vehicle', v.name, 'plate', v.plate,
    'stop', s.seq, 'stop_status', s.status, 'manifest', s.manifest, 'transfer', site is not null,
    'from', (select coalesce(jsonb_agg(_lic(site_license(f)) || jsonb_build_object('from_site', f)), '[]'::jsonb) from unnest(coalesce(froms, '{}')) f),
    'to', case when site is not null then _lic(site_license(site)) || jsonb_build_object('name', c.name)
               else jsonb_build_object('name', coalesce(c.legal_name, c.name), 'license', c.license, 'address', coalesce(c.ship_to_address, c.address), 'contact', c.receiving_contact) end,
    'transporter', _lic(transport_license()),
    'orders', (select coalesce(jsonb_agg(coalesce(o.so_number, 'Order #' || o.id) || ' ' || cu.name order by o.id), '[]'::jsonb) from orders o join customers cu on cu.id = o.customer_id
                where o.stop_id = s.id or exists (select 1 from order_picks x join load_items i on i.pallet_id = x.pallet_id where x.order_id = o.id and i.stop_id = s.id)),
    'packages', pk);
end $$;
revoke execute on function stop_manifest(int) from public, anon;
grant execute on function stop_manifest(int) to authenticated;

-- ---------- invoices: from the license it shipped from; batch from the farm it was grown at ----------
create or replace function order_ship_license(p_order int) returns text
language sql stable security definer set search_path = public as $$
  select site_license(st) from (
    select coalesce(i.from_site, pallet_site(p)) st, count(*) n
      from orders o join order_picks x on x.order_id = o.id join pallets p on p.id = x.pallet_id
      left join load_items i on i.pallet_id = p.id and i.stop_id = o.stop_id
     where o.id = p_order group by 1 order by 2 desc limit 1) z
  where st is not null
$$;
create or replace function invoice_seller_default() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.seller_license is null and new.order_id is not null and new.nursery_order_id is null then
    new.seller_license := order_ship_license(new.order_id);
  end if;
  return new;
end $$;
drop trigger if exists invoice_seller_default on invoices;
create trigger invoice_seller_default before insert on invoices for each row execute function invoice_seller_default();

do $$
declare d text;
begin
  select pg_get_functiondef('_make_invoice(int)'::regprocedure) into d;
  if d like '%coalesce(f.site, f2.site, p.received_site%' then
    execute replace(d, 'coalesce(f.site, f2.site, p.received_site,', 'coalesce(split_part(p.origin_site, ''+'', 1), f.site, f2.site, p.received_site,');
  end if;
end $$;

select (select count(*) from pallets where origin_site is null and kind is distinct from 'mixed') as packages_without_a_farm,
       (select string_agg(site || ' freezers: ' || coalesce(site_license(site), 'no license'), ' · ') from (values ('OHR'), ('GVR')) v(site)) as site_licenses;
