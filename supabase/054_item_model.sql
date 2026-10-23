-- Migration 054: the item model (see the project doc "Item Model: Plan and Decisions").
--  * Finishes: the BC finish codes (FF, DH, UF, BF, ST, SM, TR, BT, DB, DS, CL, UR, IP, MS, SD), each mapped to the
--    pallet product it stands for.
--  * Strains get a permanent 3-digit number (strain_no, never reused) and a default grade (SHO / BHO).
--  * Items (SKUs): crop year + farm + cert + finish + strain, e.g. FL26-OH-OCAL-FF-AppleTartz, with the METRC item name
--    kept word for word, the license it lives on, Roshi category, accounting class and default price.
--    Pallets point to their item. Items are made automatically the first time a pallet needs one (metrc_status 'to_create'
--    until it's confirmed in METRC).
--  * Harvest lots: one strain at one farm, planted together and harvested together = one METRC harvest batch.
--    Code FL26-OH-047-01 (season + year, farm, strain number, lot #). Harvests (cult_harvests) belong to a lot; pallets
--    follow their harvest, and split pieces follow their parent. 2026 lots keep the METRC harvest name already in use.
--  * Grade (SHO / BHO): strain default > lot > pallet. pallet_grade(p) gives the one that applies.
--    set_lot_grade / set_pallet_grade change it (Production or Sales Admins) and report what's held and already shipped.
--  * Prices per strain per grade: a default list per crop year, plus customer overrides. price_for() picks one.
--  * Customer wash feedback logged against a lot.
--  * Grade on reserves, order lines and invoice lines (blank on an order line = either).
-- Nothing in the app uses these yet; screens come next. Run after 053. Safe to re-run.
set client_min_messages = warning;

-- ---------- finishes ----------
create table if not exists finishes (
  code            text primary key,
  name            text not null,
  pallet_product  text unique,          -- pallets.product value it stands for (null = not a pallet product yet)
  metrc_label     text,                 -- what goes after "OCAL" in the METRC item name
  uom             text not null default 'lb',
  sort            int not null default 0,
  active          boolean not null default true
);
insert into finishes (code, name, pallet_product, metrc_label, uom, sort) values
  ('FF', 'Fresh Frozen',                  'fresh_frozen', 'Fresh Frozen',            'lb',  1),
  ('DH', 'Dry Harvest (Wet Weight)',      'wet',          'Dry Harvest',             'lb',  2),
  ('UF', 'Unbucked Dry Flower',           'unbucked',     'Unbucked Dry Flower',     'lb',  3),
  ('BF', 'Bucked Dry Flower',             'bucked',       'Bucked Dry Flower',       'lb',  4),
  ('ST', 'Standards',                     'standards',    'Standards',               'lb',  5),
  ('SM', 'Smalls',                        'smalls',       'Smalls',                  'lb',  6),
  ('TR', 'Trim (Dry Flower)',             'trim',         'Dry Trim',                'lb',  7),
  ('BT', 'Trim (Bucked Flower)',          null,           'Bucking Trim',            'lb',  8),
  ('DB', 'Dry Extraction Biomass',        null,           'Dry Biomass',             'lb',  9),
  ('DS', 'Dry Extraction Biomass (Dry Sift)', null,       'Dry Sift Biomass',        'lb', 10),
  ('CL', 'Clone',                         null,           'Clone',                   'ea', 11),
  ('UR', 'Unrooted Cutting',              null,           'Unrooted Cutting',        'ea', 12),
  ('IP', 'Immature Plant',                null,           'Immature Plant',          'ea', 13),
  ('MS', 'Mother Stock',                  null,           'Mother Stock',            'ea', 14),
  ('SD', 'Seed',                          null,           'Seed',                    'ea', 15)
on conflict (code) do nothing;

-- strain id from any name or alias (one lookup, not one per strain row)
create or replace function strain_id_of(p text) returns int
language sql stable security definer set search_path = public as $$
  select s.id from strains s
   where lower(s.name) = lower(trim(p)) or lower(trim(p)) = any(select lower(a) from unnest(s.aliases) a)
   order by (lower(s.name) = lower(trim(p))) desc, s.id limit 1
$$;

-- ---------- strains: number + default grade ----------
alter table strains add column if not exists strain_no int;
alter table strains add column if not exists default_grade text not null default 'SHO';
alter table strains drop constraint if exists strains_default_grade_check;
alter table strains add constraint strains_default_grade_check check (default_grade in ('SHO', 'BHO'));
create unique index if not exists strains_strain_no on strains (strain_no);

-- numbers for strains that don't have one yet (alphabetical the first time, then in the order they're added)
do $$
declare s record; n int := coalesce((select max(strain_no) from strains), 0);
begin
  for s in select id from strains where strain_no is null order by lower(name), id loop
    n := n + 1; update strains set strain_no = n where id = s.id;
  end loop;
end $$;
create or replace function strain_no_set() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.strain_no is null then new.strain_no := (select coalesce(max(strain_no), 0) + 1 from strains); end if;
  if tg_op = 'UPDATE' and old.strain_no is not null and new.strain_no is distinct from old.strain_no then
    raise exception 'A strain number never changes (it is in METRC harvest names)';
  end if;
  return new;
end $$;
drop trigger if exists strain_no_set on strains;
create trigger strain_no_set before insert or update of strain_no on strains for each row execute function strain_no_set();

-- strain defaults from "Lifted Strain BHO SHO" (Expected Fresh Frozen: SHO / BHO). Everything else stays SHO.
update strains set default_grade = 'BHO'
 where default_grade = 'SHO' and id in (
   select s.id from strains s, unnest(array[
     'Alien OG Auto', 'Blue Nerdz', 'Carbon Fiber', 'Froot by the Foot Auto', 'Froze Auto', 'Gas Face Auto', 'GMO Auto',
     'Godfather OG #9', 'Golden Goat', 'KH54', 'Kosher Kush', 'Kushberry', 'Lemon Tree x Trop Cherry #28',
     'Lemonhead Zkittlez x Pressure #1', 'Lemonhead Zkittlez x Pressure #5', 'Orange Elixir', 'Peanut Butter Breath',
     'Pink Certz', 'Pressure', 'Raspberry Parfait', 'Santa Cruz Blue Dream', 'SBC26 x Permanent Marker #31',
     'SBC26 x Permanent Marker #34', 'SBC 26 x PM #31', 'SBC 26 x PM #34', 'Strawberry Chelada', 'Super Lemon Haze',
     'Tahoe OG', 'White Mango', 'Ze Chem']) b(n)
    where s.id = strain_id_of(b.n));

-- ---------- sites: the farm letters used in SKUs and lot codes ----------
alter table sites add column if not exists farm_code text;
update sites set farm_code = 'OH' where code = 'OHR' and farm_code is null;
update sites set farm_code = 'GV' where code = 'GVR' and farm_code is null;
create unique index if not exists sites_farm_code on sites (farm_code);

-- ---------- items (SKUs) ----------
create table if not exists items (
  id            bigserial primary key,
  sku           text not null unique,
  crop_year     int not null,
  site          text not null references sites(code),
  cert          text not null default 'OCAL',
  finish        text not null references finishes(code),
  strain_id     int not null references strains(id),
  metrc_name    text not null,              -- word for word as in METRC / Roshi
  license       text,                       -- license the METRC item lives on
  roshi_category text,
  acct_class    text,                       -- e.g. 06_Oak Hill / 05_1363 GVR (Roshi "Brand")
  default_price numeric(10,2),
  uom           text not null default 'lb',
  metrc_status  text not null default 'to_create' check (metrc_status in ('to_create', 'in_metrc', 'retired')),
  active        boolean not null default true,
  created_by    text default current_email(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (crop_year, site, cert, finish, strain_id)
);

-- the strain as it's written in METRC (Roshi name if set, else the app's name)
create or replace function metrc_strain(p_strain int) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(trim(roshi_name), ''), name) from strains where id = p_strain
$$;

create or replace function item_sku(p_year int, p_site text, p_cert text, p_finish text, p_strain int) returns text
language sql stable security definer set search_path = public as $$
  select 'FL' || lpad((p_year % 100)::text, 2, '0') || '-' || (select farm_code from sites where code = p_site) || '-'
         || coalesce(p_cert, 'OCAL') || '-' || p_finish || '-' || regexp_replace(metrc_strain(p_strain), '\s+', '', 'g')
$$;

create or replace function item_metrc_name(p_year int, p_site text, p_cert text, p_finish text, p_strain int) returns text
language sql stable security definer set search_path = public as $$
  select 'Lifted Farms (FL' || lpad((p_year % 100)::text, 2, '0') || (select farm_code from sites where code = p_site) || ') - '
         || metrc_strain(p_strain) || ' - ' || coalesce(p_cert, 'OCAL') || ' '
         || (select coalesce(metrc_label, name) from finishes where code = p_finish)
$$;

-- find the item, making it if it isn't there yet
create or replace function item_for(p_year int, p_site text, p_finish text, p_strain int, p_cert text default 'OCAL') returns bigint
language plpgsql security definer set search_path = public as $$
declare i bigint;
begin
  if p_year is null or p_site is null or p_finish is null or p_strain is null then return null; end if;
  if not exists (select 1 from sites where code = p_site and farm_code is not null) then return null; end if;
  select id into i from items where crop_year = p_year and site = p_site and cert = p_cert and finish = p_finish and strain_id = p_strain;
  if i is null then
    insert into items (sku, crop_year, site, cert, finish, strain_id, metrc_name, license, roshi_category, acct_class, uom)
    values (item_sku(p_year, p_site, p_cert, p_finish, p_strain), p_year, p_site, p_cert, p_finish, p_strain,
            item_metrc_name(p_year, p_site, p_cert, p_finish, p_strain),
            (select license from sites where code = p_site),
            (select name from finishes where code = p_finish) || ' - ' || p_year,
            case p_site when 'OHR' then '06_Oak Hill' when 'GVR' then '05_1363 GVR' end,
            (select uom from finishes where code = p_finish))
    on conflict (crop_year, site, cert, finish, strain_id) do nothing
    returning id into i;
    if i is null then
      select id into i from items where crop_year = p_year and site = p_site and cert = p_cert and finish = p_finish and strain_id = p_strain;
    end if;
  end if;
  return i;
end $$;

-- ---------- harvest lots ----------
create table if not exists harvest_lots (
  id            bigserial primary key,
  code          text not null unique,       -- FL26-OH-047-01
  crop_year     int not null,
  site          text not null references sites(code),
  strain_id     int not null references strains(id),
  kind          text not null default 'ff', -- same kinds as cult_harvests
  seq           int not null,
  planted_on    date,
  first_harvest date,
  last_harvest  date,
  metrc_name    text,                       -- METRC harvest name. From 2027 = code. 2026 keeps the name already in METRC.
  grade         text check (grade in ('SHO', 'BHO')),   -- blank = strain default
  grade_reason  text,
  grade_by      text,
  grade_at      timestamptz,
  notes         text,
  created_at    timestamptz not null default now(),
  unique (crop_year, site, strain_id, seq)
);
alter table cult_harvests add column if not exists lot_id bigint references harvest_lots(id);
create index if not exists cult_harvests_lot on cult_harvests (lot_id);

create or replace function lot_code(p_year int, p_site text, p_strain int, p_seq int) returns text
language sql stable security definer set search_path = public as $$
  select 'FL' || lpad((p_year % 100)::text, 2, '0') || '-' || (select farm_code from sites where code = p_site) || '-'
         || lpad((select strain_no from strains where id = p_strain)::text, 3, '0') || '-' || lpad(p_seq::text, 2, '0')
$$;

-- the lot a harvest belongs to, making one if needed. Same year, farm, strain, kind and planting date, harvested within
-- 3 days of the lot's last harvest day = same lot. Otherwise (or p_new) the next lot number.
drop function if exists harvest_lot(bigint);
create or replace function harvest_lot(p_harvest bigint, p_new boolean default false) returns bigint
language plpgsql security definer set search_path = public as $$
declare h cult_harvests; sid int; planted date; hday date; l bigint; n int;
begin
  select * into h from cult_harvests where id = p_harvest;
  if h.id is null then return null; end if;
  if h.lot_id is not null and not p_new then return h.lot_id; end if;
  sid := strain_id_of(h.strain);
  if sid is null or h.site is null or h.crop_year is null then return null; end if;
  if not exists (select 1 from sites where code = h.site and farm_code is not null) then return null; end if;
  select planted_on into planted from cult_plantings where id = h.planting_id;
  hday := coalesce(h.harvested_on, h.planned_on, current_date);
  select id into l from harvest_lots
   where not p_new and crop_year = h.crop_year and site = h.site and strain_id = sid and kind = h.kind
     and planted_on is not distinct from planted
     and hday between coalesce(first_harvest, hday) - 3 and coalesce(last_harvest, hday) + 3
   order by seq desc limit 1;
  if l is null then
    perform pg_advisory_xact_lock(hashtext('harvest_lot:' || h.crop_year || h.site || sid));
    select coalesce(max(seq), 0) + 1 into n from harvest_lots where crop_year = h.crop_year and site = h.site and strain_id = sid;
    insert into harvest_lots (code, crop_year, site, strain_id, kind, seq, planted_on, first_harvest, last_harvest, metrc_name)
    values (lot_code(h.crop_year, h.site, sid, n), h.crop_year, h.site, sid, h.kind, n, planted, hday, hday,
            case when h.crop_year >= 2027 then lot_code(h.crop_year, h.site, sid, n) else nullif(trim(h.metrc_name), '') end)
    returning id into l;
  else
    update harvest_lots set first_harvest = least(first_harvest, hday), last_harvest = greatest(last_harvest, hday),
           metrc_name = coalesce(metrc_name, case when crop_year < 2027 then nullif(trim(h.metrc_name), '') end)
     where id = l;
  end if;
  update cult_harvests set lot_id = l where id = p_harvest;
  return l;
end $$;

-- Production Admin: put a harvest in another lot (or a new one with p_lot null)
create or replace function set_harvest_lot(p_harvest bigint, p_lot bigint) returns bigint
language plpgsql security definer set search_path = public as $$
declare old_lot bigint; l bigint;
begin
  perform no_view_as();
  if not (is_mod_admin('cultivation') or is_owner()) then raise exception 'Only a Production Admin can change harvest lots'; end if;
  select lot_id into old_lot from cult_harvests where id = p_harvest;
  if p_lot is not null and not exists (select 1 from harvest_lots hl join cult_harvests h on h.id = p_harvest
      where hl.id = p_lot and hl.crop_year = h.crop_year and hl.site = h.site and hl.strain_id = strain_id_of(h.strain)) then
    raise exception 'That lot is a different year, farm or strain';
  end if;
  if p_lot is not null then update cult_harvests set lot_id = p_lot where id = p_harvest; l := p_lot;
  else l := harvest_lot(p_harvest, true); end if;
  update pallets set lot_id = l where lot_id is not distinct from old_lot and (harvest_id = p_harvest or from_harvest = p_harvest);
  loop   -- split pieces follow their parent
    update pallets c set lot_id = l from pallets pp
     where c.parent_id = pp.id and pp.lot_id = l and c.lot_id is not distinct from old_lot;
    exit when not found;
  end loop;
  delete from harvest_lots o where o.id = old_lot and o.id <> l   -- the old lot is gone if nothing is left in it
     and not exists (select 1 from cult_harvests where lot_id = o.id) and not exists (select 1 from pallets where lot_id = o.id)
     and not exists (select 1 from lot_feedback where lot_id = o.id);
  insert into events (user_email, type, note, details) values (current_email(), 'harvest_lot', 'moved',
    jsonb_build_object('harvest', p_harvest, 'from', (select code from harvest_lots where id = old_lot), 'to', (select code from harvest_lots where id = l)));
  return l;
end $$;
revoke execute on function set_harvest_lot(bigint, bigint) from public, anon;
grant execute on function set_harvest_lot(bigint, bigint) to authenticated;

-- ---------- pallets: item, lot, grade ----------
alter table pallets add column if not exists item_id bigint references items(id);
alter table pallets add column if not exists lot_id bigint references harvest_lots(id);
alter table pallets add column if not exists grade text;
alter table pallets drop constraint if exists pallets_grade_check;
alter table pallets add constraint pallets_grade_check check (grade in ('SHO', 'BHO'));
create index if not exists pallets_item on pallets (item_id);
create index if not exists pallets_lot on pallets (lot_id);

create or replace function pallet_item_guess(p pallets) returns bigint
language sql stable security definer set search_path = public as $$
  select item_for(
    coalesce(p.crop_year, (select h.crop_year from cult_harvests h where h.id = coalesce(p.harvest_id, p.from_harvest)),
             extract(year from p.harvest_date)::int),
    p.origin_site,
    (select code from finishes where pallet_product = coalesce(p.product, 'fresh_frozen')),
    strain_id_of(p.strain))
$$;

create or replace function pallet_lot_guess(p pallets) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select harvest_lot(coalesce(p.harvest_id, p.from_harvest)) where coalesce(p.harvest_id, p.from_harvest) is not null),
    (select pp.lot_id from pallets pp where pp.id = p.parent_id))
$$;

-- fires after pallet_origin_set (triggers run in name order), so origin_site is already filled in
create or replace function pallet_set_item_lot() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind is distinct from 'mixed' then
    if new.lot_id is null then new.lot_id := pallet_lot_guess(new); end if;
    if tg_op = 'INSERT' or new.item_id is null
       or new.strain is distinct from old.strain or new.origin_site is distinct from old.origin_site
       or new.product is distinct from old.product or new.crop_year is distinct from old.crop_year then
      new.item_id := coalesce(pallet_item_guess(new), case when tg_op = 'UPDATE' then old.item_id end);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists pallet_set_item_lot on pallets;
create trigger pallet_set_item_lot before insert or update of strain, origin_site, product, crop_year, harvest_id, from_harvest, item_id, lot_id
  on pallets for each row execute function pallet_set_item_lot();

-- the grade that applies: pallet > lot > strain default
create or replace function pallet_grade(p pallets) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(p.grade, (select grade from harvest_lots where id = p.lot_id),
                  (select default_grade from strains where id = strain_id_of(p.strain)), 'SHO')
$$;
create or replace function pallet_grade_source(p pallets) returns text
language sql stable security definer set search_path = public as $$
  select case when p.grade is not null then 'pallet'
              when (select grade from harvest_lots where id = p.lot_id) is not null then 'lot' else 'strain' end
$$;

-- ---------- grade on reserves, orders, invoices ----------
alter table reserves add column if not exists grade text;
alter table reserves drop constraint if exists reserves_grade_check;
alter table reserves add constraint reserves_grade_check check (grade in ('SHO', 'BHO'));
alter table order_lines add column if not exists grade text;           -- blank = either
alter table order_lines drop constraint if exists order_lines_grade_check;
alter table order_lines add constraint order_lines_grade_check check (grade in ('SHO', 'BHO'));
alter table invoice_lines add column if not exists grade text;
alter table invoice_lines drop constraint if exists invoice_lines_grade_check;
alter table invoice_lines add constraint invoice_lines_grade_check check (grade in ('SHO', 'BHO'));
alter table invoice_lines add column if not exists item_id bigint references items(id);

-- ---------- changing grades ----------
create or replace function can_grade() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(is_mod_admin('cultivation') or is_mod_admin('sales') or is_owner(), false)
$$;

-- what a lot's grade change touches: on hand, held for orders (with the grade the order line asked for), already shipped
create or replace function lot_grade_impact(p_lot bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'on_hand', (select jsonb_build_object('pallets', count(*), 'lbs', coalesce(sum(current_weight), 0))
                  from pallets where lot_id = p_lot and grade is null and status in ('in_freezer', 'unslotted', 'in_transit', 'at_processor')),
    'held', coalesce((select jsonb_agg(jsonb_build_object('pallet', p.code, 'order', o.so_number, 'customer', c.name,
                        'line_grade', ol.grade, 'lbs', op.lbs) order by o.so_number)
                  from order_picks op join pallets p on p.id = op.pallet_id join orders o on o.id = op.order_id
                  join customers c on c.id = o.customer_id left join order_lines ol on ol.id = op.order_line_id
                 where p.lot_id = p_lot and p.grade is null and o.status not in ('shipped', 'cancelled')), '[]'),
    'shipped', coalesce((select jsonb_agg(x order by x->>'invoice') from (
                  select jsonb_build_object('invoice', i.inv_number, 'customer', c.name, 'date', i.invoice_date,
                         'lbs', sum(ip.lbs), 'grade', max(il.grade)) x
                    from invoice_packages ip join invoice_lines il on il.id = ip.invoice_line_id
                    join invoices i on i.id = il.invoice_id join customers c on c.id = i.customer_id
                    join pallets p on p.package_tag = ip.package_tag
                   where p.lot_id = p_lot and i.status is distinct from 'void'
                   group by i.inv_number, c.name, i.invoice_date) s), '[]'))
$$;

create or replace function set_lot_grade(p_lot bigint, p_grade text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l harvest_lots; g text := nullif(upper(trim(coalesce(p_grade, ''))), '');
begin
  perform no_view_as();
  if not can_grade() then raise exception 'Only a Production or Sales Admin can change a grade'; end if;
  if g is not null and g not in ('SHO', 'BHO') then raise exception 'Grade is SHO or BHO (blank = strain default)'; end if;
  select * into l from harvest_lots where id = p_lot;
  if l.id is null then raise exception 'Lot not found'; end if;
  update harvest_lots set grade = g, grade_reason = nullif(trim(p_reason), ''), grade_by = current_email(), grade_at = now() where id = p_lot;
  insert into events (user_email, type, note, details) values (current_email(), 'lot_grade', l.code,
    jsonb_build_object('lot', l.code, 'from', l.grade, 'to', g, 'reason', p_reason));
  return lot_grade_impact(p_lot);
end $$;
revoke execute on function set_lot_grade(bigint, text, text) from public, anon;
grant execute on function set_lot_grade(bigint, text, text) to authenticated;

create or replace function set_pallet_grade(p_pallet bigint, p_grade text, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare g text := nullif(upper(trim(coalesce(p_grade, ''))), ''); old text;
begin
  perform no_view_as();
  if not can_grade() then raise exception 'Only a Production or Sales Admin can change a grade'; end if;
  if g is not null and g not in ('SHO', 'BHO') then raise exception 'Grade is SHO or BHO (blank = follow the lot)'; end if;
  select grade into old from pallets where id = p_pallet;
  update pallets set grade = g where id = p_pallet;
  insert into events (user_email, type, pallet_id, details) values (current_email(), 'pallet_grade', p_pallet,
    jsonb_build_object('from', old, 'to', g, 'reason', p_reason));
end $$;
revoke execute on function set_pallet_grade(bigint, text, text) from public, anon;
grant execute on function set_pallet_grade(bigint, text, text) to authenticated;

create or replace function set_strain_grade(p_strain int, p_grade text) returns void
language plpgsql security definer set search_path = public as $$
declare g text := upper(trim(coalesce(p_grade, ''))); old text;
begin
  perform no_view_as();
  if not can_grade() then raise exception 'Only a Production or Sales Admin can change a grade'; end if;
  if g not in ('SHO', 'BHO') then raise exception 'Grade is SHO or BHO'; end if;
  select default_grade into old from strains where id = p_strain;
  update strains set default_grade = g where id = p_strain;
  insert into events (user_email, type, note, details) values (current_email(), 'strain_grade', (select name from strains where id = p_strain),
    jsonb_build_object('from', old, 'to', g));
end $$;
revoke execute on function set_strain_grade(int, text) from public, anon;
grant execute on function set_strain_grade(int, text) to authenticated;

-- grades follow pallets through splits (same as lot); a merge keeps a pallet-level grade only if every source agrees
create or replace function pallet_grade_copy() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.grade is null and new.parent_id is not null then
    new.grade := (select grade from pallets where id = new.parent_id);
  end if;
  return new;
end $$;
drop trigger if exists pallet_grade_copy on pallets;
create trigger pallet_grade_copy before insert on pallets for each row execute function pallet_grade_copy();

-- ---------- prices per strain per grade ----------
create table if not exists strain_prices (            -- default list
  crop_year    int not null,
  strain_id    int not null references strains(id),
  grade        text not null check (grade in ('SHO', 'BHO')),
  price_per_lb numeric(10,2) not null check (price_per_lb >= 0),
  updated_by   text default current_email(),
  updated_at   timestamptz not null default now(),
  primary key (crop_year, strain_id, grade)
);
create table if not exists customer_strain_prices (   -- a customer's own price, overrides the list
  customer_id  int not null references customers(id) on delete cascade,
  crop_year    int not null,
  strain_id    int not null references strains(id),
  grade        text not null check (grade in ('SHO', 'BHO')),
  price_per_lb numeric(10,2) not null check (price_per_lb >= 0),
  updated_by   text default current_email(),
  updated_at   timestamptz not null default now(),
  primary key (customer_id, crop_year, strain_id, grade)
);

-- customer price > default list > (SHO only) the customer's contract price for that crop year, as today
create or replace function price_for(p_customer int, p_year int, p_strain text, p_grade text) returns numeric
language sql stable security definer set search_path = public as $$
  with s as (select strain_id_of(p_strain) id)
  select coalesce(
    (select price_per_lb from customer_strain_prices c, s where c.customer_id = p_customer and c.crop_year = p_year and c.strain_id = s.id and c.grade = coalesce(p_grade, 'SHO')),
    (select price_per_lb from strain_prices l, s where l.crop_year = p_year and l.strain_id = s.id and l.grade = coalesce(p_grade, 'SHO')),
    case when coalesce(p_grade, 'SHO') = 'SHO' then
      coalesce((select price_per_lb from customer_terms where customer_id = p_customer and crop_year = p_year),
               (select price_per_lb from customers where id = p_customer)) end)
$$;

create or replace function save_strain_price(p_customer int, p_year int, p_strain int, p_grade text, p_price numeric) returns void
language plpgsql security definer set search_path = public as $$
declare g text := upper(trim(coalesce(p_grade, '')));
begin
  perform no_view_as();
  if not (is_sales_admin() or is_owner()) then raise exception 'Only a Sales Admin can change prices'; end if;
  if g not in ('SHO', 'BHO') then raise exception 'Grade is SHO or BHO'; end if;
  if p_customer is null then
    if p_price is null then delete from strain_prices where crop_year = p_year and strain_id = p_strain and grade = g;
    else insert into strain_prices (crop_year, strain_id, grade, price_per_lb) values (p_year, p_strain, g, p_price)
         on conflict (crop_year, strain_id, grade) do update set price_per_lb = excluded.price_per_lb, updated_by = current_email(), updated_at = now();
    end if;
  else
    if p_price is null then delete from customer_strain_prices where customer_id = p_customer and crop_year = p_year and strain_id = p_strain and grade = g;
    else insert into customer_strain_prices (customer_id, crop_year, strain_id, grade, price_per_lb) values (p_customer, p_year, p_strain, g, p_price)
         on conflict (customer_id, crop_year, strain_id, grade) do update set price_per_lb = excluded.price_per_lb, updated_by = current_email(), updated_at = now();
    end if;
  end if;
  insert into events (user_email, type, note, details) values (current_email(), 'strain_price', (select name from strains where id = p_strain),
    jsonb_build_object('customer', p_customer, 'year', p_year, 'grade', g, 'price', p_price));
end $$;
revoke execute on function save_strain_price(int, int, int, text, numeric) from public, anon;
grant execute on function save_strain_price(int, int, int, text, numeric) to authenticated;

-- ---------- customer wash feedback ----------
create table if not exists lot_feedback (
  id           bigserial primary key,
  lot_id       bigint not null references harvest_lots(id) on delete cascade,
  customer_id  int references customers(id),
  invoice_id   int references invoices(id),
  reported_on  date not null default current_date,
  result       text not null check (result in ('washed_well', 'washed_poorly', 'did_not_wash', 'other')),
  yield_pct    numeric(5,2),
  notes        text,
  created_by   text default current_email(),
  created_at   timestamptz not null default now()
);
create index if not exists lot_feedback_lot on lot_feedback (lot_id);

create or replace function add_lot_feedback(p_lot bigint, p_customer int, p_invoice int, p_result text, p_yield numeric, p_notes text) returns bigint
language plpgsql security definer set search_path = public as $$
declare i bigint;
begin
  perform no_view_as();
  if not (is_sales() or can_edit('cultivation') or is_owner()) then raise exception 'Sales or Production only'; end if;
  insert into lot_feedback (lot_id, customer_id, invoice_id, result, yield_pct, notes)
  values (p_lot, p_customer, p_invoice, p_result, p_yield, nullif(trim(p_notes), '')) returning id into i;
  insert into events (user_email, type, note, details) values (current_email(), 'lot_feedback', (select code from harvest_lots where id = p_lot),
    jsonb_build_object('customer', p_customer, 'invoice', p_invoice, 'result', p_result, 'yield', p_yield));
  return i;
end $$;
revoke execute on function add_lot_feedback(bigint, int, int, text, numeric, text) from public, anon;
grant execute on function add_lot_feedback(bigint, int, int, text, numeric, text) to authenticated;

-- ---------- access: staff read, changes only through the functions above ----------
alter table finishes enable row level security;
alter table items enable row level security;
alter table harvest_lots enable row level security;
alter table strain_prices enable row level security;
alter table customer_strain_prices enable row level security;
alter table lot_feedback enable row level security;
drop policy if exists read_staff on finishes;               create policy read_staff on finishes for select to authenticated using (is_staff());
drop policy if exists read_staff on items;                  create policy read_staff on items for select to authenticated using (is_staff());
drop policy if exists read_staff on harvest_lots;           create policy read_staff on harvest_lots for select to authenticated using (is_staff());
drop policy if exists read_staff on strain_prices;          create policy read_staff on strain_prices for select to authenticated using (is_sales() or is_owner());
drop policy if exists read_staff on customer_strain_prices; create policy read_staff on customer_strain_prices for select to authenticated using (is_sales() or is_owner());
drop policy if exists read_staff on lot_feedback;           create policy read_staff on lot_feedback for select to authenticated using (is_staff());
grant select on finishes, items, harvest_lots, strain_prices, customer_strain_prices, lot_feedback to authenticated;
revoke execute on function item_for(int, text, text, int, text) from public, anon, authenticated;
revoke execute on function harvest_lot(bigint, boolean) from public, anon, authenticated;

-- ---------- fill in what's already there ----------
-- lots for every harvest that has pallets (and every finished harvest), oldest first so lot numbers follow harvest order
do $$
declare h record;
begin
  for h in select id from cult_harvests
            where lot_id is null and (status = 'done' or exists (select 1 from pallets p where p.harvest_id = cult_harvests.id or p.from_harvest = cult_harvests.id))
            order by crop_year, coalesce(harvested_on, planned_on), id loop
    perform harvest_lot(h.id);
  end loop;
end $$;
-- pallets: lot from their harvest, then split pieces from their parents (a few passes for pieces of pieces)
update pallets p set lot_id = h.lot_id from cult_harvests h
 where p.lot_id is null and h.id = coalesce(p.harvest_id, p.from_harvest) and h.lot_id is not null;
do $$
declare n int := 1; k int := 0;
begin
  while n > 0 and k < 10 loop
    update pallets p set lot_id = pp.lot_id from pallets pp where p.lot_id is null and pp.id = p.parent_id and pp.lot_id is not null;
    get diagnostics n = row_count; k := k + 1;
  end loop;
end $$;
-- items for every pallet that can have one (mixed containers and two-farm packages don't)
update pallets p set item_id = pallet_item_guess(p) where p.item_id is null and p.kind is distinct from 'mixed';
-- items made from pallets that already exist in METRC (2026 and earlier) are marked as in METRC
update items set metrc_status = 'in_metrc' where metrc_status = 'to_create' and crop_year <= 2026;
