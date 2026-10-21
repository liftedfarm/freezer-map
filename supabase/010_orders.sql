-- Migration 010: orders (sales orders and their lines), Roshi sales order import, reserve balances.
-- Run once in Supabase after 009_reserves.sql: SQL Editor > New query > paste > Run. Safe to re-run.
-- Admin and Sales see all orders. A customer login sees only its own. Crew sees none (pick lists come later).
set client_min_messages = warning;

create table if not exists orders (
  id            serial primary key,
  so_number     text unique,                 -- Roshi SO #, when it came from Roshi
  customer_id   int not null references customers(id),
  status        text not null check (status in ('draft','pending','shipped','cancelled')),
  roshi_status  text,                        -- Fulfilled, Open, In Fulfillment, Partially Fulfilled, ...
  order_date    date,
  shipped_date  date,
  source        text not null default 'app' check (source in ('app','portal','roshi')),
  notes         text,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists order_lines (
  id            serial primary key,
  order_id      int not null references orders(id) on delete cascade,
  strain        text not null,
  product       text not null default 'fresh_frozen',
  lbs           numeric not null check (lbs >= 0),
  price_per_lb  numeric,
  price_override boolean not null default false,
  farm          text,                        -- OH / GV from the Roshi SKU
  sku           text,
  package_tag   text,                        -- METRC tag Roshi shipped from, when known
  roshi_line_id text unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists order_lines_order on order_lines(order_id);
create index if not exists orders_customer on orders(customer_id);

alter table orders enable row level security;
alter table order_lines enable row level security;
drop policy if exists read_orders on orders;
create policy read_orders on orders for select to authenticated using (is_sales() or customer_id = my_customer());
drop policy if exists read_lines on order_lines;
create policy read_lines on order_lines for select to authenticated
  using (is_sales() or exists (select 1 from orders o where o.id = order_id and o.customer_id = my_customer()));
grant select on orders, order_lines to authenticated;

-- Roshi status -> app status
create or replace function roshi_bucket(s text) returns text language sql immutable as $$
  select case
    when s in ('Fulfilled','Externally Fulfilled') then 'shipped'
    when s in ('Open','In Fulfillment','Partially Fulfilled','Re-Opened','Placeholder') then 'pending'
    when s ilike '%cancel%' or s ilike '%void%' or s ilike '%reject%' then 'cancelled'
    else 'pending' end
$$;

create or replace function norm_name(x text) returns text language sql immutable as $$
  select regexp_replace(regexp_replace(lower(coalesce(x, '')), '\m(llc|inc|corp|co)\M', '', 'g'), '[^a-z0-9]', '', 'g')
$$;

-- Import Roshi sales order lines (the "SO Detail" export). Only 2026 fresh frozen lines (SKU has FL26 and
-- "Fresh Frozen") are used. New SOs and lines are added; status, lbs, price and dates are updated on ones
-- already here. Unknown customers and strains are added to Settings and listed in the result.
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

create or replace function import_roshi_orders(p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_sales() then raise exception 'Only Sales or an Admin can import orders'; end if;
  return _import_roshi_orders(p_rows, current_email());
end $$;
revoke execute on function import_roshi_orders(jsonb) from public, anon;
grant execute on function import_roshi_orders(jsonb) to authenticated;

-- reserve balances: reserved, shipped, pending, remaining per customer x strain
create or replace view reserve_balances with (security_invoker = true) as
  with sold as (
    select o.customer_id, l.strain,
           sum(l.lbs) filter (where o.status = 'shipped') as shipped,
           sum(l.lbs) filter (where o.status = 'pending') as pending
      from orders o join order_lines l on l.order_id = o.id
     where l.product = 'fresh_frozen' group by 1, 2)
  select r.id, r.customer_id, r.strain, r.lbs as reserved,
         coalesce(s.shipped, 0) as shipped, coalesce(s.pending, 0) as pending,
         greatest(r.lbs - coalesce(s.shipped, 0) - coalesce(s.pending, 0), 0) as remaining
    from reserves r left join sold s on s.customer_id = r.customer_id and lower(s.strain) = lower(r.strain)
   where r.product = 'fresh_frozen';
grant select on reserve_balances to authenticated;

-- the activity log hides order activity from Crew
drop policy if exists read_all on events;
create policy read_all on events for select to authenticated
  using (is_staff() and (is_sales() or not ((type = 'settings' and details ->> 'list' = 'customers') or type like 'reserve%' or type like 'order%')));
