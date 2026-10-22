-- Migration 027: sales orders and invoices made in the app (getting off Roshi).
-- Run once in Supabase after 026_harvest_logging.sql: SQL Editor > New query > paste > Run. Safe to re-run.
--
--  * Payment terms: a list (COD, Due on receipt, Net 15/30/45, 50% down / 50% Net 30...) and a default per customer.
--    A term can split the invoice into parts, each due a number of days after the invoice date.
--  * Sales orders get an SO number (SO-YYMMDD##) when they're confirmed. Sales can create orders in the app.
--  * Invoices are made when the order's stop is delivered (or by Sales), numbered from the SO (INV-YYMMDD##),
--    from what actually shipped: the lbs on each package tag x the order's price. Terms can be changed on the invoice.
--  * Every SO and invoice has a private link (share_token) that can be texted to the customer.
--  * Accounting: each invoice tracks whether it has gone to QuickBooks (later Business Central).
set client_min_messages = warning;

-- ---------- payment terms ----------
create table if not exists payment_terms (
  code      text primary key,
  label     text not null,
  schedule  jsonb not null,            -- [{"pct": 100, "days": 30}] or [{"pct": 50, "days": 0}, {"pct": 50, "days": 30}]
  cod       boolean not null default false,
  sort      int not null default 0,
  active    boolean not null default true
);
alter table payment_terms enable row level security;
drop policy if exists read_terms on payment_terms;
create policy read_terms on payment_terms for select to authenticated using (true);
grant select on payment_terms to authenticated;
insert into payment_terms (code, label, schedule, cod, sort) values
  ('COD', 'Cash on delivery', '[{"pct":100,"days":0}]', true, 1),
  ('RECEIPT', 'Due on receipt', '[{"pct":100,"days":0}]', false, 2),
  ('NET15', 'Net 15', '[{"pct":100,"days":15}]', false, 3),
  ('NET30', 'Net 30', '[{"pct":100,"days":30}]', false, 4),
  ('NET45', 'Net 45', '[{"pct":100,"days":45}]', false, 5),
  ('50-50-NET30', '50% due now, 50% Net 30', '[{"pct":50,"days":0},{"pct":50,"days":30}]', false, 6)
on conflict (code) do nothing;

-- Sales Admins add or change terms
create or replace function set_payment_term(p_code text, p_label text, p_schedule jsonb, p_cod boolean default false, p_active boolean default true) returns void
language plpgsql security definer set search_path = public as $$
declare tot numeric;
begin
  perform no_view_as();
  if not is_sales_admin() then raise exception 'Only a Sales Admin can change payment terms'; end if;
  select sum((x ->> 'pct')::numeric) into tot from jsonb_array_elements(p_schedule) x;
  if tot is distinct from 100 then raise exception 'The parts have to add up to 100%%'; end if;
  insert into payment_terms (code, label, schedule, cod, active, sort)
  values (upper(trim(p_code)), trim(p_label), p_schedule, coalesce(p_cod, false), coalesce(p_active, true), (select coalesce(max(sort), 0) + 1 from payment_terms))
  on conflict (code) do update set label = excluded.label, schedule = excluded.schedule, cod = excluded.cod, active = excluded.active;
end $$;

-- ---------- customers: billing, ship-to, terms ----------
alter table customers add column if not exists legal_name text;
alter table customers add column if not exists billing_address text;
alter table customers add column if not exists billing_contact text;
alter table customers add column if not exists billing_email text;
alter table customers add column if not exists billing_phone text;
alter table customers add column if not exists ship_to_name text;
alter table customers add column if not exists ship_to_address text;
alter table customers add column if not exists receiving_contact text;
alter table customers add column if not exists payment_terms text references payment_terms(code);
alter table customers add column if not exists qbo_id text;
alter table customers add column if not exists bc_no text;

-- ---------- orders: SO numbers, terms override, share link ----------
alter table orders add column if not exists payment_terms text references payment_terms(code);
alter table orders add column if not exists share_token uuid not null default gen_random_uuid();
create unique index if not exists orders_share_idx on orders (share_token);

create or replace function next_so(p_date date) returns text
language sql volatile security definer set search_path = public as $$
  select 'SO-' || to_char(p_date, 'YYMMDD') || lpad((coalesce(max(substring(so_number from 10 for 2)::int), 0) + 1)::text, 2, '0')
    from orders where so_number ~ ('^SO-' || to_char(p_date, 'YYMMDD') || '[0-9]{2}$')
$$;

-- confirmed orders always have an SO number
create or replace function so_on_confirm() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('pending','shipped') and nullif(trim(new.so_number), '') is null then
    new.so_number := next_so(coalesce(new.order_date, current_date));
  end if;
  return new;
end $$;
drop trigger if exists so_on_confirm on orders;
create trigger so_on_confirm before insert or update of status, so_number on orders for each row execute function so_on_confirm();
-- confirmed orders already in the app without one
update orders set so_number = next_so(coalesce(order_date, created_at::date)) where status in ('pending') and so_number is null;

-- Sales creates an order in the app. p_lines: [{"strain": "Rum Runner", "lbs": 200, "price": 45, "crop_year": 2026}]
-- price is optional (the customer's contract price for that crop year is used).
create or replace function create_order(p_customer int, p_lines jsonb, p_po text default null, p_wanted date default null,
                                        p_notes text default null, p_terms text default null, p_confirm boolean default true) returns orders
language plpgsql security definer set search_path = public as $$
declare o orders; l jsonb; s text; yr int; pr numeric; n int := 0;
begin
  perform no_view_as();
  if not is_sales() then raise exception 'Only Sales can create orders'; end if;
  if not exists (select 1 from customers where id = p_customer) then raise exception 'Pick a customer'; end if;
  insert into orders (customer_id, status, order_date, source, notes, po_number, wanted_date, created_by, payment_terms, confirmed_by, confirmed_at)
  values (p_customer, case when p_confirm then 'pending' else 'draft' end, current_date, 'app', nullif(trim(p_notes), ''), nullif(trim(p_po), ''), p_wanted,
          current_email(), nullif(p_terms, ''), case when p_confirm then current_email() end, case when p_confirm then now() end)
  returning * into o;
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]')) loop
    s := coalesce(canonical_strain(l ->> 'strain'), nullif(trim(l ->> 'strain'), ''));
    if s is null or coalesce((l ->> 'lbs')::numeric, 0) <= 0 then continue; end if;
    yr := coalesce((l ->> 'crop_year')::int, crop_year());
    pr := nullif(l ->> 'price', '')::numeric;
    if pr is null then select t.price_per_lb into pr from terms_for(p_customer, yr) t; end if;
    insert into order_lines (order_id, strain, lbs, price_per_lb, price_override, crop_year)
    values (o.id, s, (l ->> 'lbs')::numeric, pr, nullif(l ->> 'price', '') is not null, yr);
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'Add at least one line with lbs'; end if;
  insert into events (user_email, type, details)
  values (current_email(), 'order_created', jsonb_build_object('order_id', o.id, 'so', o.so_number, 'customer', (select name from customers where id = o.customer_id), 'lines', n));
  select * into o from orders where id = o.id;
  return o;
end $$;

create or replace function set_order_terms(p_order int, p_terms text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform no_view_as();
  if not is_sales() then raise exception 'Only Sales'; end if;
  update orders set payment_terms = nullif(p_terms, ''), updated_at = now() where id = p_order;
end $$;

-- ---------- invoices ----------
create table if not exists invoices (
  id           serial primary key,
  inv_number   text not null unique,
  order_id     int references orders(id),
  customer_id  int not null references customers(id),
  invoice_date date not null default current_date,
  terms_code   text,
  terms_label  text,
  schedule     jsonb not null default '[]',      -- [{"pct": 50, "amount": 1000, "due": "2026-10-22"}, ...]
  due_date     date,
  subtotal     numeric not null default 0,
  total        numeric not null default 0,
  status       text not null default 'open' check (status in ('open','paid','void')),
  po_number    text,
  notes        text,
  share_token  uuid not null default gen_random_uuid() unique,
  sent_at      timestamptz,
  acct_status  text not null default 'pending' check (acct_status in ('pending','sent','error','skip')),
  acct_ref     text,
  acct_error   text,
  paid_at      date,
  created_by   text default current_email(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create table if not exists invoice_lines (
  id            serial primary key,
  invoice_id    int not null references invoices(id) on delete cascade,
  sort          int not null default 0,
  kind          text not null default 'product' check (kind in ('product','charge')),
  item          text,
  description   text not null,
  strain        text,
  crop_year     int,
  qty           numeric not null default 0,
  uom           text not null default 'lb',
  price         numeric not null default 0,
  amount        numeric not null default 0,
  order_line_id int references order_lines(id) on delete set null
);
create table if not exists invoice_packages (
  id              serial primary key,
  invoice_line_id int not null references invoice_lines(id) on delete cascade,
  package_tag     text,
  pallet_code     text,
  lbs             numeric,
  batch           text
);
create index if not exists invoice_lines_inv_idx on invoice_lines (invoice_id);
create index if not exists invoice_packages_line_idx on invoice_packages (invoice_line_id);
alter table invoices enable row level security;
alter table invoice_lines enable row level security;
alter table invoice_packages enable row level security;
drop policy if exists read_inv on invoices; drop policy if exists read_inv on invoice_lines; drop policy if exists read_inv on invoice_packages;
create policy read_inv on invoices for select to authenticated using (is_sales() or (customer_id = my_customer() and status <> 'void'));
create policy read_inv on invoice_lines for select to authenticated using (exists (select 1 from invoices i where i.id = invoice_id and (is_sales() or (i.customer_id = my_customer() and i.status <> 'void'))));
create policy read_inv on invoice_packages for select to authenticated using (exists (select 1 from invoice_lines l join invoices i on i.id = l.invoice_id where l.id = invoice_line_id and (is_sales() or (i.customer_id = my_customer() and i.status <> 'void'))));
grant select on invoices, invoice_lines, invoice_packages to authenticated;

-- METRC batch like FL26-OH-OCAL-FF-RumRunner (site from where the pallet lives or its letter)
create or replace function batch_name(p_year int, p_site text, p_strain text) returns text
language sql immutable as $$
  select 'FL' || right(coalesce(p_year, 0)::text, 2) || '-' || case upper(coalesce(p_site, '')) when 'GVR' then 'GV' else 'OH' end
         || '-OCAL-FF-' || regexp_replace(coalesce(p_strain, ''), '[^A-Za-z0-9#]', '', 'g')
$$;

-- totals and due dates from the lines and the terms
create or replace function recompute_invoice(p_inv int) returns invoices
language plpgsql security definer set search_path = public as $$
declare i invoices; t payment_terms; tot numeric; part jsonb; sched jsonb := '[]'; left_amt numeric; k int := 0; n int; amt numeric;
begin
  update invoice_lines set amount = round(qty * price, 2) where invoice_id = p_inv;
  select coalesce(sum(amount), 0) into tot from invoice_lines where invoice_id = p_inv;
  select * into i from invoices where id = p_inv;
  select * into t from payment_terms where code = i.terms_code;
  if t.code is null then select * into t from payment_terms where code = 'RECEIPT'; end if;
  n := jsonb_array_length(t.schedule); left_amt := tot;
  for part in select * from jsonb_array_elements(t.schedule) loop
    k := k + 1;
    amt := case when k = n then left_amt else round(tot * (part ->> 'pct')::numeric / 100, 2) end;
    left_amt := left_amt - amt;
    sched := sched || jsonb_build_object('pct', (part ->> 'pct')::numeric, 'amount', amt, 'due', i.invoice_date + (part ->> 'days')::int);
  end loop;
  update invoices set subtotal = tot, total = tot, terms_label = t.label, terms_code = t.code, schedule = sched,
         due_date = (select max((x ->> 'due')::date) from jsonb_array_elements(sched) x), updated_at = now()
   where id = p_inv returning * into i;
  return i;
end $$;

-- make the invoice for an order from what shipped (no permission check: called by the trigger and by make_invoice)
create or replace function _make_invoice(p_order int) returns invoices
language plpgsql security definer set search_path = public as $$
declare o orders; c customers; i invoices; num text; ln record; il invoice_lines; k int := 0; qty numeric;
begin
  select * into o from orders where id = p_order;
  select * into i from invoices where order_id = o.id and status <> 'void' order by id desc limit 1;
  if i.id is not null then return i; end if;
  select * into c from customers where id = o.customer_id;
  num := 'INV-' || coalesce(nullif(regexp_replace(coalesce(o.so_number, ''), '^SO-', ''), ''), lpad(o.id::text, 6, '0'));
  if exists (select 1 from invoices where inv_number = num) then
    num := num || '-' || ((select count(*) from invoices where inv_number like num || '%') + 1);
  end if;
  insert into invoices (inv_number, order_id, customer_id, invoice_date, terms_code, po_number, notes)
  values (num, o.id, o.customer_id, coalesce(o.shipped_date, current_date), coalesce(o.payment_terms, c.payment_terms, 'RECEIPT'), o.po_number, null)
  returning * into i;
  for ln in select ol.* from order_lines ol where ol.order_id = o.id and ol.lbs > 0 order by ol.crop_year desc, ol.strain loop
    k := k + 1;
    select coalesce(sum(x.lbs), 0) into qty from order_picks x where x.order_line_id = ln.id;
    if qty = 0 then qty := ln.lbs; end if;
    insert into invoice_lines (invoice_id, sort, kind, item, description, strain, crop_year, qty, uom, price, order_line_id)
    values (i.id, k, 'product', 'Fresh Frozen - ' || ln.crop_year, ln.strain || ' - Fresh Frozen', ln.strain, ln.crop_year, qty, 'lb',
            coalesce(ln.price_per_lb, (select t.price_per_lb from terms_for(o.customer_id, ln.crop_year) t), 0), ln.id)
    returning * into il;
    insert into invoice_packages (invoice_line_id, package_tag, pallet_code, lbs, batch)
    select il.id, p.package_tag, p.code, x.lbs,
           batch_name(ln.crop_year, coalesce(f.site, f2.site, p.received_site, case when p.code like 'G%' then 'GVR' else 'OHR' end), ln.strain)
      from order_picks x join pallets p on p.id = x.pallet_id
      left join load_items li on li.pallet_id = p.id and li.stop_id = o.stop_id
      left join slots s on s.id = li.from_slot left join freezers f on f.id = s.freezer_id
      left join slots s2 on s2.id = p.slot_id left join freezers f2 on f2.id = s2.freezer_id
     where x.order_line_id = ln.id order by p.code;
  end loop;
  -- Roshi-imported orders carry their package tags on the lines
  insert into invoice_packages (invoice_line_id, package_tag, lbs, batch)
  select il2.id, ol.package_tag, ol.lbs, batch_name(ol.crop_year, null, ol.strain)
    from invoice_lines il2 join order_lines ol on ol.id = il2.order_line_id
   where il2.invoice_id = i.id and ol.package_tag is not null and not exists (select 1 from invoice_packages ip where ip.invoice_line_id = il2.id);
  i := recompute_invoice(i.id);
  insert into events (user_email, type, details)
  values (coalesce(current_email(), 'system'), 'invoice_created', jsonb_build_object('invoice_id', i.id, 'inv', i.inv_number, 'so', o.so_number, 'customer', c.name, 'total', i.total));
  return i;
end $$;

create or replace function make_invoice(p_order int) returns invoices
language plpgsql security definer set search_path = public as $$
declare o orders;
begin
  perform no_view_as();
  if not is_sales() then raise exception 'Only Sales can make invoices'; end if;
  select * into o from orders where id = p_order;
  if o.status not in ('pending','shipped') then raise exception 'Only confirmed or shipped orders can be invoiced'; end if;
  return _make_invoice(p_order);
end $$;

-- delivered through the app: invoice it
create or replace function invoice_on_ship() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'shipped' and old.status is distinct from 'shipped' and new.stop_id is not null then
    perform _make_invoice(new.id);
  end if;
  return new;
end $$;
drop trigger if exists invoice_on_ship on orders;
create trigger invoice_on_ship after update of status on orders for each row execute function invoice_on_ship();

-- ---------- changing an invoice (Sales; only until it's gone to accounting) ----------
create or replace function _inv_editable(p_inv int) returns invoices
language plpgsql security definer set search_path = public as $$
declare i invoices;
begin
  perform no_view_as();
  if not is_sales() then raise exception 'Only Sales can change invoices'; end if;
  select * into i from invoices where id = p_inv for update;
  if i.id is null then raise exception 'Invoice not found'; end if;
  if i.status = 'void' then raise exception 'That invoice is void'; end if;
  if i.acct_status = 'sent' then raise exception '% is already in accounting. Change it there.', i.inv_number; end if;
  return i;
end $$;

create or replace function set_invoice_terms(p_inv int, p_terms text) returns invoices
language plpgsql security definer set search_path = public as $$
begin
  perform _inv_editable(p_inv);
  if not exists (select 1 from payment_terms where code = p_terms) then raise exception 'Unknown terms'; end if;
  update invoices set terms_code = p_terms where id = p_inv;
  return recompute_invoice(p_inv);
end $$;

create or replace function set_invoice_info(p_inv int, p_date date, p_po text, p_notes text) returns invoices
language plpgsql security definer set search_path = public as $$
begin
  perform _inv_editable(p_inv);
  update invoices set invoice_date = coalesce(p_date, invoice_date), po_number = nullif(trim(p_po), ''), notes = nullif(trim(p_notes), '') where id = p_inv;
  return recompute_invoice(p_inv);
end $$;

-- add or change a line. Product lines: only price changes. Charge lines (shipping etc.): anything.
create or replace function set_invoice_line(p_inv int, p_line int, p_description text, p_qty numeric, p_price numeric, p_uom text default 'ea') returns invoices
language plpgsql security definer set search_path = public as $$
declare l invoice_lines;
begin
  perform _inv_editable(p_inv);
  if p_line is null then
    insert into invoice_lines (invoice_id, sort, kind, item, description, qty, uom, price)
    values (p_inv, (select coalesce(max(sort), 0) + 1 from invoice_lines where invoice_id = p_inv), 'charge', trim(p_description), trim(p_description),
            coalesce(p_qty, 1), coalesce(nullif(trim(p_uom), ''), 'ea'), coalesce(p_price, 0));
  else
    select * into l from invoice_lines where id = p_line and invoice_id = p_inv;
    if l.kind = 'product' then update invoice_lines set price = coalesce(p_price, price) where id = l.id;
    else update invoice_lines set description = coalesce(nullif(trim(p_description), ''), description), item = coalesce(nullif(trim(p_description), ''), item),
                                  qty = coalesce(p_qty, qty), price = coalesce(p_price, price), uom = coalesce(nullif(trim(p_uom), ''), uom) where id = l.id; end if;
  end if;
  return recompute_invoice(p_inv);
end $$;

create or replace function remove_invoice_line(p_inv int, p_line int) returns invoices
language plpgsql security definer set search_path = public as $$
begin
  perform _inv_editable(p_inv);
  delete from invoice_lines where id = p_line and invoice_id = p_inv and kind = 'charge';
  return recompute_invoice(p_inv);
end $$;

create or replace function set_invoice_status(p_inv int, p_status text, p_note text default null) returns invoices
language plpgsql security definer set search_path = public as $$
declare i invoices;
begin
  perform no_view_as();
  if not is_sales() then raise exception 'Only Sales'; end if;
  if p_status not in ('open','paid','void') then raise exception 'Unknown status'; end if;
  if p_status = 'void' and not is_sales_admin() then raise exception 'Only a Sales Admin can void an invoice'; end if;
  update invoices set status = p_status, paid_at = case when p_status = 'paid' then coalesce(paid_at, current_date) else null end,
         notes = case when nullif(trim(p_note), '') is null then notes else concat_ws(E'\n', notes, trim(p_note)) end, updated_at = now()
   where id = p_inv returning * into i;
  insert into events (user_email, type, note, details)
  values (current_email(), 'invoice_' || p_status, p_note, jsonb_build_object('invoice_id', i.id, 'inv', i.inv_number, 'total', i.total));
  return i;
end $$;

create or replace function mark_invoice_sent(p_inv int, p_to text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform no_view_as();
  if not is_sales() then raise exception 'Only Sales'; end if;
  update invoices set sent_at = now(), updated_at = now() where id = p_inv;
  insert into events (user_email, type, details)
  values (current_email(), 'invoice_sent', jsonb_build_object('invoice_id', p_inv, 'inv', (select inv_number from invoices where id = p_inv), 'to', p_to));
end $$;

-- ---------- documents (PDF data) ----------
create or replace function _company() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'legal', coalesce((select value from app_settings where key = 'company.legal'), 'DNA Organics, Inc. (dba Lifted Farms)'),
    'address', coalesce((select value from app_settings where key = 'company.address'), '1961 Main St. #146' || chr(10) || 'Watsonville, CA 95076'),
    'email', coalesce((select value from app_settings where key = 'company.email'), 'accounting@lifted-organics.com'),
    'phone', coalesce((select value from app_settings where key = 'company.phone'), '+1 (864) 979-4797'),
    'web', coalesce((select value from app_settings where key = 'company.web'), 'www.liftedfarms.com'),
    'license', (select value from app_settings where key = 'company.license'),
    'remit', coalesce((select value from app_settings where key = 'company.remit'), 'Check payable to: DNA Organics, Inc. We accept ACH, wire transfer, cash, and check.'),
    'crypto', coalesce((select value from app_settings where key = 'company.crypto'), 'USDC and USDT stablecoins are accepted.'),
    'late', coalesce((select value from app_settings where key = 'company.late_terms'),
      'Customer agrees to pay a finance charge on the above amount at the rate of 1.5% monthly (18% annual percentage rate) if payment is not made by the due date. Customer further agrees that in the event that it becomes necessary to collect the above amount by legal action or otherwise, to pay all costs of collection including but not limited to, collection agency fees, reasonable attorney fees, and court costs.'))
$$;

create or replace function _customer_doc(p_customer int) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', c.id, 'name', c.name, 'legal_name', c.legal_name, 'license', c.license,
    'billing_address', coalesce(c.billing_address, c.address), 'billing_contact', coalesce(c.billing_contact, c.contact), 'billing_email', c.billing_email, 'billing_phone', c.billing_phone,
    'ship_to_name', coalesce(c.ship_to_name, c.legal_name, c.name), 'ship_to_address', coalesce(c.ship_to_address, c.address), 'receiving_contact', c.receiving_contact,
    'terms', c.payment_terms)
    from customers c where c.id = p_customer
$$;

create or replace function _doc(p_kind text, p_id int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o orders; i invoices; t payment_terms;
begin
  if p_kind = 'invoice' then
    select * into i from invoices where id = p_id;
    if i.id is null then return null; end if;
    select * into o from orders where id = i.order_id;
    return jsonb_build_object('kind', 'invoice', 'id', i.id, 'number', i.inv_number, 'so', o.so_number, 'po', coalesce(i.po_number, o.po_number),
      'date', i.invoice_date, 'due', i.due_date, 'terms', i.terms_label, 'terms_code', i.terms_code, 'schedule', i.schedule, 'total', i.total, 'status', i.status,
      'ship_date', o.shipped_date, 'notes', i.notes, 'token', i.share_token, 'acct_status', i.acct_status, 'sent_at', i.sent_at,
      'company', _company(), 'customer', _customer_doc(i.customer_id),
      'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'kind', l.kind, 'item', l.item, 'description', l.description, 'strain', l.strain, 'crop_year', l.crop_year,
          'qty', l.qty, 'uom', l.uom, 'price', l.price, 'amount', l.amount,
          'packages', coalesce((select jsonb_agg(jsonb_build_object('tag', p.package_tag, 'pallet', p.pallet_code, 'lbs', p.lbs, 'batch', p.batch) order by p.pallet_code) from invoice_packages p where p.invoice_line_id = l.id), '[]'))
          order by l.sort, l.id) from invoice_lines l where l.invoice_id = i.id), '[]'));
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

-- signed in: Sales, or the customer it belongs to
create or replace function get_doc(p_kind text, p_id int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare cust int;
begin
  if p_kind = 'invoice' then select customer_id into cust from invoices where id = p_id and status <> 'void';
  else select customer_id into cust from orders where id = p_id; end if;
  if not (is_sales() or (cust is not null and cust = my_customer())) then raise exception 'Not allowed'; end if;
  return _doc(p_kind, p_id);
end $$;

-- the private link (texted to a customer): anyone with the link can view and download it
create or replace function get_shared_doc(p_token uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare iid int; oid int;
begin
  select id into iid from invoices where share_token = p_token and status <> 'void';
  if iid is not null then return _doc('invoice', iid); end if;
  select id into oid from orders where share_token = p_token and status not in ('draft','cancelled');
  if oid is not null then return _doc('so', oid); end if;
  return null;
end $$;

-- app settings for the documents (Admin > Settings > App settings)
create or replace function set_app_setting(p_key text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
declare was text;
begin
  perform no_view_as();
  if not is_admin() then raise exception 'Only someone with the Admin module can change app settings'; end if;
  if p_key not in ('crop_year','company.name','company.legal','company.address','company.phone','company.email','company.web','company.license',
                   'company.remit','company.crypto','company.late_terms','app.email_from') then
    raise exception 'Unknown setting %', p_key;
  end if;
  if p_key = 'crop_year' and (p_value !~ '^\d{4}$') then raise exception 'Crop year should be like 2026'; end if;
  select value into was from app_settings where key = p_key;
  insert into app_settings values (p_key, coalesce(p_value, '')) on conflict (key) do update set value = excluded.value;
  insert into events (user_email, type, note, details)
  values (current_email(), 'app_setting', p_key, jsonb_build_object('key', p_key, 'value', p_value, 'was', was));
end $$;

revoke execute on function next_so(date), so_on_confirm(), _make_invoice(int), invoice_on_ship(), _inv_editable(int), recompute_invoice(int),
  _company(), _customer_doc(int), _doc(text, int) from public, anon, authenticated;
revoke execute on function set_payment_term(text, text, jsonb, boolean, boolean), create_order(int, jsonb, text, date, text, text, boolean), set_order_terms(int, text),
  make_invoice(int), set_invoice_terms(int, text), set_invoice_info(int, date, text, text), set_invoice_line(int, int, text, numeric, numeric, text),
  remove_invoice_line(int, int), set_invoice_status(int, text, text), mark_invoice_sent(int, text), get_doc(text, int) from public, anon;
grant execute on function set_payment_term(text, text, jsonb, boolean, boolean), create_order(int, jsonb, text, date, text, text, boolean), set_order_terms(int, text),
  make_invoice(int), set_invoice_terms(int, text), set_invoice_info(int, date, text, text), set_invoice_line(int, int, text, numeric, numeric, text),
  remove_invoice_line(int, int), set_invoice_status(int, text, text), mark_invoice_sent(int, text), get_doc(text, int) to authenticated;
grant execute on function get_shared_doc(uuid) to anon, authenticated;

select 'ok' as sales_docs;
