-- Migration 025: Fulfillment. Confirmed orders get pallets assigned in Distribution, then go on a load and ship.
-- Run once in Supabase after 024_module_roles.sql: SQL Editor > New query > paste > Run. Safe to re-run.
--
--  * Any Distribution user assigns pallets to an order's lines (whole pallets, or split off part of one).
--    An assigned pallet is held: it can't go on another order or onto another customer's load.
--  * If what's assigned to a line isn't exactly what was ordered, Sales has to OK it. The OK changes the
--    line to the assigned lbs (the original amount is kept in ordered_lbs).
--  * When every line matches, the order is Ready and can be put on a load (a stop for that customer).
--  * Delivering that stop marks the order Shipped.
set client_min_messages = warning;

alter table orders add column if not exists stop_id int references load_stops(id) on delete set null;
alter table order_lines add column if not exists ordered_lbs numeric;   -- what the customer first ordered, once Sales OKs a different fill
alter table order_lines add column if not exists cant_fill boolean not null default false;  -- Distribution: nothing to send for this line

create table if not exists order_picks (
  id            serial primary key,
  order_id      int not null references orders(id) on delete cascade,
  order_line_id int not null references order_lines(id) on delete cascade,
  pallet_id     bigint not null references pallets(id) on delete cascade,
  lbs           numeric not null,
  created_by    text,
  created_at    timestamptz not null default now(),
  unique (pallet_id)
);
create index if not exists order_picks_order_idx on order_picks (order_id);
alter table order_picks enable row level security;
drop policy if exists read_picks on order_picks;
create policy read_picks on order_picks for select to authenticated using (is_staff());
grant select on order_picks to authenticated;

-- ---------- helpers ----------
create or replace function require_distribution() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_staff();
  if mod_level('distribution') is null then raise exception 'You need the Distribution module to fulfill orders'; end if;
end $$;

-- open (not ready), needs_ok (Sales has to OK a fill), ready, loaded, shipped, cancelled
create or replace function order_state(p_order int) returns text
language sql stable security definer set search_path = public as $$
  with o as (select * from orders where id = p_order),
       l as (select ol.id, ol.lbs, ol.cant_fill, coalesce((select sum(p.lbs) from order_picks p where p.order_line_id = ol.id), 0) as got
               from order_lines ol where ol.order_id = p_order and ol.lbs > 0)
  select case
    when (select status from o) = 'shipped' then 'shipped'
    when (select status from o) = 'cancelled' then 'cancelled'
    when (select status from o) <> 'pending' then (select status from o)
    when (select stop_id from o) is not null then 'loaded'
    when not exists (select 1 from l) then 'open'
    when exists (select 1 from l where got = 0 and not cant_fill) then 'open'
    when exists (select 1 from l where got <> lbs) then 'needs_ok'
    else 'ready' end
$$;

create or replace function pick_event(p_type text, p_order int, p_pallet bigint, p_lbs numeric, p_extra jsonb default '{}') returns void
language sql security definer set search_path = public as $$
  insert into events (user_email, type, pallet_id, lbs, details)
  select current_email(), p_type, p_pallet, p_lbs,
         jsonb_build_object('order_id', o.id, 'so', o.so_number, 'customer', c.name) || coalesce(p_extra, '{}')
    from orders o join customers c on c.id = o.customer_id where o.id = p_order
$$;

-- ---------- assign pallets ----------
create or replace function pick_pallet(p_line int, p_pallet bigint) returns order_picks
language plpgsql security definer set search_path = public as $$
declare ln order_lines; o orders; p pallets; pk order_picks; other text;
begin
  perform require_distribution();
  select * into ln from order_lines where id = p_line;
  if ln.id is null then raise exception 'Order line not found'; end if;
  select * into o from orders where id = ln.order_id for update;
  if o.status <> 'pending' then raise exception 'Only confirmed, open orders can be fulfilled'; end if;
  if o.stop_id is not null then raise exception 'This order is on a load. Take it off the load to change its pallets.'; end if;
  select * into p from pallets where id = p_pallet for update;
  if p.id is null then raise exception 'Pallet not found'; end if;
  if p.status <> 'in_freezer' then raise exception '% isn''t in a freezer', p.code; end if;
  if p.container_id is not null then raise exception '% is on a mixed pallet. Take it off first.', p.code; end if;
  if p.kind = 'mixed' then raise exception '% is a mixed pallet. Assign its packages instead.', p.code; end if;
  if lower(coalesce(canonical_strain(p.strain), p.strain, '')) <> lower(coalesce(canonical_strain(ln.strain), ln.strain)) then
    raise exception '% is %, this line is %', p.code, coalesce(p.strain, 'no strain'), ln.strain;
  end if;
  select coalesce(o2.so_number, c.name) into other from order_picks x join orders o2 on o2.id = x.order_id join customers c on c.id = o2.customer_id where x.pallet_id = p.id;
  if other is not null then raise exception '% is already held for %', p.code, other; end if;
  other := pallet_open_load(p.id);
  if other is not null then raise exception '% is already on load %', p.code, other; end if;
  insert into order_picks (order_id, order_line_id, pallet_id, lbs, created_by)
  values (o.id, ln.id, p.id, coalesce(p.current_weight, 0), current_email()) returning * into pk;
  perform pick_event('fulfill_assigned', o.id, p.id, pk.lbs, jsonb_build_object('strain', ln.strain));
  return pk;
end $$;

-- split part of a pallet off for this order: the new piece is what's assigned (the crew splits it at pick time)
create or replace function pick_part(p_line int, p_pallet bigint, p_lbs numeric, p_tag text default null, p_tag_pending boolean default true)
returns order_picks
language plpgsql security definer set search_path = public as $$
declare child pallets;
begin
  perform require_distribution();
  if exists (select 1 from order_picks where pallet_id = p_pallet) then raise exception 'That pallet is held for another order'; end if;
  child := split_pallet(p_pallet, p_lbs, p_tag, p_tag is null or p_tag_pending, null, 'for an order', true);
  return pick_pallet(p_line, child.id);
end $$;

-- nothing to send for a line (none in the freezers): Sales has to OK shipping without it
create or replace function cant_fill(p_line int, p_on boolean default true) returns void
language plpgsql security definer set search_path = public as $$
declare ln order_lines; o orders;
begin
  perform require_distribution();
  select * into ln from order_lines where id = p_line;
  select * into o from orders where id = ln.order_id;
  if o.status <> 'pending' or o.stop_id is not null then raise exception 'Only open orders that aren''t on a load'; end if;
  if p_on and exists (select 1 from order_picks where order_line_id = ln.id) then raise exception 'Unassign its pallets first'; end if;
  update order_lines set cant_fill = p_on, updated_at = now() where id = ln.id;
  perform pick_event(case when p_on then 'fulfill_cant_fill' else 'fulfill_can_fill' end, o.id, null, ln.lbs, jsonb_build_object('strain', ln.strain));
end $$;

create or replace function unpick(p_pick int) returns void
language plpgsql security definer set search_path = public as $$
declare pk order_picks; o orders;
begin
  perform require_distribution();
  select * into pk from order_picks where id = p_pick;
  if pk.id is null then return; end if;
  select * into o from orders where id = pk.order_id;
  if o.stop_id is not null then raise exception 'This order is on a load. Take it off the load first.'; end if;
  delete from order_picks where id = pk.id;
  perform pick_event('fulfill_unassigned', o.id, pk.pallet_id, pk.lbs);
end $$;

-- Sales OKs a fill that isn't exactly what was ordered: the line becomes what's assigned
create or replace function approve_fill(p_order int, p_note text default null) returns int
language plpgsql security definer set search_path = public as $$
declare o orders; r record; n int := 0;
begin
  perform no_view_as();
  if not is_sales() then raise exception 'Only Sales can OK a different amount'; end if;
  select * into o from orders where id = p_order for update;
  if o.status <> 'pending' then raise exception 'Only open orders'; end if;
  for r in select ol.id, ol.lbs, ol.ordered_lbs, ol.strain, ol.cant_fill, coalesce((select sum(p.lbs) from order_picks p where p.order_line_id = ol.id), 0) as got
             from order_lines ol where ol.order_id = o.id and ol.lbs > 0 loop
    if (r.got > 0 or r.cant_fill) and r.got <> r.lbs then
      update order_lines set ordered_lbs = coalesce(ordered_lbs, lbs), lbs = r.got, cant_fill = false, updated_at = now() where id = r.id;
      insert into events (user_email, type, note, details)
      values (current_email(), 'order_fill_ok', p_note, jsonb_build_object('order_id', o.id, 'so', o.so_number, 'strain', r.strain,
              'from', r.lbs, 'to', r.got, 'customer', (select name from customers where id = o.customer_id)));
      n := n + 1;
    end if;
  end loop;
  update orders set updated_at = now() where id = o.id;
  return n;
end $$;

-- ---------- loads ----------
create or replace function order_to_load(p_order int, p_load int) returns void
language plpgsql security definer set search_path = public as $$
declare o orders; l loads; sid int; pk record; st text;
begin
  perform require_distribution();
  select * into o from orders where id = p_order for update;
  st := order_state(o.id);
  if st = 'loaded' then raise exception 'This order is already on a load'; end if;
  if st = 'needs_ok' then raise exception 'Some lines don''t match what was ordered. Sales has to OK them first.'; end if;
  if st <> 'ready' then raise exception 'Assign pallets to every line first'; end if;
  select * into l from loads where id = p_load for update;
  if l.id is null then raise exception 'Load not found'; end if;
  if l.status not in ('planning','loading') then raise exception 'Load % has already left', l.code; end if;
  select id into sid from load_stops where load_id = l.id and customer_id = o.customer_id and status = 'pending' order by seq limit 1;
  if sid is null then
    insert into load_stops (load_id, seq, customer_id)
    values (l.id, coalesce((select max(seq) from load_stops where load_id = l.id), 0) + 1, o.customer_id) returning id into sid;
  end if;
  update orders set stop_id = sid, updated_at = now() where id = o.id;
  for pk in select x.pallet_id from order_picks x where x.order_id = o.id order by x.id loop
    if not exists (select 1 from load_items where load_id = l.id and pallet_id = pk.pallet_id) then
      perform plan_pallet(l.id, sid, pk.pallet_id);
    end if;
  end loop;
  insert into events (user_email, type, load_id, details)
  values (current_email(), 'fulfill_loaded', l.id, jsonb_build_object('load', l.code, 'order_id', o.id, 'so', o.so_number,
          'customer', (select name from customers where id = o.customer_id)));
end $$;

create or replace function order_off_load(p_order int) returns void
language plpgsql security definer set search_path = public as $$
declare o orders; s load_stops; l loads;
begin
  perform require_distribution();
  select * into o from orders where id = p_order for update;
  if o.stop_id is null then return; end if;
  select * into s from load_stops where id = o.stop_id;
  select * into l from loads where id = s.load_id;
  if l.status not in ('planning','loading') then raise exception 'Load % has already left', l.code; end if;
  if exists (select 1 from load_items i join order_picks x on x.pallet_id = i.pallet_id where x.order_id = o.id and i.stop_id = s.id and i.loaded) then
    raise exception 'Some of its pallets are already on the truck. Put them back first.';
  end if;
  delete from load_items i using order_picks x where x.pallet_id = i.pallet_id and x.order_id = o.id and i.stop_id = s.id;
  update orders set stop_id = null, updated_at = now() where id = o.id;
  if not exists (select 1 from load_items where stop_id = s.id) and not exists (select 1 from orders where stop_id = s.id)
     and (select count(*) from load_stops where load_id = l.id) > 1 then
    delete from load_stops where id = s.id;
  end if;
  insert into events (user_email, type, load_id, details)
  values (current_email(), 'fulfill_unloaded', l.id, jsonb_build_object('load', l.code, 'order_id', o.id, 'so', o.so_number));
end $$;

-- holds: a pallet held for an order only goes on that order's customer stop
create or replace function check_hold() returns trigger
language plpgsql security definer set search_path = public as $$
declare h record;
begin
  select o.customer_id, o.so_number, c.name into h from order_picks x join orders o on o.id = x.order_id join customers c on c.id = o.customer_id
   where x.pallet_id = new.pallet_id;
  if h.customer_id is not null and h.customer_id <> (select customer_id from load_stops where id = new.stop_id) then
    raise exception 'That pallet is held for % (%). Unassign it in Fulfillment first.', h.name, coalesce(h.so_number, 'order');
  end if;
  return new;
end $$;
drop trigger if exists check_hold on load_items;
create trigger check_hold before insert or update of stop_id on load_items for each row execute function check_hold();

-- weights follow the pallet; gone pallets drop out
create or replace function pick_follow_pallet() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('merged','depleted','archived') or new.container_id is not null then
    delete from order_picks where pallet_id = new.id and order_id in (select id from orders where status = 'pending');
  elsif new.current_weight is distinct from old.current_weight and new.status = 'in_freezer' then
    update order_picks set lbs = coalesce(new.current_weight, 0) where pallet_id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists pick_follow_pallet on pallets;
create trigger pick_follow_pallet after update of current_weight, status, container_id on pallets for each row execute function pick_follow_pallet();

-- delivered stop: its orders are shipped
create or replace function ship_orders_on_delivery() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'delivered' and old.status <> 'delivered' then
    update orders set status = 'shipped', shipped_date = coalesce(shipped_date, current_date), updated_at = now()
     where stop_id = new.id and status = 'pending';
  end if;
  return new;
end $$;
drop trigger if exists ship_orders_on_delivery on load_stops;
create trigger ship_orders_on_delivery after update of status on load_stops for each row execute function ship_orders_on_delivery();

-- cancelled order: let its pallets go
create or replace function release_on_cancel() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    delete from load_items i using order_picks x where x.pallet_id = i.pallet_id and x.order_id = new.id and not i.loaded and i.stop_id = new.stop_id;
    delete from order_picks where order_id = new.id;
    new.stop_id := null;
  end if;
  return new;
end $$;
drop trigger if exists release_on_cancel on orders;
create trigger release_on_cancel before update of status on orders for each row execute function release_on_cancel();

-- ---------- the queue (no prices, so Crew can see it) ----------
create or replace function fulfillment_orders(p_days int default 14) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_staff();
  if mod_level('distribution') is null and mod_level('sales') is null then raise exception 'Not allowed'; end if;
  return coalesce((select jsonb_agg(x order by x->>'sort', (x->>'id')::int) from (
    select jsonb_build_object(
      'id', o.id, 'so', o.so_number, 'po', o.po_number, 'customer_id', o.customer_id, 'customer', c.name, 'status', o.status,
      'state', order_state(o.id), 'source', o.source, 'order_date', o.order_date, 'wanted_date', o.wanted_date, 'shipped_date', o.shipped_date,
      'notes', o.notes, 'sort', coalesce(o.wanted_date::text, o.order_date::text, '9999'),
      'stop', case when o.stop_id is not null then (select jsonb_build_object('id', s.id, 'load_id', l.id, 'load', l.code, 'load_status', l.status, 'load_date', l.load_date, 'stop_status', s.status)
                                                 from load_stops s join loads l on l.id = s.load_id where s.id = o.stop_id) end,
      'lines', coalesce((select jsonb_agg(jsonb_build_object('id', ol.id, 'strain', ol.strain, 'lbs', ol.lbs, 'ordered_lbs', ol.ordered_lbs, 'crop_year', ol.crop_year, 'cant_fill', ol.cant_fill,
          'picks', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'pallet_id', x.pallet_id, 'lbs', x.lbs, 'code', p.code, 'tag', p.package_tag,
               'tag_pending', p.tag_pending, 'slot_id', p.slot_id) order by x.id)
             from order_picks x join pallets p on p.id = x.pallet_id where x.order_line_id = ol.id), '[]')) order by ol.strain)
        from order_lines ol where ol.order_id = o.id and ol.lbs > 0), '[]')) as x
    from orders o join customers c on c.id = o.customer_id
   where o.status = 'pending' or (o.status = 'shipped' and o.stop_id is not null and o.shipped_date >= current_date - p_days)
  ) t), '[]');
end $$;

revoke execute on function require_distribution(), order_state(int), pick_event(text, int, bigint, numeric, jsonb), pick_pallet(int, bigint),
  pick_part(int, bigint, numeric, text, boolean), unpick(int), approve_fill(int, text), order_to_load(int, int), order_off_load(int),
  fulfillment_orders(int), cant_fill(int, boolean) from public, anon;
grant execute on function order_state(int), pick_pallet(int, bigint), pick_part(int, bigint, numeric, text, boolean), unpick(int),
  approve_fill(int, text), order_to_load(int, int), order_off_load(int), fulfillment_orders(int), cant_fill(int, boolean) to authenticated;

select 'ok' as fulfillment;
