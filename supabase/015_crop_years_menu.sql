-- Migration 015: menu by crop year, "show on menu" per strain, and a Review check for pallets Roshi says
-- shipped but that are still in a freezer. Run after 014_reserves_enabled.sql. Safe to re-run.
--
--  * Crop year of a pallet = year of its harvest date (no date = the current crop). The current crop
--    (app_settings crop_year, 2026) is the main menu with reserves. Older crops get their own menu:
--    on hand - open orders for that crop.
--  * Order lines carry a crop year (from the Roshi SKU, FL26 / FL25). Reserves and balances are current crop.
--  * Strains can be hidden from the menu (Settings > Strains). Hidden strains still count for reserves and
--    orders, customers just can't add new lbs of them.
set client_min_messages = warning;

create table if not exists app_settings (key text primary key, value text not null);
insert into app_settings values ('crop_year', '2026') on conflict do nothing;
alter table app_settings enable row level security;
drop policy if exists read_settings on app_settings;
create policy read_settings on app_settings for select to authenticated using (true);
grant select on app_settings to authenticated;

create or replace function crop_year() returns int
language sql stable security definer set search_path = public as $$
  select coalesce((select value::int from app_settings where key = 'crop_year'), 2026)
$$;

alter table strains add column if not exists show_on_menu boolean not null default true;

alter table order_lines add column if not exists crop_year int;
update order_lines set crop_year = coalesce(('20' || substring(sku from 'FL(\d\d)'))::int, crop_year()) where crop_year is null;
alter table order_lines alter column crop_year set default crop_year();
alter table order_lines alter column crop_year set not null;

-- balances: current crop order lines only
create or replace view reserve_balances with (security_invoker = true) as
  with sold as (
    select o.customer_id, l.strain,
           sum(l.lbs) filter (where o.status = 'shipped') as shipped,
           sum(l.lbs) filter (where o.status in ('pending','submitted')) as pending
      from orders o join order_lines l on l.order_id = o.id
     where l.product = 'fresh_frozen' and l.crop_year = crop_year() group by 1, 2)
  select r.id, r.customer_id, r.strain, r.lbs as reserved,
         coalesce(s.shipped, 0) as shipped, coalesce(s.pending, 0) as pending,
         greatest(r.lbs - coalesce(s.shipped, 0) - coalesce(s.pending, 0), 0) as remaining
    from reserves r left join sold s on s.customer_id = r.customer_id and lower(s.strain) = lower(r.strain)
   where r.product = 'fresh_frozen';

-- ---------- menu numbers per strain and crop year ----------
drop function if exists menu_numbers();
drop function if exists open_menu();
drop function if exists _orderable(int);
drop function if exists _menu_numbers();

create function _menu_numbers()
returns table (strain text, crop_year int, on_menu boolean, on_hand numeric, pending numeric, reserved_left numeric, held numeric, free numeric)
language sql stable security definer set search_path = public as $$
  with cy as (select crop_year() as y),
  names as (
    select canonical_strain(p.strain) as s, coalesce(extract(year from p.harvest_date)::int, (select y from cy)) as yr,
           sum(coalesce(p.current_weight, 0)) as lbs
      from pallets p
     where p.kind = 'package' and p.status in ('in_freezer','unslotted') and p.strain is not null
     group by 1, 2),
  pend as (
    select lower(l.strain) as k, l.crop_year as yr, sum(l.lbs) as lbs from orders o join order_lines l on l.order_id = o.id
     where o.status in ('pending','submitted') and l.product = 'fresh_frozen' group by 1, 2),
  res as (select lower(strain) as k, sum(remaining) as lbs from reserve_balances group by 1),
  held as (
    select lower(q.strain) as k, sum(greatest(q.requested_lbs - coalesce(r.lbs, 0), 0)) as lbs
      from reserve_requests q
      left join reserves r on r.customer_id = q.customer_id and lower(r.strain) = lower(q.strain) and r.product = 'fresh_frozen'
     where q.status = 'pending' group by 1),
  allk as (
    select s as name, yr from names where s is not null
    union select strain, (select y from cy) from reserves
    union select l.strain, l.crop_year from orders o join order_lines l on l.order_id = o.id where o.status in ('pending','submitted')),
  k as (select distinct on (lower(name), yr) name, yr from allk order by lower(name), yr, name)
  select k.name, k.yr,
         coalesce((select st.show_on_menu from strains st where lower(st.name) = lower(k.name) limit 1), true),
         coalesce(n.lbs, 0), coalesce(pe.lbs, 0),
         case when k.yr = (select y from cy) then coalesce(re.lbs, 0) else 0 end,
         case when k.yr = (select y from cy) then coalesce(h.lbs, 0) else 0 end,
         coalesce(n.lbs, 0) - coalesce(pe.lbs, 0)
           - case when k.yr = (select y from cy) then coalesce(re.lbs, 0) + coalesce(h.lbs, 0) else 0 end
    from k
    left join names n on lower(n.s) = lower(k.name) and n.yr = k.yr
    left join pend pe on pe.k = lower(k.name) and pe.yr = k.yr
    left join res re on re.k = lower(k.name)
    left join held h on h.k = lower(k.name)
$$;
revoke execute on function _menu_numbers() from public, anon, authenticated;

create function menu_numbers()
returns table (strain text, crop_year int, on_menu boolean, on_hand numeric, pending numeric, reserved_left numeric, held numeric, free numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_sales() then raise exception 'Not allowed'; end if;
  return query select * from _menu_numbers();
end $$;
revoke execute on function menu_numbers() from public, anon;
grant execute on function menu_numbers() to authenticated;

create function open_menu()
returns table (strain text, crop_year int, available numeric, my_reserved numeric, my_shipped numeric, my_pending numeric, my_left numeric,
               request_id int, requested_lbs numeric)
language plpgsql stable security definer set search_path = public as $$
declare me int := my_customer(); cy int := crop_year();
begin
  if me is null and not is_sales() then raise exception 'Not allowed'; end if;
  return query
    select m.strain, m.crop_year, case when m.on_menu then greatest(floor(m.free / 10) * 10, 0) else 0 end,
           b.reserved, b.shipped, b.pending, b.remaining, q.id, q.requested_lbs
      from _menu_numbers() m
      left join reserve_balances b on m.crop_year = cy and b.customer_id = me and lower(b.strain) = lower(m.strain)
      left join reserve_requests q on m.crop_year = cy and q.customer_id = me and lower(q.strain) = lower(m.strain) and q.status = 'pending'
     where (m.on_menu and m.free >= 10) or b.id is not null or q.id is not null
     order by m.crop_year desc, m.strain;
end $$;
revoke execute on function open_menu() from public, anon;
grant execute on function open_menu() to authenticated;

create function _orderable(p_customer int)
returns table (strain text, crop_year int, my_left numeric, open_lbs numeric, can_order numeric)
language sql stable security definer set search_path = public as $$
  select m.strain, m.crop_year, x.mine, x.open, x.mine + x.open
    from _menu_numbers() m
    join customers c on c.id = p_customer
    left join reserve_balances b on m.crop_year = crop_year() and b.customer_id = p_customer and lower(b.strain) = lower(m.strain)
    cross join lateral (select
      case when c.reserves_enabled then floor(coalesce(b.remaining, 0) / 10) * 10 else 0 end as mine,
      case when m.on_menu then greatest(floor(m.free / 10) * 10, 0) else 0 end as open) x
$$;
revoke execute on function _orderable(int) from public, anon, authenticated;

-- orders: each line can name its crop year (default current)
create or replace function place_order(p_lines jsonb, p_note text default null, p_po text default null, p_wanted date default null)
returns int
language plpgsql security definer set search_path = public as $$
declare me int := my_customer(); l record; s text; ok record; o orders; price numeric; n int := 0;
begin
  perform no_view_as();
  if me is null then raise exception 'Only a customer login can place orders'; end if;
  perform pg_advisory_xact_lock(4242);          -- one order at a time, so two can't take the same lbs
  select price_per_lb into price from customers where id = me;
  insert into orders (customer_id, status, order_date, source, notes, po_number, wanted_date, placed_by, created_by)
  values (me, 'submitted', current_date, 'portal', nullif(trim(p_note), ''), nullif(trim(p_po), ''), p_wanted, jwt_email(), jwt_email())
  returning * into o;
  for l in
    select x ->> 'strain' as strain, coalesce((x ->> 'crop_year')::int, crop_year()) as yr, sum((x ->> 'lbs')::numeric) as lbs
      from jsonb_array_elements(coalesce(p_lines, '[]')) x group by 1, 2
  loop
    if coalesce(l.lbs, 0) <= 0 then continue; end if;
    if l.lbs % 10 <> 0 then raise exception 'Use multiples of 10 lbs (% lbs of %)', l.lbs, l.strain; end if;
    s := canonical_strain(l.strain);
    if s is null then raise exception 'Unknown strain %', l.strain; end if;
    select * into ok from _orderable(me) x where lower(x.strain) = lower(s) and x.crop_year = l.yr;
    if coalesce(ok.can_order, 0) < l.lbs then
      raise exception 'Only % lbs of % (% crop) can be ordered right now', coalesce(ok.can_order, 0), s, l.yr;
    end if;
    insert into order_lines (order_id, strain, lbs, price_per_lb, crop_year) values (o.id, s, l.lbs, price, l.yr);
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'Add at least one strain'; end if;
  insert into events (user_email, type, note, details)
  values (jwt_email(), 'order_placed', p_note, jsonb_build_object('order_id', o.id, 'customer_id', me,
          'customer', (select name from customers where id = me), 'lbs', (select sum(lbs) from order_lines where order_id = o.id), 'lines', n));
  return o.id;
end $$;

-- reserve requests: current crop, and hidden strains have nothing open to add
do $$
declare def text := pg_get_functiondef('request_reserve_change(text,numeric,text)'::regprocedure);
begin
  if def not like '%x.crop_year = crop_year()%' then
    def := replace(def, 'select * into m from _menu_numbers() x where lower(x.strain) = lower(s);',
                        'select * into m from _menu_numbers() x where lower(x.strain) = lower(s) and x.crop_year = crop_year();');
    def := replace(def, 'avail := floor((coalesce(m.free, 0) +', 'avail := floor((case when coalesce(m.on_menu, true) then coalesce(m.free, 0) else 0 end +');
    execute def;
  end if;
end $$;

-- ---------- Roshi import: FL26 plus open FL25 orders, crop year from the SKU ----------
create or replace function _import_roshi_orders(p_rows jsonb, p_user text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; sku text; strain_raw text; s text; cust int; o orders; added_o int := 0; added_l int := 0; upd_l int := 0;
        skipped int := 0; yr int; upd_o int := 0; rc int; new_c text[] := '{}'; new_s text[] := '{}'; was order_lines; d_order date; d_ship date; units numeric;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    sku := r ->> 'sku_name';
    if sku is null or sku !~ 'FL2[56]' or sku !~* 'fresh frozen' or coalesce(r ->> 'so_number', '') = '' then skipped := skipped + 1; continue; end if;
    -- older crops: only open orders (they hold freezer lbs); finished ones are history the app doesn't need
    if sku !~ 'FL26' and roshi_bucket(r ->> 'status') <> 'pending' and not exists (select 1 from order_lines where roshi_line_id = r ->> 'line_id') then
      skipped := skipped + 1; continue;
    end if;
    yr := ('20' || substring(sku from 'FL(\d\d)'))::int;
    units := nullif(r ->> 'units', '')::numeric;
    if units is null then skipped := skipped + 1; continue; end if;
    strain_raw := trim(regexp_replace(sku, '^.*?\(FL\d\d[A-Z]*\)\s*-\s*(.*?)\s*-\s*OCAL Fresh Frozen.*$', '\1'));
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
      select * into was from order_lines where order_id = o.id and roshi_line_id is null and lower(strain) = lower(s) and crop_year = yr order by id limit 1;
      if was.id is not null then
        update order_lines set roshi_line_id = r ->> 'line_id', sku = r ->> 'sku_id', farm = substring(r ->> 'sku_name' from '\(FL\d\d([A-Z]+)\)'), crop_year = yr where id = was.id;
        was.lbs := -1;   -- force the update below
      end if;
    end if;
    if was.id is null then
      insert into order_lines (order_id, strain, lbs, price_per_lb, farm, sku, package_tag, roshi_line_id, crop_year)
      values (o.id, s, units, case when units > 0 then round(nullif(r ->> 'gross', '')::numeric / units, 2) end,
              substring(sku from '\(FL\d\d([A-Z]+)\)'), r ->> 'sku_id', nullif(r ->> 'package_tag', ''), r ->> 'line_id', yr);
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

-- ---------- Review: shipped in Roshi but the pallet is still in a freezer (matched by METRC tag) ----------
create table if not exists shipped_tag_checks (
  package_tag text primary key, acked_lbs numeric not null default 0, acked_by text, acked_at timestamptz);
alter table shipped_tag_checks enable row level security;

create or replace function shipped_in_freezer()
returns table (pallet_id bigint, package_tag text, shipped_lbs numeric, new_lbs numeric, sos text, last_shipped date)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'Not allowed'; end if;
  return query
    with s as (
      select l.package_tag as tag, sum(l.lbs) as lbs, string_agg(distinct o.so_number, ', ') as sos, max(o.shipped_date) as d
        from orders o join order_lines l on l.order_id = o.id
       where o.status = 'shipped' and l.package_tag is not null group by 1)
    select p.id, s.tag, s.lbs, s.lbs - coalesce(c.acked_lbs, 0), s.sos, s.d
      from s join pallets p on p.package_tag = s.tag and p.kind = 'package' and p.status in ('in_freezer','unslotted')
      left join shipped_tag_checks c on c.package_tag = s.tag
     where s.lbs - coalesce(c.acked_lbs, 0) > 0
     order by s.d desc nulls last;
end $$;

create or replace function ack_shipped_tag(p_tag text) returns void
language plpgsql security definer set search_path = public as $$
declare total numeric;
begin
  perform require_staff();
  select sum(l.lbs) into total from orders o join order_lines l on l.order_id = o.id where o.status = 'shipped' and l.package_tag = p_tag;
  insert into shipped_tag_checks values (p_tag, coalesce(total, 0), current_email(), now())
  on conflict (package_tag) do update set acked_lbs = excluded.acked_lbs, acked_by = excluded.acked_by, acked_at = now();
end $$;

-- take a pallet out of inventory because it shipped outside a load (Roshi)
create or replace function mark_pallet_shipped(p_pallet_id bigint, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare p pallets;
begin
  perform require_staff();
  select * into p from pallets where id = p_pallet_id for update;
  if p.id is null then raise exception 'Pallet not found'; end if;
  if p.kind <> 'package' then raise exception 'Pick the package, not the mixed pallet'; end if;
  if p.status not in ('in_freezer','unslotted') then raise exception '% isn''t in inventory', p.code; end if;
  if pallet_open_load(p.id) is not null then raise exception '% is on a load. Remove it from the load first.', p.code; end if;
  update pallets set status = 'shipped', slot_id = null, container_id = null, updated_at = now() where id = p.id;
  insert into events (user_email, type, pallet_id, from_slot_id, lbs, note)
  values (current_email(), 'shipped_out', p.id, p.slot_id, p.current_weight, coalesce(p_note, 'Shipped (Roshi)'));
  if p.package_tag is not null then perform ack_shipped_tag(p.package_tag); end if;
end $$;

revoke execute on function shipped_in_freezer(), ack_shipped_tag(text), mark_pallet_shipped(bigint,text) from public, anon;
grant execute on function shipped_in_freezer(), ack_shipped_tag(text), mark_pallet_shipped(bigint,text) to authenticated;

-- check: menu totals by crop year
select crop_year, count(*) filter (where free >= 10 and on_menu) as strains_open, sum(greatest(floor(free / 10) * 10, 0)) filter (where on_menu) as open_lbs
  from _menu_numbers() group by 1 order by 1 desc;
