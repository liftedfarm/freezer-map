-- Migration 012: customers order from the portal; per-customer price; Sales confirms, edits and ships orders.
-- Run once in Supabase after 011_reserve_requests.sql: SQL Editor > New query > paste > Run. Safe to re-run.
--
--  * A customer orders by strain and lbs. Each line can use their reserve plus whatever is open on the menu.
--  * The order comes in as "submitted" and holds the lbs right away (counts as pending everywhere).
--  * Sales or Admin confirm it (optionally with the Roshi SO #), edit lbs or override the price on a line,
--    cancel it, or mark it shipped. A later Roshi import with that SO # updates the same order, no copies.
--  * Price per lb is set per customer (Settings > Customers) and copied onto each line when ordered.
set client_min_messages = warning;

-- ---------- customer terms ----------
alter table customers add column if not exists price_per_lb numeric;
alter table customers add column if not exists contract_lbs numeric;
alter table customers add column if not exists monthly_min_lbs numeric;
alter table customers add column if not exists deposit_usd numeric;
alter table customers add column if not exists storage_fee numeric;

-- crew's customer-names view keeps the same columns
create or replace view customer_names with (security_barrier) as
  select id, name, kind, active from customers where is_staff();

-- ---------- order statuses ----------
alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check check (status in ('draft','submitted','pending','shipped','cancelled'));
alter table orders add column if not exists po_number text;
alter table orders add column if not exists wanted_date date;
alter table orders add column if not exists placed_by text;
alter table orders add column if not exists confirmed_by text;
alter table orders add column if not exists confirmed_at timestamptz;
alter table orders add column if not exists notified_at timestamptz;

-- submitted orders count as pending in balances and on the menu
create or replace view reserve_balances with (security_invoker = true) as
  with sold as (
    select o.customer_id, l.strain,
           sum(l.lbs) filter (where o.status = 'shipped') as shipped,
           sum(l.lbs) filter (where o.status in ('pending','submitted')) as pending
      from orders o join order_lines l on l.order_id = o.id
     where l.product = 'fresh_frozen' group by 1, 2)
  select r.id, r.customer_id, r.strain, r.lbs as reserved,
         coalesce(s.shipped, 0) as shipped, coalesce(s.pending, 0) as pending,
         greatest(r.lbs - coalesce(s.shipped, 0) - coalesce(s.pending, 0), 0) as remaining
    from reserves r left join sold s on s.customer_id = r.customer_id and lower(s.strain) = lower(r.strain)
   where r.product = 'fresh_frozen';

create or replace function _menu_numbers()
returns table (strain text, on_hand numeric, pending numeric, reserved_left numeric, held numeric, free numeric)
language sql stable security definer set search_path = public as $$
  with names as (
    select canonical_strain(p.strain) as s, sum(coalesce(p.current_weight, 0)) as lbs
      from pallets p
     where p.kind = 'package' and p.status in ('in_freezer','unslotted') and p.strain is not null
     group by 1),
  pend as (
    select lower(l.strain) as k, sum(l.lbs) as lbs from orders o join order_lines l on l.order_id = o.id
     where o.status in ('pending','submitted') and l.product = 'fresh_frozen' group by 1),
  res as (select lower(strain) as k, sum(remaining) as lbs from reserve_balances group by 1),
  held as (
    select lower(q.strain) as k, sum(greatest(q.requested_lbs - coalesce(r.lbs, 0), 0)) as lbs
      from reserve_requests q
      left join reserves r on r.customer_id = q.customer_id and lower(r.strain) = lower(q.strain) and r.product = 'fresh_frozen'
     where q.status = 'pending' group by 1),
  allk as (
    select s as name from names where s is not null
    union select strain from reserves
    union select l.strain from orders o join order_lines l on l.order_id = o.id where o.status in ('pending','submitted'))
  select a.name, coalesce(n.lbs, 0), coalesce(pe.lbs, 0), coalesce(re.lbs, 0), coalesce(h.lbs, 0),
         coalesce(n.lbs, 0) - coalesce(pe.lbs, 0) - coalesce(re.lbs, 0) - coalesce(h.lbs, 0)
    from allk a
    left join names n on lower(n.s) = lower(a.name)
    left join pend pe on pe.k = lower(a.name)
    left join res re on re.k = lower(a.name)
    left join held h on h.k = lower(a.name)
$$;

-- ---------- Roshi import: attach Roshi lines to an app order with the same SO # ----------
create or replace function _import_roshi_orders(p_rows jsonb, p_user text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; sku text; strain_raw text; s text; cust int; o orders; added_o int := 0; added_l int := 0; upd_l int := 0;
        skipped int := 0; upd_o int := 0; rc int; new_c text[] := '{}'; new_s text[] := '{}'; was order_lines; d_order date; d_ship date; units numeric;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    sku := r ->> 'sku_name';
    if sku is null or sku !~ 'FL26' or sku !~* 'fresh frozen' or coalesce(r ->> 'so_number', '') = '' then skipped := skipped + 1; continue; end if;
    units := nullif(r ->> 'units', '')::numeric;
    if units is null then skipped := skipped + 1; continue; end if;
    strain_raw := trim(regexp_replace(sku, '^.*?\(FL26(OH|GV)\)\s*-\s*(.*?)\s*-\s*OCAL Fresh Frozen.*$', '\2'));
    s := canonical_strain(strain_raw);
    if s is null then
      insert into strains (name, notes) values (strain_raw, 'Added from Roshi sales order import');
      s := strain_raw; new_s := new_s || strain_raw;
    end if;
    select id into cust from customers c where norm_name(c.name) = norm_name(r ->> 'customer')
     order by lower(c.name) = lower(r ->> 'customer') desc, c.active desc, c.id limit 1;
    if cust is null then
      insert into customers (name, kind, notes) values (trim(r ->> 'customer'), 'external', 'Added from Roshi sales order import') returning id into cust;
      new_c := new_c || trim(r ->> 'customer');
    end if;
    d_order := nullif(left(r ->> 'order_date', 10), '')::date;
    d_ship  := nullif(left(r ->> 'shipped_date', 10), '')::date;
    select * into o from orders where so_number = r ->> 'so_number';
    if o.id is null then
      insert into orders (so_number, customer_id, status, roshi_status, order_date, shipped_date, source, created_by)
      values (r ->> 'so_number', cust, roshi_bucket(r ->> 'status'), r ->> 'status', d_order, d_ship, 'roshi', p_user) returning * into o;
      added_o := added_o + 1;
    else
      update orders set customer_id = cust, status = case when status = 'cancelled' and source <> 'roshi' then status else roshi_bucket(r ->> 'status') end,
             roshi_status = r ->> 'status', order_date = coalesce(d_order, order_date), shipped_date = coalesce(d_ship, shipped_date), updated_at = now()
       where id = o.id and (customer_id, roshi_status, order_date, shipped_date) is distinct from (cust, r ->> 'status', coalesce(d_order, order_date), coalesce(d_ship, shipped_date));
      get diagnostics rc = row_count; upd_o := upd_o + rc;
    end if;
    select * into was from order_lines where roshi_line_id = r ->> 'line_id';
    if was.id is null then
      -- an order placed in the app and then entered in Roshi: claim its line instead of adding a copy
      select * into was from order_lines where order_id = o.id and roshi_line_id is null and lower(strain) = lower(s) order by id limit 1;
      if was.id is not null then
        update order_lines set roshi_line_id = r ->> 'line_id', sku = r ->> 'sku_id', farm = substring(r ->> 'sku_name' from '\(FL26(OH|GV)\)') where id = was.id;
        was.lbs := -1;   -- force the update below
      end if;
    end if;
    if was.id is null then
      insert into order_lines (order_id, strain, lbs, price_per_lb, farm, sku, package_tag, roshi_line_id)
      values (o.id, s, units, case when units > 0 then round(nullif(r ->> 'gross', '')::numeric / units, 2) end,
              substring(sku from '\(FL26(OH|GV)\)'), r ->> 'sku_id', nullif(r ->> 'package_tag', ''), r ->> 'line_id');
      added_l := added_l + 1;
    elsif (was.lbs, was.strain, was.order_id) is distinct from (units, s, o.id) then
      update order_lines set lbs = units, strain = s, order_id = o.id,
             price_per_lb = case when units > 0 and not price_override then round(nullif(r ->> 'gross', '')::numeric / units, 2) else price_per_lb end,
             package_tag = coalesce(nullif(r ->> 'package_tag', ''), package_tag), updated_at = now()
       where id = was.id;
      upd_l := upd_l + 1;
    end if;
  end loop;
  -- orders left with no lines (a line moved to another SO) go away
  delete from orders where source = 'roshi' and not exists (select 1 from order_lines l where l.order_id = orders.id);
  insert into events (user_email, type, note, details)
  values (p_user, 'orders_import', 'Roshi sales orders',
          jsonb_build_object('orders_added', added_o, 'orders_updated', upd_o, 'lines_added', added_l, 'lines_updated', upd_l, 'skipped', skipped,
                             'new_customers', to_jsonb(new_c), 'new_strains', to_jsonb(new_s)));
  return jsonb_build_object('orders_added', added_o, 'orders_updated', upd_o, 'lines_added', added_l, 'lines_updated', upd_l, 'skipped', skipped,
                            'new_customers', to_jsonb(new_c), 'new_strains', to_jsonb(new_s));
end $$;
revoke execute on function _import_roshi_orders(jsonb, text) from public, anon, authenticated;

-- ---------- customer: what can I order? ----------
-- per strain: my reserve left + what's open (rounded down to 10)
create or replace function _orderable(p_customer int)
returns table (strain text, my_left numeric, open_lbs numeric, can_order numeric)
language sql stable security definer set search_path = public as $$
  select m.strain, coalesce(b.remaining, 0), greatest(floor(m.free / 10) * 10, 0),
         floor(coalesce(b.remaining, 0) / 10) * 10 + greatest(floor(m.free / 10) * 10, 0)
    from _menu_numbers() m
    left join reserve_balances b on b.customer_id = p_customer and lower(b.strain) = lower(m.strain)
$$;
revoke execute on function _orderable(int) from public, anon, authenticated;

create or replace function place_order(p_lines jsonb, p_note text default null, p_po text default null, p_wanted date default null)
returns int
language plpgsql security definer set search_path = public as $$
declare me int := my_customer(); l record; s text; ok record; o orders; price numeric; n int := 0;
begin
  if me is null then raise exception 'Only a customer login can place orders'; end if;
  perform pg_advisory_xact_lock(4242);          -- one order at a time, so two can't take the same lbs
  select price_per_lb into price from customers where id = me;
  insert into orders (customer_id, status, order_date, source, notes, po_number, wanted_date, placed_by, created_by)
  values (me, 'submitted', current_date, 'portal', nullif(trim(p_note), ''), nullif(trim(p_po), ''), p_wanted, jwt_email(), jwt_email())
  returning * into o;
  for l in
    select x ->> 'strain' as strain, sum((x ->> 'lbs')::numeric) as lbs
      from jsonb_array_elements(coalesce(p_lines, '[]')) x group by 1
  loop
    if coalesce(l.lbs, 0) <= 0 then continue; end if;
    if l.lbs % 10 <> 0 then raise exception 'Use multiples of 10 lbs (% lbs of %)', l.lbs, l.strain; end if;
    s := canonical_strain(l.strain);
    if s is null then raise exception 'Unknown strain %', l.strain; end if;
    select * into ok from _orderable(me) x where lower(x.strain) = lower(s);
    if coalesce(ok.can_order, 0) < l.lbs then
      raise exception 'Only % lbs of % can be ordered right now', coalesce(ok.can_order, 0), s;
    end if;
    insert into order_lines (order_id, strain, lbs, price_per_lb) values (o.id, s, l.lbs, price);
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'Add at least one strain'; end if;
  insert into events (user_email, type, note, details)
  values (jwt_email(), 'order_placed', p_note, jsonb_build_object('order_id', o.id, 'customer_id', me,
          'customer', (select name from customers where id = me), 'lbs', (select sum(lbs) from order_lines where order_id = o.id), 'lines', n));
  return o.id;
end $$;

create or replace function cancel_my_order(p_id int) returns void
language plpgsql security definer set search_path = public as $$
begin
  update orders set status = 'cancelled', updated_at = now() where id = p_id and customer_id = my_customer() and status = 'submitted';
  if not found then raise exception 'Only orders Lifted hasn''t confirmed yet can be cancelled here. Contact Lifted.'; end if;
  insert into events (user_email, type, details) values (jwt_email(), 'order_cancelled', jsonb_build_object('order_id', p_id, 'by', 'customer'));
end $$;

-- ---------- staff: confirm, change status, edit lines ----------
create or replace function set_order_status(p_id int, p_status text, p_so text default null, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare o orders;
begin
  if not is_sales() then raise exception 'Only Sales or an Admin can change orders'; end if;
  if p_status not in ('pending','shipped','cancelled','submitted') then raise exception 'Unknown status %', p_status; end if;
  select * into o from orders where id = p_id for update;
  if o.id is null then raise exception 'Order not found'; end if;
  if nullif(trim(p_so), '') is not null and exists (select 1 from orders where so_number = trim(p_so) and id <> p_id) then
    raise exception 'SO % is already on another order', trim(p_so);
  end if;
  update orders set status = p_status, so_number = coalesce(nullif(trim(p_so), ''), so_number),
         confirmed_by = case when o.status = 'submitted' and p_status = 'pending' then current_email() else confirmed_by end,
         confirmed_at = case when o.status = 'submitted' and p_status = 'pending' then now() else confirmed_at end,
         shipped_date = case when p_status = 'shipped' then coalesce(shipped_date, current_date) else shipped_date end,
         updated_at = now()
   where id = p_id;
  insert into events (user_email, type, note, details)
  values (current_email(), 'order_status', p_note, jsonb_build_object('order_id', p_id, 'from', o.status, 'to', p_status,
          'so', coalesce(nullif(trim(p_so), ''), o.so_number), 'customer', (select name from customers where id = o.customer_id)));
end $$;

-- lbs 0 removes the line; p_price null keeps the price; p_line null adds a line
create or replace function set_order_line(p_order int, p_line int, p_strain text, p_lbs numeric, p_price numeric default null)
returns void
language plpgsql security definer set search_path = public as $$
declare o orders; was order_lines; s text := canonical_strain(p_strain);
begin
  if not is_sales() then raise exception 'Only Sales or an Admin can change orders'; end if;
  select * into o from orders where id = p_order for update;
  if o.id is null then raise exception 'Order not found'; end if;
  if p_lbs is null or p_lbs < 0 then raise exception 'Enter 0 or more lbs'; end if;
  if p_line is not null then
    select * into was from order_lines where id = p_line and order_id = p_order;
    if was.id is null then raise exception 'Line not found'; end if;
    if p_lbs = 0 then delete from order_lines where id = p_line;
    else
      update order_lines set lbs = p_lbs,
             price_per_lb = coalesce(p_price, price_per_lb),
             price_override = price_override or (p_price is not null and p_price is distinct from was.price_per_lb),
             updated_at = now()
       where id = p_line;
    end if;
  else
    if s is null then raise exception 'Unknown strain %', p_strain; end if;
    if p_lbs = 0 then return; end if;
    insert into order_lines (order_id, strain, lbs, price_per_lb, price_override)
    values (p_order, s, p_lbs, coalesce(p_price, (select price_per_lb from customers where id = o.customer_id)), p_price is not null);
  end if;
  update orders set updated_at = now() where id = p_order;
  insert into events (user_email, type, details)
  values (current_email(), 'order_line', jsonb_build_object('order_id', p_order, 'strain', coalesce(was.strain, s), 'lbs', p_lbs,
          'was', was.lbs, 'price', p_price, 'was_price', was.price_per_lb, 'customer', (select name from customers where id = o.customer_id)));
end $$;

-- for the email: an order the caller just placed, plus who to tell (Sales and Admins). Sent once.
create or replace function order_notification(p_id int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o orders;
begin
  update orders set notified_at = now()
   where id = p_id and notified_at is null and placed_by = jwt_email() and customer_id = my_customer()
  returning * into o;
  if o.id is null then return null; end if;
  return jsonb_build_object('id', o.id, 'customer', (select name from customers where id = o.customer_id),
    'by', o.placed_by, 'by_name', (select display_name from app_users where email = o.placed_by),
    'note', o.notes, 'po', o.po_number, 'wanted', o.wanted_date,
    'lines', (select jsonb_agg(jsonb_build_object('strain', strain, 'lbs', lbs, 'price', price_per_lb) order by strain) from order_lines where order_id = o.id),
    'to', (select jsonb_agg(email) from app_users where role in ('admin','sales')));
end $$;

-- customers read their own price and contract numbers through this
create or replace function my_terms() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('name', name, 'price_per_lb', price_per_lb, 'contract_lbs', contract_lbs)
    from customers where id = my_customer()
$$;

revoke execute on function place_order(jsonb,text,text,date), cancel_my_order(int), set_order_status(int,text,text,text),
  set_order_line(int,int,text,numeric,numeric), order_notification(int), my_terms() from public, anon;
grant execute on function place_order(jsonb,text,text,date), cancel_my_order(int), set_order_status(int,text,text,text),
  set_order_line(int,int,text,numeric,numeric), order_notification(int), my_terms() to authenticated;

-- ---------- contract terms from the menu engine (Master rows 160-164); fills blanks only ----------
update customers c set price_per_lb = coalesce(c.price_per_lb, t.price::numeric), contract_lbs = coalesce(c.contract_lbs, t.lbs::numeric),
       monthly_min_lbs = coalesce(c.monthly_min_lbs, t.mmin::numeric), deposit_usd = coalesce(c.deposit_usd, t.dep::numeric), storage_fee = coalesce(c.storage_fee, t.fee0::numeric)
  from (values
('LEEF Labs',25.0,140000.0,11667,43380.0,null),
('STIIIZY',35.0,80000.0,6667,80000.0,null),
('Jetty Extracts',35.0,50000.0,4167,null,null),
('Verdacopia',37.5,40000.0,3333,50000.0,null),
('Punch Edibles and Extracts',40.0,30000.0,2500,33750.0,null),
('SLO Driver',35.0,20000.0,1667,53000.0,null),
('Campbell Farms',42.5,20000.0,1667,25000.0,null),
('Bear Labs Humboldt',40.0,25000.0,2083,25000.0,null),
('TSL Manufacturing LLC',42.5,24000.0,2000,20000.0,null),
('Acquamarcia LLC',42.5,25200.0,850,45000.0,null),
('Rosin Tech Labs',42.5,30000.0,2500,60000.0,null),
('Club Green',45.0,16040.0,1340,25000.0,null),
('KGJMK OPCO Inc',45.0,26200.0,2183,22500.0,null),
('Master Makers',45.0,10000.0,833,45000.0,null),
('Fire King',45.0,3700.0,308,null,null)
  ) t(name, price, lbs, mmin, dep, fee0)
 where norm_name(c.name) = norm_name(case t.name when 'Solas' then 'Solas Ventures' when 'Fire King' then 'Fire King Hash' else t.name end);

-- check
select name, price_per_lb, contract_lbs from customers where price_per_lb is not null or contract_lbs is not null order by name;
