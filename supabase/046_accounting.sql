-- Migration 046: Accounting module, step 1: invoices to QuickBooks Online (sandbox first, then the real company).
-- Run once in Supabase after 045_transfers.sql: SQL Editor > New query > paste > Run. Safe to re-run.
--
--  * New module "Accounting" (Off / View / User / Admin in Users and access) for the accounting team.
--  * Only invoices to outside customers go to QuickBooks (Lifted's and 1PN's). Transfers to our own farms never do.
--  * Accounting sends each invoice by hand ("Send to QuickBooks"). Once it's in the real QuickBooks it's locked here,
--    and QuickBooks is the source of truth for payments: the app checks back for paid / balance.
--  * Each invoice line gets a QuickBooks product (Fresh Frozen, Biomass, Standards, Smalls, Trim, Clones, Customer Shipping,
--    discounts, returns, refunds) and a class worked out from where the product was grown and its harvest year:
--      OHR flower > 06_OHR_Flower, OHR biomass > 07_OHR_Bio, GVR 2026 on > 05_1363 GVR, GVR before 2026 > 05_1363 Green Valley,
--      shipping > 30_Distribution, outside nursery sales > 11_1PN. Discounts, returns and refunds follow the line they apply to.
--  * Shipping: Sales can put a shipping amount on an order; it lands on the invoice. Contract customers get a $0
--    "Free shipping - contract" line.
--  * The QuickBooks login (tokens) lives in tables nobody can read from the app; only the server functions can.
set client_min_messages = warning;

-- ---------- the module ----------
alter table module_access drop constraint if exists module_access_module_check;
alter table module_access add constraint module_access_module_check check (module in ('distribution','sales','cultivation','nursery','accounting','admin'));

do $$
declare f text; d text;
begin
  foreach f in array array['my_access(','my_modules(','save_user('] loop
    select pg_get_functiondef(p.oid) into d from pg_proc p where p.oid::regprocedure::text like f || '%' and p.pronamespace = 'public'::regnamespace;
    if d is not null and d not like '%''accounting''%' then execute replace(d, '''nursery'',''admin''', '''nursery'',''accounting'',''admin'''); end if;
  end loop;
  d := null;
  if to_regprocedure('set_module_level(text,text,text)') is not null then select pg_get_functiondef('set_module_level(text,text,text)'::regprocedure) into d; end if;
  if d is not null and d not like '%''accounting''%' then execute replace(d, '''cultivation'',''nursery'')', '''cultivation'',''nursery'',''accounting'')'); end if;
end $$;
create or replace function is_any_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(mod_level('distribution') = 'admin', false) or coalesce(mod_level('sales') = 'admin', false)
      or coalesce(mod_level('cultivation') = 'admin', false) or coalesce(mod_level('nursery') = 'admin', false)
      or coalesce(mod_level('accounting') = 'admin', false) or mod_level('admin') is not null
$$;

-- Accounting can see every invoice (and its PDF)
create or replace function can_see_invoice(p_inv int) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from invoices i where i.id = p_inv and (is_sales() or has_module('accounting') or (i.nursery_order_id is not null and has_module('nursery'))
                                                                  or (i.customer_id = my_customer() and i.status <> 'void')))
$$;
drop policy if exists read_inv on invoices;
create policy read_inv on invoices for select to authenticated
  using (is_sales() or has_module('accounting') or (nursery_order_id is not null and has_module('nursery')) or (customer_id = my_customer() and status <> 'void'));

-- ---------- QuickBooks products, classes and the class rules ----------
create table if not exists acct_products (
  code    text primary key,
  name    text not null unique,                 -- the product / service name in QuickBooks
  grp     text not null check (grp in ('flower','bio','clones','shipping','adjust','other')),
  sort    int not null default 0,
  active  boolean not null default true,
  notes   text
);
insert into acct_products (code, name, grp, sort) values
  ('FRESH_FROZEN', 'Fresh Frozen', 'flower', 1), ('BIOMASS', 'Biomass', 'bio', 2), ('STANDARDS', 'Standards', 'flower', 3),
  ('SMALLS', 'Smalls', 'flower', 4), ('TRIM', 'Trim', 'flower', 5), ('CLONES', 'Clones', 'clones', 6),
  ('SHIPPING', 'Customer Shipping', 'shipping', 7), ('SAMPLES_DISCOUNT', 'Samples Discount', 'adjust', 8),
  ('SALES_DISCOUNT', 'Sales Discount', 'adjust', 9), ('QUALITY_DISCOUNT', 'Quality Discount', 'adjust', 10),
  ('PRODUCT_RETURN', 'Product Return', 'adjust', 11), ('PRODUCT_REFUND', 'Product Refund', 'adjust', 12)
on conflict (code) do nothing;

create table if not exists acct_classes (
  name    text primary key,                     -- exactly as in QuickBooks
  sort    int not null default 0,
  active  boolean not null default true,
  notes   text
);
insert into acct_classes (name, sort, notes) values
  ('01_361 Webb', 1, null), ('02_0 Minto', 2, null), ('03_2869 Freedom', 3, null), ('04_600 Amesti', 4, null),
  ('05_1363 Green Valley', 5, 'GVR before 2026 (subject to the profit split)'), ('05_1363 GVR', 6, 'GVR from 2026 on'),
  ('06_OHR_Flower', 7, null), ('07_OHR_Bio', 8, null), ('08_OHR_Overhead', 9, null), ('09_OHR_Profit Distributions', 10, null),
  ('10_ADD', 11, null), ('11_1PN', 12, null), ('15_Dry Processing', 13, null), ('20_Cultivation Unallocated', 14, null),
  ('30_Distribution', 15, null), ('40_Manufacturing', 16, null), ('50_Lifted Brand', 17, null), ('60_Corporate Overhead', 18, null)
on conflict (name) do nothing;

-- first matching rule wins (lowest sort). Blank site / group / years = any.
create table if not exists acct_class_rules (
  id         serial primary key,
  sort       int not null default 0,
  site       text,                              -- OHR / GVR / 1PN
  grp        text check (grp in ('flower','bio','clones','shipping','adjust','other')),
  year_from  int,
  year_to    int,
  class_name text not null references acct_classes(name) on update cascade,
  notes      text
);
insert into acct_class_rules (sort, site, grp, year_from, year_to, class_name, notes)
select * from (values
  (10, null, 'shipping', null::int, null::int, '30_Distribution', 'Shipping charged to customers'),
  (20, '1PN', null, null, null, '11_1PN', 'Outside nursery sales'),
  (30, null, 'clones', null, null, '11_1PN', 'Clones'),
  (40, 'GVR', null, 2026, null, '05_1363 GVR', 'Harvested 2026 or later'),
  (50, 'GVR', null, null, 2025, '05_1363 Green Valley', 'Harvested before 2026 (profit split)'),
  (60, 'OHR', 'bio', null, null, '07_OHR_Bio', null),
  (70, 'OHR', null, null, null, '06_OHR_Flower', null)
) v(sort, site, grp, year_from, year_to, class_name, notes)
where not exists (select 1 from acct_class_rules);

alter table acct_products enable row level security;
alter table acct_classes enable row level security;
alter table acct_class_rules enable row level security;
drop policy if exists read_acct on acct_products; drop policy if exists read_acct on acct_classes; drop policy if exists read_acct on acct_class_rules;
create policy read_acct on acct_products for select to authenticated using (is_staff());
create policy read_acct on acct_classes for select to authenticated using (is_staff());
create policy read_acct on acct_class_rules for select to authenticated using (has_module('accounting') or is_sales());
grant select on acct_products, acct_classes, acct_class_rules to authenticated;

-- ---------- invoice lines: product, class, what a discount applies to ----------
alter table invoice_lines add column if not exists acct_product text references acct_products(code) on update cascade;
alter table invoice_lines add column if not exists acct_class text references acct_classes(name) on update cascade;   -- blank = from the rules
alter table invoice_lines add column if not exists applies_to int references invoice_lines(id) on delete set null;

create or replace function acct_guess_product(p_kind text, p_item text, p_desc text) returns text
language sql immutable as $$
  select case
    when coalesce(p_item, '') ~* '^fresh frozen' or (p_kind = 'product' and coalesce(p_desc, '') ~* 'fresh frozen') then 'FRESH_FROZEN'
    when coalesce(p_item, '') ~* '^clone' or coalesce(p_desc, '') ~* 'rooted clone' then 'CLONES'
    when coalesce(p_item, '') || ' ' || coalesce(p_desc, '') ~* 'biomass' then 'BIOMASS'
    when coalesce(p_item, '') || ' ' || coalesce(p_desc, '') ~* 'smalls' then 'SMALLS'
    when coalesce(p_item, '') || ' ' || coalesce(p_desc, '') ~* 'standard' then 'STANDARDS'
    when coalesce(p_item, '') || ' ' || coalesce(p_desc, '') ~* '\mtrim\M' then 'TRIM'
    when coalesce(p_desc, '') ~* 'ship|freight|delivery' then 'SHIPPING'
    when coalesce(p_desc, '') ~* 'sample' then 'SAMPLES_DISCOUNT'
    when coalesce(p_desc, '') ~* 'quality' then 'QUALITY_DISCOUNT'
    when coalesce(p_desc, '') ~* 'refund' then 'PRODUCT_REFUND'
    when coalesce(p_desc, '') ~* 'return' then 'PRODUCT_RETURN'
    when coalesce(p_desc, '') ~* 'discount' then 'SALES_DISCOUNT'
  end
$$;
create or replace function invoice_line_product() returns trigger
language plpgsql as $$
begin
  if new.acct_product is null then new.acct_product := acct_guess_product(new.kind, new.item, new.description); end if;
  return new;
end $$;
drop trigger if exists invoice_line_product on invoice_lines;
create trigger invoice_line_product before insert on invoice_lines for each row execute function invoice_line_product();
update invoice_lines set acct_product = acct_guess_product(kind, item, description) where acct_product is null;

-- ---------- shipping on orders ----------
alter table orders add column if not exists shipping numeric;   -- blank = none (contract customers get a $0 line)

create or replace function is_contract_customer(p_customer int) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select contract_lbs > 0 from terms_for(p_customer, crop_year())), false)
      or exists (select 1 from reserves r where r.customer_id = p_customer and r.crop_year = crop_year() and r.lbs > 0)
$$;

create or replace function set_order_shipping(p_order int, p_amount numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform no_view_as();
  if not can_edit('sales') then raise exception 'Only Sales can change shipping'; end if;
  if p_amount < 0 then raise exception 'Shipping can''t be negative'; end if;
  update orders set shipping = p_amount, updated_at = now() where id = p_order;
  if not found then raise exception 'Order not found'; end if;
end $$;

-- a new order invoice gets its shipping line (Sales can still change it on the invoice)
create or replace function invoice_shipping_line() returns trigger
language plpgsql security definer set search_path = public as $$
declare o orders; c customers;
begin
  if new.order_id is null or new.nursery_order_id is not null then return new; end if;
  select * into o from orders where id = new.order_id;
  select * into c from customers where id = new.customer_id;
  if c.kind is distinct from 'external' then return new; end if;
  if coalesce(o.shipping, 0) > 0 then
    insert into invoice_lines (invoice_id, sort, kind, item, description, qty, uom, price, acct_product)
    values (new.id, 1000, 'charge', 'Customer Shipping', 'Shipping', 1, 'ea', o.shipping, 'SHIPPING');
  elsif is_contract_customer(new.customer_id) then
    insert into invoice_lines (invoice_id, sort, kind, item, description, qty, uom, price, acct_product)
    values (new.id, 1000, 'charge', 'Customer Shipping', 'Free shipping - contract', 1, 'ea', 0, 'SHIPPING');
  elsif o.shipping = 0 then
    insert into invoice_lines (invoice_id, sort, kind, item, description, qty, uom, price, acct_product)
    values (new.id, 1000, 'charge', 'Customer Shipping', 'Free shipping', 1, 'ea', 0, 'SHIPPING');
  end if;
  return new;
end $$;
drop trigger if exists invoice_shipping_line on invoices;
create trigger invoice_shipping_line after insert on invoices for each row execute function invoice_shipping_line();

-- ---------- QuickBooks connection (server only) ----------
create table if not exists qbo_connection (
  env               text primary key check (env in ('sandbox','production')),
  active            boolean not null default false,
  realm_id          text not null,
  company_name      text,
  access_token      text,
  refresh_token     text,
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  connected_by      text,
  connected_at      timestamptz not null default now(),
  last_sync_at      timestamptz,
  last_error        text
);
create table if not exists qbo_oauth_states (
  state      text primary key,
  email      text not null,
  env        text not null,
  created_at timestamptz not null default now()
);
-- QuickBooks ids for our customers, products, classes and terms (per environment: the sandbox has its own)
create table if not exists qbo_refs (
  env        text not null,
  kind       text not null check (kind in ('customer','item','class','term')),
  key        text not null,
  qbo_id     text not null,
  name       text,
  updated_at timestamptz not null default now(),
  primary key (env, kind, key)
);
-- each time an invoice goes to QuickBooks (one row per invoice per environment)
create table if not exists acct_pushes (
  invoice_id  int not null references invoices(id) on delete cascade,
  env         text not null,
  status      text not null check (status in ('sent','error')),
  qbo_id      text,
  doc_number  text,
  total       numeric,
  balance     numeric,
  error       text,
  sent_by     text,
  sent_at     timestamptz not null default now(),
  synced_at   timestamptz,
  primary key (invoice_id, env)
);
alter table qbo_connection enable row level security;
alter table qbo_oauth_states enable row level security;
alter table qbo_refs enable row level security;
alter table acct_pushes enable row level security;
revoke all on qbo_connection, qbo_oauth_states from anon, authenticated;
drop policy if exists read_acct on qbo_refs; drop policy if exists read_acct on acct_pushes;
create policy read_acct on qbo_refs for select to authenticated using (has_module('accounting'));
create policy read_acct on acct_pushes for select to authenticated using (has_module('accounting') or is_sales());
grant select on qbo_refs, acct_pushes to authenticated;
grant all on qbo_connection, qbo_oauth_states, qbo_refs, acct_pushes, acct_products, acct_classes, acct_class_rules to service_role;
grant usage, select on all sequences in schema public to service_role;

create or replace function acct_env() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select env from qbo_connection where active order by connected_at desc limit 1), 'sandbox')
$$;

-- what the app shows about the connection (never the tokens)
create or replace function acct_connection() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_module('accounting') then raise exception 'The Accounting module isn''t switched on for your account'; end if;
  return jsonb_build_object('env', acct_env(), 'connections', coalesce((select jsonb_agg(jsonb_build_object(
      'env', env, 'active', active, 'company', company_name, 'realm', realm_id, 'connected_by', connected_by, 'connected_at', connected_at,
      'last_sync_at', last_sync_at, 'last_error', last_error, 'expired', refresh_expires_at < now()) order by env) from qbo_connection), '[]'));
end $$;

-- who's asking (the server functions call this with the person's own login)
create or replace function acct_me() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('email', current_email(), 'level', mod_level('accounting'), 'can_edit', can_edit('accounting'),
                            'admin', is_mod_admin('accounting') or is_owner(), 'viewing_as', impersonating())
$$;

-- ---------- how an invoice line maps to QuickBooks ----------
create or replace function acct_class_for(p_site text, p_grp text, p_year int) returns text
language sql stable security definer set search_path = public as $$
  select class_name from acct_class_rules
   where (site is null or upper(site) = upper(coalesce(p_site, ''))) and (grp is null or grp = p_grp)
     and (year_from is null or p_year >= year_from) and (year_to is null or p_year <= year_to)
   order by sort, id limit 1
$$;

-- the farm a package was grown at, from its METRC batch (FL26-GV-..., FL26-OH-...) or the Roshi SKU farm
create or replace function acct_pkg_site(p_batch text, p_farm text) returns text
language sql immutable as $$
  select case when coalesce(p_batch, '') ~* '^FL\d\d-GV' then 'GVR' when coalesce(p_batch, '') ~* '^FL\d\d-OH' then 'OHR'
              when upper(coalesce(p_farm, '')) like 'GV%' then 'GVR' when upper(coalesce(p_farm, '')) like 'OH%' then 'OHR' end
$$;

-- every QuickBooks line for one invoice: product lines split by farm when the packages came from both
create or replace function acct_invoice_lines(p_inv int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare i invoices; l record; res jsonb := '[]'; part record; n int; k int; left_qty numeric; q numeric; tot_lbs numeric;
        site text; yr int; cls text; pr acct_products; desc_ text; tags text; batches text; main_cls text; main_amt numeric := -1;
        adj jsonb := '[]'; a jsonb; tgt jsonb;
begin
  select * into i from invoices where id = p_inv;
  for l in select il.*, ol.farm from invoice_lines il left join order_lines ol on ol.id = il.order_line_id
            where il.invoice_id = p_inv order by il.sort, il.id loop
    select * into pr from acct_products where code = l.acct_product;
    if pr.grp = 'adjust' then
      adj := adj || jsonb_build_object('line_id', l.id, 'product', pr.code, 'item', pr.name, 'grp', pr.grp, 'description', l.description,
               'qty', l.qty, 'price', l.price, 'amount', l.amount, 'applies_to', l.applies_to, 'class', l.acct_class, 'class_set', l.acct_class, 'kind', l.kind);
      continue;
    end if;
    -- the farms this line's packages came from
    if i.nursery_order_id is not null then
      n := 0;
    else
      select count(distinct acct_pkg_site(p.batch, l.farm)) into n from invoice_packages p where p.invoice_line_id = l.id and acct_pkg_site(p.batch, l.farm) is not null;
    end if;
    yr := coalesce(l.crop_year, (select ('20' || substring(min(p.batch) from '^FL(\d\d)'))::int from invoice_packages p where p.invoice_line_id = l.id), extract(year from i.invoice_date)::int);
    if n <= 1 then
      site := case when i.nursery_order_id is not null then '1PN'
                   else coalesce((select acct_pkg_site(p.batch, l.farm) from invoice_packages p where p.invoice_line_id = l.id and acct_pkg_site(p.batch, l.farm) is not null limit 1),
                                 acct_pkg_site(null, l.farm),
                                 case when pr.grp in ('flower','bio') then (select x.site from licenses x where x.license_no = i.seller_license) end) end;
      cls := coalesce(l.acct_class, case when pr.code is not null then acct_class_for(site, pr.grp, yr) end);
      select string_agg(distinct p.batch, ', ') filter (where p.batch is not null), string_agg(p.package_tag, ', ' order by p.package_tag) filter (where p.package_tag is not null)
        into batches, tags from invoice_packages p where p.invoice_line_id = l.id;
      desc_ := l.description || case when batches is not null then E'\nBatch ' || batches else '' end || case when tags is not null then E'\nTags ' || tags else '' end;
      res := res || jsonb_build_object('line_id', l.id, 'product', pr.code, 'item', pr.name, 'grp', pr.grp, 'site', site, 'year', yr, 'class', cls,
                     'description', left(desc_, 4000), 'qty', l.qty, 'price', l.price, 'amount', l.amount, 'uom', l.uom, 'class_set', l.acct_class, 'kind', l.kind);
      if pr.grp in ('flower','bio','clones') and l.amount > main_amt then main_amt := l.amount; main_cls := cls; end if;
    else
      -- packages from both farms: one QuickBooks line per farm, quantity from each farm's package lbs
      select sum(coalesce(p.lbs, 0)) into tot_lbs from invoice_packages p where p.invoice_line_id = l.id;
      k := 0; left_qty := l.qty;
      for part in select acct_pkg_site(p.batch, l.farm) s, sum(coalesce(p.lbs, 0)) lbs, string_agg(distinct p.batch, ', ') b,
                         string_agg(p.package_tag, ', ' order by p.package_tag) filter (where p.package_tag is not null) t
                    from invoice_packages p where p.invoice_line_id = l.id and acct_pkg_site(p.batch, l.farm) is not null group by 1 order by 1 loop
        k := k + 1;
        q := case when k = n then left_qty when tot_lbs > 0 then round(l.qty * part.lbs / tot_lbs, 2) else round(l.qty / n, 2) end;
        left_qty := left_qty - q;
        cls := coalesce(l.acct_class, acct_class_for(part.s, pr.grp, yr));
        desc_ := l.description || ' (' || part.s || ')' || case when part.b is not null then E'\nBatch ' || part.b else '' end || case when part.t is not null then E'\nTags ' || part.t else '' end;
        res := res || jsonb_build_object('line_id', l.id, 'product', pr.code, 'item', pr.name, 'grp', pr.grp, 'site', part.s, 'year', yr, 'class', cls,
                       'description', left(desc_, 4000), 'qty', q, 'price', l.price, 'amount', round(q * l.price, 2), 'uom', l.uom, 'split', true, 'class_set', l.acct_class, 'kind', l.kind);
        if round(q * l.price, 2) > main_amt then main_amt := round(q * l.price, 2); main_cls := cls; end if;
      end loop;
    end if;
  end loop;
  -- discounts, returns, refunds: the class of the line they apply to (or the invoice's biggest product line)
  for a in select * from jsonb_array_elements(adj) loop
    select x into tgt from jsonb_array_elements(res) x where (x ->> 'line_id')::int = (a ->> 'applies_to')::int order by (x ->> 'amount')::numeric desc limit 1;
    res := res || (a || jsonb_build_object('class', coalesce(a ->> 'class', tgt ->> 'class', main_cls), 'site', tgt ->> 'site', 'year', tgt ->> 'year'));
  end loop;
  return res;
end $$;

-- everything the server needs to send one invoice (and what's stopping it)
create or replace function acct_invoice_payload(p_inv int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare i invoices; c customers; ls jsonb; probs jsonb := '[]'; x jsonb; memo text; first_due date; sched text; v_env text := acct_env(); pu acct_pushes;
begin
  if not (auth.role() = 'service_role' or has_module('accounting') or is_sales()) then raise exception 'Not allowed'; end if;
  select * into i from invoices where id = p_inv;
  if i.id is null then raise exception 'Invoice not found'; end if;
  select * into c from customers where id = i.customer_id;
  ls := acct_invoice_lines(p_inv);
  for x in select * from jsonb_array_elements(ls) loop
    if x ->> 'product' is null then probs := probs || to_jsonb(format('"%s" has no QuickBooks product. Pick one.', split_part(x ->> 'description', E'\n', 1))); end if;
    if x ->> 'class' is null and x ->> 'product' is not null then probs := probs || to_jsonb(format('"%s" has no class (farm or year unknown). Pick one.', split_part(x ->> 'description', E'\n', 1))); end if;
  end loop;
  if c.kind is distinct from 'external' then probs := probs || to_jsonb(format('%s is one of our own farms. Internal transfers don''t go to QuickBooks.', c.name)); end if;
  if i.status = 'void' then probs := probs || to_jsonb('This invoice is void.'::text); end if;
  if jsonb_array_length(ls) = 0 then probs := probs || to_jsonb('No lines on this invoice.'::text); end if;
  -- split terms: QuickBooks gets the first due date; the split goes in the memo
  first_due := (select min((s ->> 'due')::date) from jsonb_array_elements(i.schedule) s);
  if jsonb_array_length(i.schedule) > 1 then
    select string_agg(format('%s%% ($%s) due %s', (s ->> 'pct'), to_char((s ->> 'amount')::numeric, 'FM999,999,990.00'), to_char((s ->> 'due')::date, 'MM/DD/YYYY')), ', ')
      into sched from jsonb_array_elements(i.schedule) s;
    sched := 'Payment terms: ' || i.terms_label || ': ' || sched;
  end if;
  memo := concat_ws(E'\n', sched, case when i.po_number is not null then 'PO ' || i.po_number end, i.notes);
  select * into pu from acct_pushes x where x.invoice_id = p_inv and x.env = v_env;
  return jsonb_build_object(
    'env', v_env, 'invoice_id', i.id, 'doc_number', i.inv_number, 'date', i.invoice_date, 'due', coalesce(first_due, i.due_date),
    'terms', i.terms_label, 'terms_code', i.terms_code, 'total', i.total, 'status', i.status, 'memo', nullif(memo, ''),
    'po', i.po_number, 'seller_license', i.seller_license, 'nursery', i.nursery_order_id is not null,
    'so', coalesce((select so_number from orders where id = i.order_id), (select so_number from cult_nursery_orders where id = i.nursery_order_id)),
    'customer', jsonb_build_object('id', c.id, 'name', c.name, 'legal_name', coalesce(nullif(c.legal_name, ''), c.name), 'kind', c.kind,
        'email', c.billing_email, 'phone', c.billing_phone, 'contact', c.billing_contact, 'billing_address', c.billing_address,
        'ship_to_name', c.ship_to_name, 'ship_to_address', coalesce(c.ship_to_address, c.address), 'license', c.license,
        'qbo_id', (select qbo_id from qbo_refs where env = acct_env() and kind = 'customer' and key = c.id::text)),
    'lines', ls, 'problems', probs,
    'push', case when pu.invoice_id is not null then jsonb_build_object('status', pu.status, 'qbo_id', pu.qbo_id, 'doc_number', pu.doc_number, 'balance', pu.balance,
              'total', pu.total, 'error', pu.error, 'sent_by', pu.sent_by, 'sent_at', pu.sent_at, 'synced_at', pu.synced_at) end);
end $$;

-- ---------- Accounting: the invoice list ----------
create or replace function acct_invoices() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_env text := acct_env();
begin
  if not has_module('accounting') then raise exception 'The Accounting module isn''t switched on for your account'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', i.id, 'inv', i.inv_number, 'date', i.invoice_date, 'due', i.due_date, 'total', i.total, 'status', i.status, 'terms', i.terms_label,
      'customer_id', i.customer_id, 'customer', c.name, 'outside', c.kind = 'external', 'nursery', i.nursery_order_id is not null,
      'acct_status', i.acct_status, 'acct_ref', i.acct_ref, 'paid_at', i.paid_at,
      'so', coalesce(o.so_number, n.so_number),
      'push', case when p.invoice_id is not null then jsonb_build_object('status', p.status, 'qbo_id', p.qbo_id, 'doc_number', p.doc_number,
                'balance', p.balance, 'total', p.total, 'error', p.error, 'sent_by', p.sent_by, 'sent_at', p.sent_at, 'synced_at', p.synced_at) end)
      order by i.invoice_date desc, i.id desc)
    from invoices i join customers c on c.id = i.customer_id
    left join orders o on o.id = i.order_id left join cult_nursery_orders n on n.id = i.nursery_order_id
    left join acct_pushes p on p.invoice_id = i.id and p.env = v_env), '[]');
end $$;

-- ---------- changing products and classes on lines (Sales or Accounting, until it's in the real QuickBooks) ----------
create or replace function acct_set_line(p_inv int, p_line int, p_product text, p_class text, p_applies_to int default null) returns void
language plpgsql security definer set search_path = public as $$
declare i invoices;
begin
  perform no_view_as();
  if not (can_edit('accounting') or _can_bill(p_inv)) then raise exception 'Only Sales or Accounting can change this'; end if;
  select * into i from invoices where id = p_inv;
  if i.acct_status = 'sent' then raise exception '% is already in QuickBooks. Change it there.', i.inv_number; end if;
  if nullif(p_product, '') is not null and not exists (select 1 from acct_products where code = p_product) then raise exception 'Unknown product'; end if;
  if nullif(p_class, '') is not null and not exists (select 1 from acct_classes where name = p_class) then raise exception 'Unknown class'; end if;
  update invoice_lines set acct_product = nullif(p_product, ''), acct_class = nullif(p_class, ''),
         applies_to = case when p_applies_to is not null and exists (select 1 from invoice_lines x where x.id = p_applies_to and x.invoice_id = p_inv) then p_applies_to end
   where id = p_line and invoice_id = p_inv;
  if not found then raise exception 'Line not found'; end if;
end $$;

-- add a charge or discount line with its product (shipping, discounts, returns, refunds)
create or replace function acct_add_line(p_inv int, p_product text, p_description text, p_qty numeric, p_price numeric, p_applies_to int default null) returns void
language plpgsql security definer set search_path = public as $$
declare pr acct_products;
begin
  perform _inv_editable(p_inv);
  select * into pr from acct_products where code = p_product;
  if pr.code is null then raise exception 'Pick a product'; end if;
  insert into invoice_lines (invoice_id, sort, kind, item, description, qty, uom, price, acct_product, applies_to)
  values (p_inv, (select coalesce(max(sort), 0) + 1 from invoice_lines where invoice_id = p_inv), 'charge', pr.name,
          coalesce(nullif(trim(p_description), ''), pr.name), coalesce(p_qty, 1), 'ea',
          case when pr.grp = 'adjust' then -abs(coalesce(p_price, 0)) else coalesce(p_price, 0) end, pr.code,
          case when exists (select 1 from invoice_lines x where x.id = p_applies_to and x.invoice_id = p_inv) then p_applies_to end);
  perform recompute_invoice(p_inv);
end $$;

-- Sales could already edit invoices; Accounting can too (until it's in the real QuickBooks)
create or replace function _can_bill(p_inv int) returns boolean
language sql stable security definer set search_path = public as $$
  select can_edit('sales') or can_edit('accounting') or exists (select 1 from invoices where id = p_inv and nursery_order_id is not null and can_edit('nursery'))
$$;

-- payments: once an invoice is in the real QuickBooks, it's paid when QuickBooks says so
do $$
declare d text;
begin
  select pg_get_functiondef('set_invoice_status(int,text,text)'::regprocedure) into d;
  if d not like '%recorded in QuickBooks%' then
    execute replace(d, 'select * into i from invoices where id = p_inv;',
      'select * into i from invoices where id = p_inv;
  if i.acct_status = ''sent'' and p_status in (''open'',''paid'') then raise exception ''% is in QuickBooks. Payments are recorded in QuickBooks and show up here on the next sync.'', i.inv_number; end if;
  if i.acct_status = ''sent'' and p_status = ''void'' then raise exception ''% is in QuickBooks. Void it there.'', i.inv_number; end if;');
  end if;
end $$;

-- ---------- Accounting settings (Accounting Admins) ----------
create or replace function acct_save_product(p_code text, p_name text, p_grp text, p_active boolean default true) returns void
language plpgsql security definer set search_path = public as $$
declare c text := upper(regexp_replace(trim(coalesce(p_code, '')), '[^A-Za-z0-9]+', '_', 'g'));
begin
  perform no_view_as();
  if not (is_mod_admin('accounting') or is_owner()) then raise exception 'Only an Accounting Admin can change products'; end if;
  if c = '' then c := upper(regexp_replace(trim(p_name), '[^A-Za-z0-9]+', '_', 'g')); end if;
  if nullif(trim(p_name), '') is null then raise exception 'Name it exactly as in QuickBooks'; end if;
  insert into acct_products (code, name, grp, active, sort) values (c, trim(p_name), p_grp, coalesce(p_active, true), (select coalesce(max(sort), 0) + 1 from acct_products))
  on conflict (code) do update set name = excluded.name, grp = excluded.grp, active = excluded.active;
  delete from qbo_refs where kind = 'item' and key = c;   -- renamed: match it again in QuickBooks
  insert into events (user_email, type, note, details) values (current_email(), 'acct_settings', 'product', jsonb_build_object('code', c, 'name', p_name, 'grp', p_grp, 'active', p_active));
end $$;

create or replace function acct_save_class(p_name text, p_old text default null, p_active boolean default true) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform no_view_as();
  if not (is_mod_admin('accounting') or is_owner()) then raise exception 'Only an Accounting Admin can change classes'; end if;
  if nullif(trim(p_name), '') is null then raise exception 'Name it exactly as in QuickBooks'; end if;
  if nullif(p_old, '') is not null and p_old <> trim(p_name) then
    update acct_classes set name = trim(p_name), active = coalesce(p_active, true) where name = p_old;
    delete from qbo_refs where kind = 'class' and key in (p_old, trim(p_name));
  else
    insert into acct_classes (name, active, sort) values (trim(p_name), coalesce(p_active, true), (select coalesce(max(sort), 0) + 1 from acct_classes))
    on conflict (name) do update set active = excluded.active;
  end if;
  insert into events (user_email, type, note, details) values (current_email(), 'acct_settings', 'class', jsonb_build_object('name', p_name, 'was', p_old, 'active', p_active));
end $$;

-- p_rules: [{"site": "GVR", "grp": null, "year_from": 2026, "year_to": null, "class_name": "05_1363 GVR", "notes": "..."}, …] in order
create or replace function acct_save_rules(p_rules jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r jsonb; k int := 0;
begin
  perform no_view_as();
  if not (is_mod_admin('accounting') or is_owner()) then raise exception 'Only an Accounting Admin can change the class rules'; end if;
  delete from acct_class_rules;
  for r in select * from jsonb_array_elements(coalesce(p_rules, '[]')) loop
    k := k + 1;
    if not exists (select 1 from acct_classes where name = r ->> 'class_name') then raise exception 'Unknown class %', r ->> 'class_name'; end if;
    insert into acct_class_rules (sort, site, grp, year_from, year_to, class_name, notes)
    values (k * 10, nullif(upper(trim(r ->> 'site')), ''), nullif(r ->> 'grp', ''), nullif(r ->> 'year_from', '')::int, nullif(r ->> 'year_to', '')::int,
            r ->> 'class_name', nullif(trim(r ->> 'notes'), ''));
  end loop;
  insert into events (user_email, type, note, details) values (current_email(), 'acct_settings', 'class rules', jsonb_build_object('rules', p_rules));
end $$;

-- forget a QuickBooks match (so the next send looks it up again)
create or replace function acct_forget_ref(p_kind text, p_key text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform no_view_as();
  if not (is_mod_admin('accounting') or is_owner()) then raise exception 'Only an Accounting Admin'; end if;
  delete from qbo_refs where env = acct_env() and kind = p_kind and key = p_key;
end $$;

-- ---------- written by the server functions only (service role) ----------
create or replace function acct_record_push(p_inv int, p_env text, p_qbo_id text, p_doc text, p_total numeric, p_balance numeric, p_error text, p_by text) returns void
language plpgsql security definer set search_path = public as $$
declare i invoices;
begin
  if auth.role() <> 'service_role' then raise exception 'Server only'; end if;
  select * into i from invoices where id = p_inv;
  if p_error is null then
    insert into acct_pushes (invoice_id, env, status, qbo_id, doc_number, total, balance, error, sent_by, sent_at, synced_at)
    values (p_inv, p_env, 'sent', p_qbo_id, p_doc, p_total, p_balance, null, p_by, now(), now())
    on conflict (invoice_id, env) do update set status = 'sent', qbo_id = excluded.qbo_id, doc_number = excluded.doc_number, total = excluded.total,
      balance = excluded.balance, error = null, sent_by = excluded.sent_by, sent_at = now(), synced_at = now();
    if p_env = 'production' then
      update invoices set acct_status = 'sent', acct_ref = p_qbo_id, acct_error = null, updated_at = now() where id = p_inv;
    end if;
  else
    insert into acct_pushes (invoice_id, env, status, error, sent_by, sent_at)
    values (p_inv, p_env, 'error', p_error, p_by, now())
    on conflict (invoice_id, env) do update set status = case when acct_pushes.status = 'sent' then 'sent' else 'error' end,
      error = excluded.error, sent_by = excluded.sent_by, sent_at = case when acct_pushes.status = 'sent' then acct_pushes.sent_at else now() end;
    if p_env = 'production' and i.acct_status <> 'sent' then
      update invoices set acct_status = 'error', acct_error = p_error, updated_at = now() where id = p_inv;
    end if;
  end if;
  insert into events (user_email, type, note, details)
  values (coalesce(p_by, 'system'), case when p_error is null then 'acct_sent' else 'acct_error' end, p_error,
          jsonb_build_object('invoice_id', p_inv, 'inv', i.inv_number, 'env', p_env, 'qbo_id', p_qbo_id, 'total', p_total));
end $$;

-- p_rows: [{"invoice_id": 1, "balance": 0, "total": 1200, "deleted": false}, …]
create or replace function acct_record_sync(p_env text, p_rows jsonb, p_error text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; i invoices; paid int := 0; reopened int := 0; changed int := 0;
begin
  if auth.role() <> 'service_role' then raise exception 'Server only'; end if;
  update qbo_connection set last_sync_at = now(), last_error = p_error where env = p_env;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]')) loop
    update acct_pushes set balance = (r ->> 'balance')::numeric, total = coalesce((r ->> 'total')::numeric, total), synced_at = now(),
           error = case when (r ->> 'deleted')::boolean then 'Not found in QuickBooks (deleted or voided there?)' else null end
     where invoice_id = (r ->> 'invoice_id')::int and env = p_env;
    if p_env <> 'production' then continue; end if;
    select * into i from invoices where id = (r ->> 'invoice_id')::int;
    if i.id is null or i.status = 'void' then continue; end if;
    if coalesce((r ->> 'deleted')::boolean, false) then changed := changed + 1; continue; end if;
    if (r ->> 'balance')::numeric <= 0 and i.status = 'open' then
      update invoices set status = 'paid', paid_at = current_date, updated_at = now() where id = i.id; paid := paid + 1;
      insert into events (user_email, type, details) values ('quickbooks', 'invoice_paid', jsonb_build_object('invoice_id', i.id, 'inv', i.inv_number, 'total', i.total, 'via', 'QuickBooks'));
    elsif (r ->> 'balance')::numeric > 0 and i.status = 'paid' then
      update invoices set status = 'open', paid_at = null, updated_at = now() where id = i.id; reopened := reopened + 1;
    end if;
    if (r ->> 'total')::numeric is distinct from i.total then changed := changed + 1; end if;
  end loop;
  return jsonb_build_object('paid', paid, 'reopened', reopened, 'changed', changed);
end $$;

revoke execute on function acct_record_push(int,text,text,text,numeric,numeric,text,text) from public, anon, authenticated;
revoke execute on function acct_record_sync(text,jsonb,text) from public, anon, authenticated;
grant execute on function acct_record_push(int,text,text,text,numeric,numeric,text,text) to service_role;
grant execute on function acct_record_sync(text,jsonb,text) to service_role;
grant execute on all functions in schema public to service_role;

-- ---------- Accounting dashboard numbers ----------
create or replace function acct_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_env text := acct_env(); mo date := date_trunc('month', current_date)::date;
begin
  if not has_module('accounting') then raise exception 'The Accounting module isn''t switched on for your account'; end if;
  return (select jsonb_build_object(
    'env', v_env,
    'to_send', count(*) filter (where c.kind = 'external' and i.status <> 'void' and coalesce(p.status, '') <> 'sent'),
    'to_send_amt', coalesce(sum(i.total) filter (where c.kind = 'external' and i.status <> 'void' and coalesce(p.status, '') <> 'sent'), 0),
    'errors', count(*) filter (where p.status = 'error' and i.status <> 'void'),
    'sent_month', count(*) filter (where p.status = 'sent' and p.sent_at >= mo),
    'sent_month_amt', coalesce(sum(p.total) filter (where p.status = 'sent' and p.sent_at >= mo), 0),
    'unpaid', count(*) filter (where p.status = 'sent' and coalesce(p.balance, p.total) > 0),
    'unpaid_amt', coalesce(sum(coalesce(p.balance, p.total)) filter (where p.status = 'sent' and coalesce(p.balance, p.total) > 0), 0),
    'overdue', count(*) filter (where p.status = 'sent' and coalesce(p.balance, p.total) > 0 and i.due_date < current_date),
    'overdue_amt', coalesce(sum(coalesce(p.balance, p.total)) filter (where p.status = 'sent' and coalesce(p.balance, p.total) > 0 and i.due_date < current_date), 0),
    'missing_product', (select count(distinct il.invoice_id) from invoice_lines il join invoices i2 on i2.id = il.invoice_id join customers c2 on c2.id = i2.customer_id
                         left join acct_pushes p2 on p2.invoice_id = i2.id and p2.env = v_env
                        where il.acct_product is null and c2.kind = 'external' and i2.status <> 'void' and coalesce(p2.status, '') <> 'sent'),
    'last_sync', (select last_sync_at from qbo_connection where env = acct_env()))
    from invoices i join customers c on c.id = i.customer_id left join acct_pushes p on p.invoice_id = i.id and p.env = v_env);
end $$;

grant execute on function acct_connection(), acct_me(), acct_invoices(), acct_invoice_payload(int), acct_set_line(int,int,text,text,int), acct_add_line(int,text,text,numeric,numeric,int),
  acct_save_product(text,text,text,boolean), acct_save_class(text,text,boolean), acct_save_rules(jsonb), acct_forget_ref(text,text), acct_overview(),
  set_order_shipping(int,numeric), is_contract_customer(int), acct_env(), acct_invoice_lines(int), acct_class_for(text,text,int) to authenticated;

select (select count(*) from acct_products) as qbo_products, (select count(*) from acct_classes) as qbo_classes,
       (select count(*) from acct_class_rules) as class_rules,
       (select count(*) from invoices i join customers c on c.id = i.customer_id where c.kind = 'external' and i.status <> 'void') as outside_invoices,
       (select count(*) from invoice_lines where acct_product is null) as lines_without_a_product;
