-- Migration 047: Processing module, step 1 (dry flower: wet packages, drying, bucking, trimming, trim requests).
-- Run once in Supabase after 046_accounting.sql: SQL Editor > New query > paste > Run. Safe to re-run.
--
--  * New module "Processing" (Off / View / User / Admin). Rama = Admin, Rafa = User (Owners Aziz and Matt have everything).
--  * Every pallet now has a product: fresh frozen (everything so far), wet (dry harvest raw weight, not deleafed),
--    unbucked, bucked, standards, smalls, trim. The open menu and fresh frozen numbers only count fresh frozen.
--  * Dry harvest > wet package (METRC tag) > sent to a drying processor (CCP, STACS, Strong Ag) or dried in our trailers
--    > comes back unbucked (not weighed, keeps its wet weight on paper) > Bucking run: bucked flower + buck trim + mold;
--    moisture = wet weight - everything that came out (record in METRC as waste / weight change) > Trimming run:
--    standards, smalls, trim + mold. Each output is its own METRC package (pallet) that lands as "Needs a spot".
--  * 4 x 53' reefer trailers at GVR (processor license CCL21-0000679), 26 pallet spots each, on the freezer map.
--  * Trim requests (strain, product, lbs, due date, for a customer or for stock). Trimmed packages are free stock until
--    committed to an order line (whole or part), then Fulfillment ships them like any pallet.
--  * Sales orders can have dry products (Standards / Smalls / Trim); price blank = filled in later.
set client_min_messages = warning;

-- ---------- the module ----------
alter table module_access drop constraint if exists module_access_module_check;
alter table module_access add constraint module_access_module_check check (module in ('distribution','sales','cultivation','nursery','processing','accounting','admin'));

do $$
declare f text; d text;
begin
  foreach f in array array['my_access(','my_modules(','save_user('] loop
    select pg_get_functiondef(p.oid) into d from pg_proc p where p.oid::regprocedure::text like f || '%' and p.pronamespace = 'public'::regnamespace;
    if d is not null and d not like '%''processing''%' then execute replace(d, '''nursery'',''accounting''', '''nursery'',''processing'',''accounting'''); end if;
  end loop;
  d := null;
  if to_regprocedure('set_module_level(text,text,text)') is not null then select pg_get_functiondef('set_module_level(text,text,text)'::regprocedure) into d; end if;
  if d is not null and d not like '%''processing''%' then execute replace(d, '''nursery'',''accounting'')', '''nursery'',''processing'',''accounting'')'); end if;
end $$;
create or replace function is_any_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(mod_level('distribution') = 'admin', false) or coalesce(mod_level('sales') = 'admin', false)
      or coalesce(mod_level('cultivation') = 'admin', false) or coalesce(mod_level('nursery') = 'admin', false)
      or coalesce(mod_level('processing') = 'admin', false)
      or coalesce(mod_level('accounting') = 'admin', false) or mod_level('admin') is not null
$$;

-- who gets it (as Aziz asked): Rama, Matt (Owner already), Rafa (Rafael Aguilar)
do $$
begin
  if not exists (select 1 from module_access where module = 'processing') then
    insert into module_access (email, module, level)
    select email, 'processing', case when email = 'ramananda@lifted-organics.com' then 'admin' else 'user' end
      from app_users where email in ('ramananda@lifted-organics.com', 'rafa@lifted-organics.com') and not coalesce(owner, false)
    on conflict (email, module) do nothing;
    perform sync_role(email) from app_users where email in ('ramananda@lifted-organics.com', 'rafa@lifted-organics.com');
  end if;
end $$;

-- ---------- processors (where dry flower gets dried) ----------
create table if not exists proc_processors (
  id        serial primary key,
  name      text not null unique,
  short     text,
  in_house  boolean not null default false,
  license   text,
  active    boolean not null default true,
  sort      int not null default 0,
  notes     text
);
insert into proc_processors (name, short, in_house, sort) values
  ('Central Coast Processing', 'CCP', false, 1), ('STACS', 'STACS', false, 2), ('Strong Ag', 'Strong Ag', false, 3),
  ('Lifted GVR trailers (in house)', 'GVR', true, 0)
on conflict (name) do nothing;

-- ---------- products on pallets ----------
alter table pallets add column if not exists product text not null default 'fresh_frozen';
alter table pallets drop constraint if exists pallets_product_check;
alter table pallets add constraint pallets_product_check check (product in ('fresh_frozen','wet','unbucked','bucked','standards','smalls','trim'));
alter table pallets add column if not exists crop_year int;
alter table pallets add column if not exists from_harvest bigint references cult_harvests(id) on delete set null;  -- dry lineage (harvest_id stays fresh frozen only)
alter table pallets add column if not exists processor_id int references proc_processors(id);
alter table pallets add column if not exists sent_on date;
alter table pallets add column if not exists run_id bigint;
create index if not exists pallets_product_idx on pallets (product);
create index if not exists pallets_from_harvest_idx on pallets (from_harvest);
alter table pallets drop constraint if exists pallets_status_check;
alter table pallets add constraint pallets_status_check check (status in ('in_freezer','unslotted','in_transit','at_processor','shipped','depleted','archived','merged'));

create or replace function product_label(p text) returns text language sql immutable as $$
  select case p when 'fresh_frozen' then 'Fresh Frozen' when 'wet' then 'Wet (raw)' when 'unbucked' then 'Unbucked' when 'bucked' then 'Bucked'
                when 'standards' then 'Standards' when 'smalls' then 'Smalls' when 'trim' then 'Trim' else initcap(coalesce(p, '')) end
$$;

-- splits keep the product and lineage (processing outputs set their own)
create or replace function pallet_child_product() returns trigger
language plpgsql security definer set search_path = public as $$
declare par pallets;
begin
  if new.parent_id is not null and new.run_id is null then
    select * into par from pallets where id = new.parent_id;
    if par.id is not null then
      new.product := par.product; new.crop_year := coalesce(new.crop_year, par.crop_year);
      new.from_harvest := coalesce(new.from_harvest, par.from_harvest); new.processor_id := coalesce(new.processor_id, par.processor_id);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists pallet_child_product on pallets;
create trigger pallet_child_product before insert on pallets for each row execute function pallet_child_product();

-- merges: only the same product, and the merged pallet keeps it
create or replace function pallet_merge_product() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if new.merged_into is not null and old.merged_into is distinct from new.merged_into then
    select count(distinct product) into n from pallets where merged_into = new.merged_into;
    if n > 1 then raise exception 'Only the same product can be merged (fresh frozen, bucked, standards...)'; end if;
    update pallets set product = new.product, crop_year = coalesce(crop_year, new.crop_year), from_harvest = coalesce(from_harvest, new.from_harvest)
     where id = new.merged_into and (product is distinct from new.product or crop_year is null);
  end if;
  return new;
end $$;
drop trigger if exists pallet_merge_product on pallets;
create trigger pallet_merge_product after update of merged_into on pallets for each row execute function pallet_merge_product();

-- the open menu and order numbers are fresh frozen only
create or replace function _menu_numbers()
 returns table(strain text, crop_year integer, on_menu boolean, on_hand numeric, pending numeric, reserved_left numeric, held numeric, free numeric)
 language sql stable security definer set search_path to 'public'
as $function$
  with cy as (select crop_year() as y),
  names as (
    select canonical_strain(p.strain) as s, coalesce(extract(year from p.harvest_date)::int, (select y from cy)) as yr,
           sum(coalesce(p.current_weight, 0)) as lbs
      from pallets p
     where p.kind = 'package' and p.product = 'fresh_frozen' and p.status in ('in_freezer','unslotted') and p.strain is not null
     group by 1, 2),
  pend as (
    select lower(l.strain) as k, l.crop_year as yr, sum(l.lbs) as lbs from orders o join order_lines l on l.order_id = o.id
     where o.status in ('pending','submitted') and l.product = 'fresh_frozen' group by 1, 2),
  res as (select lower(b.strain) as k, sum(b.remaining) as lbs from reserve_balances b where b.crop_year = (select y from cy) group by 1),
  held as (
    select lower(q.strain) as k, sum(greatest(q.requested_lbs - coalesce(r.lbs, 0), 0)) as lbs
      from reserve_requests q
      left join reserves r on r.customer_id = q.customer_id and lower(r.strain) = lower(q.strain) and r.product = 'fresh_frozen' and r.crop_year = q.crop_year
     where q.status = 'pending' and q.crop_year = (select y from cy) group by 1),
  allk as (
    select s as name, yr from names where s is not null
    union select r.strain, r.crop_year from reserves r where r.crop_year = (select y from cy)
    union select l.strain, l.crop_year from orders o join order_lines l on l.order_id = o.id where o.status in ('pending','submitted') and l.product = 'fresh_frozen'),
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
$function$;

-- ---------- the reefer trailers (GVR, processor license) ----------
alter table freezers drop constraint if exists freezers_kind_check;
alter table freezers add constraint freezers_kind_check check (kind in ('freezer','staging','trailer'));
insert into freezers (site, number, status, kind, notes)
select 'GVR', 100 + n, 'On', 'trailer', '53'' reefer trailer (dry flower)' from generate_series(1, 4) n
on conflict (site, number) do nothing;
insert into slots (freezer_id, code, col, row, front_rank)
select f.id, 'R' || (f.number - 100) || substr('ABCDEFGHIJKLMNOPQRSTUVWXYZ', (c - 1) * 13 + r, 1), c, r, 14 - r
  from freezers f, generate_series(1, 2) c, generate_series(1, 13) r
 where f.kind = 'trailer'
on conflict do nothing;

-- ---------- runs (bucking, trimming) ----------
create table if not exists proc_requests (
  id            bigserial primary key,
  strain        text not null,
  crop_year     int,
  product       text not null default 'standards' check (product in ('standards','smalls','trim','any')),
  lbs           numeric not null check (lbs > 0),
  due_on        date,
  customer_id   int references customers(id),
  order_line_id int references order_lines(id) on delete set null,
  note          text,
  status        text not null default 'open' check (status in ('open','done','cancelled')),
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  done_at       timestamptz
);
create table if not exists proc_runs (
  id          bigserial primary key,
  code        text not null unique,
  kind        text not null check (kind in ('buck','trim')),
  site        text not null default 'GVR' check (site in ('OHR','GVR')),
  strain      text,
  crop_year   int,
  request_id  bigint references proc_requests(id) on delete set null,
  status      text not null default 'open' check (status in ('open','done','cancelled')),
  started_on  date not null default current_date,
  finished_on date,
  input_lbs   numeric,
  output_lbs  numeric,
  mold_lbs    numeric,
  loss_lbs    numeric,          -- buck: moisture (wet on paper - everything out); trim: what's left over
  notes       text,
  created_by  text,
  created_at  timestamptz not null default now(),
  finished_by text,
  updated_at  timestamptz not null default now()
);
create table if not exists proc_run_inputs (
  id        bigserial primary key,
  run_id    bigint not null references proc_runs(id) on delete cascade,
  pallet_id bigint not null references pallets(id),
  lbs       numeric not null check (lbs > 0),
  whole     boolean not null default true,
  unique (run_id, pallet_id)
);
create index if not exists proc_run_inputs_pallet_idx on proc_run_inputs (pallet_id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'pallets_run_id_fkey') then
    alter table pallets add constraint pallets_run_id_fkey foreign key (run_id) references proc_runs(id) on delete set null;
  end if;
end $$;
create sequence if not exists proc_pallet_seq;

alter table proc_processors enable row level security;
alter table proc_requests enable row level security;
alter table proc_runs enable row level security;
alter table proc_run_inputs enable row level security;
drop policy if exists read_proc on proc_processors; drop policy if exists read_proc on proc_requests;
drop policy if exists read_proc on proc_runs; drop policy if exists read_proc on proc_run_inputs;
create policy read_proc on proc_processors for select to authenticated using (is_staff());
create policy read_proc on proc_requests for select to authenticated using (is_staff());
create policy read_proc on proc_runs for select to authenticated using (is_staff());
create policy read_proc on proc_run_inputs for select to authenticated using (is_staff());
grant select on proc_processors, proc_requests, proc_runs, proc_run_inputs to authenticated;

-- ---------- helpers ----------
create or replace function proc_require() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_module('processing');
  perform require_staff();
end $$;

-- pallet number for a processing package: D + last digits of the METRC tag (…10053 → D53), else DN + a number
create or replace function proc_code(p_tag text) returns text
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if p_tag ~ '[0-9]{4}$' and right(p_tag, 4)::int > 0 then
    c := 'D' || right(p_tag, 4)::int;
    if not exists (select 1 from pallets where code = c) then return c; end if;
    c := 'D' || right(p_tag, 6)::int;
    if not exists (select 1 from pallets where code = c) then return c; end if;
  end if;
  loop
    c := 'DN' || nextval('proc_pallet_seq');
    exit when not exists (select 1 from pallets where code = c);
  end loop;
  return c;
end $$;

create or replace function _proc_tag(p_tag text) returns text
language plpgsql security definer set search_path = public as $$
declare t text := upper(nullif(trim(coalesce(p_tag, '')), '')); used text;
begin
  if t is null then return null; end if;
  used := tag_in_use(t, null);
  if used is not null then raise exception 'Tag % is already on pallet %', t, used; end if;
  return t;
end $$;

create or replace function _proc_event(p_type text, p_pallet bigint, p_lbs numeric, p_details jsonb, p_note text default null) returns void
language sql security definer set search_path = public as $$
  insert into events (user_email, type, pallet_id, lbs, note, details) values (current_email(), p_type, p_pallet, p_lbs, p_note, p_details)
$$;

-- a pallet that can be worked on (in a freezer/trailer or waiting for a spot; not on a mixed pallet, a load, an order or another run)
create or replace function _proc_free(p pallets, verb text) returns void
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if p.status not in ('in_freezer','unslotted') then raise exception '% is %, it can''t be %', p.code, replace(p.status, '_', ' '), verb; end if;
  if p.container_id is not null then raise exception '% is on a mixed pallet. Take it off first.', p.code; end if;
  if p.kind = 'mixed' then raise exception '% is a mixed pallet', p.code; end if;
  c := pallet_open_load(p.id);
  if c is not null then raise exception '% is planned on load %', p.code, c; end if;
  select coalesce(o.so_number, 'an order') into c from order_picks x join orders o on o.id = x.order_id where x.pallet_id = p.id limit 1;
  if c is not null then raise exception '% is held for %', p.code, c; end if;
  select r.code into c from proc_run_inputs i join proc_runs r on r.id = i.run_id where i.pallet_id = p.id and r.status = 'open' limit 1;
  if c is not null then raise exception '% is already in run %', p.code, c; end if;
end $$;

-- ---------- 1. wet packages from a dry harvest ----------
-- p_rows: [{"lbs": 1200, "tag": "1A40..."}]. p_processor: where it's going (blank or in house = stays with us, needs a spot)
create or replace function proc_make_wet(p_harvest bigint, p_rows jsonb, p_processor int default null, p_sent date default null) returns text[]
language plpgsql security definer set search_path = public as $$
declare h cult_harvests; f fields; pr proc_processors; r jsonb; v_lbs numeric; v_tag text; v_code text; p pallets; out text[] := '{}'; away boolean;
begin
  perform proc_require();
  select * into h from cult_harvests where id = p_harvest;
  if h.id is null then raise exception 'Harvest not found'; end if;
  if h.kind <> 'dry' then raise exception 'Wet packages are for dry flower harvests'; end if;
  select * into f from fields where id = h.field_id;
  if p_processor is not null then select * into pr from proc_processors where id = p_processor; end if;
  away := pr.id is not null and not pr.in_house;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]')) loop
    v_lbs := nullif(r ->> 'lbs', '')::numeric;
    if v_lbs is null or v_lbs <= 0 then raise exception 'Every package needs its raw (wet) weight'; end if;
    v_tag := _proc_tag(r ->> 'tag');
    v_code := proc_code(v_tag);
    insert into pallets (code, strain, zone, harvest_date, og_weight, current_weight, package_tag, tag_pending, status, received_site,
                         product, crop_year, from_harvest, processor_id, sent_on, origin_site, notes)
    values (v_code, h.strain, coalesce(f.name, ''), coalesce(h.harvested_on, current_date), v_lbs, v_lbs, v_tag, v_tag is null,
            case when away then 'at_processor' else 'unslotted' end, case when away then null else h.site end,
            'wet', h.crop_year, h.id, pr.id, case when away then coalesce(p_sent, current_date) end, h.site, nullif(trim(r ->> 'note'), ''))
    returning * into p;
    perform _proc_event('proc_wet', p.id, v_lbs, jsonb_build_object('strain', h.strain, 'site', h.site, 'field', f.name, 'harvest_id', h.id, 'tag', v_tag,
                                                                  'processor', pr.name, 'sent', away));
    out := out || v_code;
  end loop;
  if cardinality(out) = 0 then raise exception 'Add at least one package'; end if;
  return out;
end $$;

-- ---------- 2. send out to a processor / get it back / dried in house ----------
create or replace function proc_send(p_ids bigint[], p_processor int, p_on date default null) returns int
language plpgsql security definer set search_path = public as $$
declare p pallets; pr proc_processors; n int := 0;
begin
  perform proc_require();
  select * into pr from proc_processors where id = p_processor;
  if pr.id is null then raise exception 'Pick where it''s going'; end if;
  if pr.in_house then raise exception '% is ours. Use "Dried in house" instead.', pr.name; end if;
  for p in select * from pallets where id = any(p_ids) for update loop
    if p.product not in ('wet','unbucked') then raise exception '% is %; only wet or unbucked product goes to a processor', p.code, product_label(p.product); end if;
    perform _proc_free(p, 'sent');
    update pallets set status = 'at_processor', slot_id = null, received_site = null, processor_id = pr.id, sent_on = coalesce(p_on, current_date), updated_at = now()
     where id = p.id;
    perform _proc_event('proc_sent', p.id, p.current_weight, jsonb_build_object('processor', pr.name, 'from_slot', p.slot_id, 'product', p.product));
    n := n + 1;
  end loop;
  return n;
end $$;

-- back from the processor: unbucked (not weighed, keeps the wet weight). p_tags: {"<pallet id>": "new tag"} when it came back on a new tag
create or replace function proc_receive(p_ids bigint[], p_site text default 'GVR', p_tags jsonb default '{}') returns int
language plpgsql security definer set search_path = public as $$
declare p pallets; n int := 0; t text;
begin
  perform proc_require();
  if p_site not in ('OHR','GVR') then raise exception 'Pick OHR or GVR'; end if;
  for p in select * from pallets where id = any(p_ids) for update loop
    if p.status <> 'at_processor' then raise exception '% isn''t out at a processor', p.code; end if;
    t := _proc_tag(coalesce(p_tags, '{}') ->> p.id::text);
    update pallets set status = 'unslotted', received_site = p_site, product = case when product = 'wet' then 'unbucked' else product end,
           package_tag = coalesce(t, package_tag), tag_pending = case when t is not null then false else tag_pending end, updated_at = now()
     where id = p.id;
    perform _proc_event('proc_received', p.id, p.current_weight, jsonb_build_object('processor', (select name from proc_processors where id = p.processor_id),
                                                                                  'site', p_site, 'new_tag', t, 'old_tag', p.package_tag));
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function proc_mark_dried(p_ids bigint[]) returns int
language plpgsql security definer set search_path = public as $$
declare p pallets; n int := 0; home int;
begin
  perform proc_require();
  select id into home from proc_processors where in_house order by sort, id limit 1;
  for p in select * from pallets where id = any(p_ids) for update loop
    if p.product <> 'wet' then raise exception '% isn''t wet', p.code; end if;
    if p.status not in ('in_freezer','unslotted') then raise exception '% is %', p.code, replace(p.status, '_', ' '); end if;
    update pallets set product = 'unbucked', processor_id = coalesce(home, processor_id), updated_at = now() where id = p.id;
    perform _proc_event('proc_dried', p.id, p.current_weight, jsonb_build_object('in_house', true));
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- 3. runs ----------
-- p_inputs: [{"pallet": 123, "lbs": 300}] (lbs blank = the whole package). Bucking takes whole unbucked packages; trimming takes bucked (whole or part)
create or replace function _proc_set_inputs(r proc_runs, p_inputs jsonb) returns proc_runs
language plpgsql security definer set search_path = public as $$
declare x jsonb; p pallets; v numeric; strains int; tot numeric := 0; yr int; st text;
begin
  delete from proc_run_inputs where run_id = r.id;
  for x in select * from jsonb_array_elements(coalesce(p_inputs, '[]')) loop
    select * into p from pallets where id = (x ->> 'pallet')::bigint for update;
    if p.id is null then raise exception 'Package not found'; end if;
    perform _proc_free(p, 'used');
    if r.kind = 'buck' and p.product <> 'unbucked' then raise exception '% is %. Bucking takes unbucked packages.', p.code, product_label(p.product); end if;
    if r.kind = 'trim' and p.product <> 'bucked' then raise exception '% is %. Trimming takes bucked packages.', p.code, product_label(p.product); end if;
    if p.current_weight is null or p.current_weight <= 0 then raise exception '% has no weight', p.code; end if;
    v := coalesce(nullif(x ->> 'lbs', '')::numeric, p.current_weight);
    if r.kind = 'buck' then v := p.current_weight; end if;   -- unbucked isn't weighed: the whole package goes in
    if v <= 0 or v > p.current_weight then raise exception '% has % lbs', p.code, p.current_weight; end if;
    insert into proc_run_inputs (run_id, pallet_id, lbs, whole) values (r.id, p.id, v, v >= p.current_weight);
    tot := tot + v;
  end loop;
  if tot = 0 then raise exception 'Pick the packages going in'; end if;
  select count(distinct lower(coalesce(canonical_strain(pp.strain), pp.strain))), max(coalesce(pp.crop_year, extract(year from pp.harvest_date)::int)), min(pp.strain)
    into strains, yr, st from proc_run_inputs i join pallets pp on pp.id = i.pallet_id where i.run_id = r.id;
  if strains > 1 then raise exception 'One strain per run'; end if;
  update proc_runs set input_lbs = tot, strain = coalesce(canonical_strain(st), st), crop_year = yr, updated_at = now() where id = r.id returning * into r;
  return r;
end $$;

create or replace function proc_start_run(p_kind text, p_inputs jsonb, p_request bigint default null, p_notes text default null,
                                          p_site text default 'GVR', p_on date default null) returns proc_runs
language plpgsql security definer set search_path = public as $$
declare r proc_runs; d date := coalesce(p_on, current_date); n int; c text;
begin
  perform proc_require();
  if p_kind not in ('buck','trim') then raise exception 'Bucking or trimming?'; end if;
  if p_request is not null and p_kind <> 'trim' then raise exception 'Trim requests go with trimming runs'; end if;
  select count(*) + 1 into n from proc_runs where kind = p_kind and started_on = d;
  loop
    c := case p_kind when 'buck' then 'B' else 'T' end || '-' || to_char(d, 'YYMMDD') || '-' || n;
    exit when not exists (select 1 from proc_runs where code = c);
    n := n + 1;
  end loop;
  insert into proc_runs (code, kind, site, request_id, started_on, notes, created_by)
  values (c, p_kind, coalesce(p_site, 'GVR'), p_request, d, nullif(trim(p_notes), ''), current_email()) returning * into r;
  r := _proc_set_inputs(r, p_inputs);
  if p_request is not null and exists (select 1 from proc_requests q where q.id = p_request and lower(coalesce(canonical_strain(q.strain), q.strain)) <> lower(r.strain)) then
    raise exception 'That request is for a different strain';
  end if;
  insert into events (user_email, type, lbs, details)
  values (current_email(), 'proc_run_started', r.input_lbs, jsonb_build_object('run', r.code, 'run_id', r.id, 'kind', r.kind, 'strain', r.strain,
          'packages', (select jsonb_agg(p.code) from proc_run_inputs i join pallets p on p.id = i.pallet_id where i.run_id = r.id)));
  return r;
end $$;

create or replace function proc_edit_run(p_run bigint, p_inputs jsonb, p_request bigint default null, p_notes text default null) returns proc_runs
language plpgsql security definer set search_path = public as $$
declare r proc_runs;
begin
  perform proc_require();
  select * into r from proc_runs where id = p_run for update;
  if r.status <> 'open' then raise exception 'Run % is %', r.code, r.status; end if;
  update proc_runs set request_id = case when r.kind = 'trim' then p_request end, notes = nullif(trim(p_notes), ''), updated_at = now() where id = r.id returning * into r;
  return _proc_set_inputs(r, p_inputs);
end $$;

create or replace function proc_cancel_run(p_run bigint) returns void
language plpgsql security definer set search_path = public as $$
declare r proc_runs;
begin
  perform proc_require();
  select * into r from proc_runs where id = p_run for update;
  if r.status <> 'open' then raise exception 'Run % is already %', r.code, r.status; end if;
  update proc_runs set status = 'cancelled', updated_at = now() where id = r.id;
  insert into events (user_email, type, lbs, details) values (current_email(), 'proc_run_cancelled', r.input_lbs, jsonb_build_object('run', r.code, 'run_id', r.id));
end $$;

-- finish: what came out. p_outputs: [{"product": "bucked", "lbs": 410, "tag": "1A4..."}] (no tag = tag pending). p_mold = mold / refuse lbs (METRC waste)
create or replace function proc_finish_run(p_run bigint, p_outputs jsonb, p_mold numeric default 0, p_notes text default null, p_on date default null) returns text[]
language plpgsql security definer set search_path = public as $$
declare r proc_runs; x jsonb; v numeric; t text; prod text; p pallets; i record; out text[] := '{}'; tot numeric := 0;
        one_in bigint; fh bigint; hd date; zone_ text; org text; proc_ int; q proc_requests; made numeric;
begin
  perform proc_require();
  select * into r from proc_runs where id = p_run for update;
  if r.id is null then raise exception 'Run not found'; end if;
  if r.status <> 'open' then raise exception 'Run % is already %', r.code, r.status; end if;
  if coalesce(p_mold, 0) < 0 then raise exception 'Mold can''t be negative'; end if;
  -- the inputs are still there and untouched
  for i in select ri.*, pl.code, pl.status, pl.current_weight from proc_run_inputs ri join pallets pl on pl.id = ri.pallet_id where ri.run_id = r.id loop
    if i.status not in ('in_freezer','unslotted') then raise exception '% is % now. Edit the run.', i.code, replace(i.status, '_', ' '); end if;
    if i.lbs > coalesce(i.current_weight, 0) then raise exception '% only has % lbs now. Edit the run.', i.code, i.current_weight; end if;
  end loop;
  select case when count(*) = 1 then min(pallet_id) end into one_in from proc_run_inputs where run_id = r.id;
  select case when count(distinct pp.from_harvest) = 1 then min(pp.from_harvest) end, min(pp.harvest_date),
         case when count(distinct pp.zone) = 1 then min(pp.zone) else 'Mixed' end,
         case when count(distinct pp.origin_site) = 1 then min(pp.origin_site) else string_agg(distinct pp.origin_site, '+') end,
         case when count(distinct pp.processor_id) = 1 then min(pp.processor_id) end
    into fh, hd, zone_, org, proc_
    from proc_run_inputs ri join pallets pp on pp.id = ri.pallet_id where ri.run_id = r.id;
  for x in select * from jsonb_array_elements(coalesce(p_outputs, '[]')) loop
    v := nullif(x ->> 'lbs', '')::numeric;
    if v is null or v = 0 then continue; end if;
    if v < 0 then raise exception 'Weights can''t be negative'; end if;
    prod := x ->> 'product';
    if r.kind = 'buck' and prod not in ('bucked','trim') then raise exception 'Bucking makes bucked flower and trim'; end if;
    if r.kind = 'trim' and prod not in ('standards','smalls','trim') then raise exception 'Trimming makes standards, smalls and trim'; end if;
    t := _proc_tag(x ->> 'tag');
    insert into pallets (code, strain, zone, harvest_date, og_weight, current_weight, package_tag, tag_pending, status, received_site,
                         product, crop_year, from_harvest, processor_id, origin_site, parent_id, run_id, notes)
    values (proc_code(t), r.strain, zone_, hd, v, v, t, t is null, 'unslotted', r.site,
            prod, r.crop_year, fh, proc_, org, one_in, r.id, nullif(trim(x ->> 'note'), ''))
    returning * into p;
    perform _proc_event('proc_output', p.id, v, jsonb_build_object('run', r.code, 'run_id', r.id, 'product', prod, 'strain', r.strain, 'tag', t));
    out := out || p.code; tot := tot + v;
  end loop;
  if cardinality(out) = 0 then raise exception 'Enter what came out'; end if;
  -- use up the inputs
  for i in select * from proc_run_inputs where run_id = r.id loop
    update pallets set current_weight = greatest(current_weight - i.lbs, 0),
           status = case when current_weight - i.lbs <= 0.001 then 'depleted' else status end,
           slot_id = case when current_weight - i.lbs <= 0.001 then null else slot_id end,
           received_site = case when current_weight - i.lbs <= 0.001 then null else received_site end, updated_at = now()
     where id = i.pallet_id;
    perform _proc_event('proc_used', i.pallet_id, i.lbs, jsonb_build_object('run', r.code, 'run_id', r.id, 'whole', i.whole));
  end loop;
  update proc_runs set status = 'done', finished_on = coalesce(p_on, current_date), finished_by = current_email(), output_lbs = tot,
         mold_lbs = coalesce(p_mold, 0), loss_lbs = input_lbs - tot - coalesce(p_mold, 0),
         notes = coalesce(nullif(trim(p_notes), ''), notes), updated_at = now()
   where id = r.id returning * into r;
  insert into events (user_email, type, lbs, details)
  values (current_email(), 'proc_run_done', r.output_lbs, jsonb_build_object('run', r.code, 'run_id', r.id, 'kind', r.kind, 'strain', r.strain,
          'in', r.input_lbs, 'out', r.output_lbs, 'mold', r.mold_lbs, 'loss', r.loss_lbs, 'packages', to_jsonb(out)));
  -- a trim request is done once enough came out
  if r.request_id is not null then
    select * into q from proc_requests where id = r.request_id;
    select coalesce(sum(pp.og_weight), 0) into made from proc_runs x join pallets pp on pp.run_id = x.id
     where x.request_id = q.id and x.status = 'done' and (q.product = 'any' or pp.product = q.product);
    if q.status = 'open' and made >= q.lbs then update proc_requests set status = 'done', done_at = now(), updated_at = now() where id = q.id; end if;
  end if;
  return out;
end $$;

-- ---------- 4. trim requests ----------
-- p: {"id": null, "strain": "Gurple", "crop_year": 2025, "product": "standards", "lbs": 200, "due_on": "2026-11-05", "customer_id": 12, "order_line_id": null, "note": ""}
create or replace function proc_save_request(p jsonb) returns proc_requests
language plpgsql security definer set search_path = public as $$
declare q proc_requests; s text := coalesce(canonical_strain(p ->> 'strain'), nullif(trim(p ->> 'strain'), '')); ol order_lines; o orders;
begin
  if not (can_edit('processing') or can_edit('sales')) then raise exception 'Only Processing or Sales can make trim requests'; end if;
  perform no_view_as();
  if s is null then raise exception 'Pick a strain'; end if;
  if coalesce(nullif(p ->> 'lbs', '')::numeric, 0) <= 0 then raise exception 'How many lbs?'; end if;
  if nullif(p ->> 'order_line_id', '') is not null then
    select * into ol from order_lines where id = (p ->> 'order_line_id')::int;
    select * into o from orders where id = ol.order_id;
  end if;
  if nullif(p ->> 'id', '') is null then
    insert into proc_requests (strain, crop_year, product, lbs, due_on, customer_id, order_line_id, note, created_by)
    values (s, nullif(p ->> 'crop_year', '')::int, coalesce(nullif(p ->> 'product', ''), 'standards'), (p ->> 'lbs')::numeric,
            coalesce(nullif(p ->> 'due_on', '')::date, o.wanted_date), coalesce(nullif(p ->> 'customer_id', '')::int, o.customer_id), ol.id,
            nullif(trim(p ->> 'note'), ''), current_email())
    returning * into q;
  else
    update proc_requests set strain = s, crop_year = nullif(p ->> 'crop_year', '')::int, product = coalesce(nullif(p ->> 'product', ''), 'standards'),
           lbs = (p ->> 'lbs')::numeric, due_on = nullif(p ->> 'due_on', '')::date, customer_id = coalesce(nullif(p ->> 'customer_id', '')::int, o.customer_id),
           order_line_id = ol.id, note = nullif(trim(p ->> 'note'), ''), updated_at = now()
     where id = (p ->> 'id')::bigint returning * into q;
    if q.id is null then raise exception 'Request not found'; end if;
  end if;
  insert into events (user_email, type, lbs, details)
  values (current_email(), 'proc_request', q.lbs, jsonb_build_object('request_id', q.id, 'strain', q.strain, 'product', q.product, 'due', q.due_on,
          'customer', (select name from customers where id = q.customer_id), 'new', nullif(p ->> 'id', '') is null));
  return q;
end $$;

create or replace function proc_request_status(p_id bigint, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (can_edit('processing') or can_edit('sales')) then raise exception 'Only Processing or Sales can change trim requests'; end if;
  perform no_view_as();
  if p_status not in ('open','done','cancelled') then raise exception 'Unknown status'; end if;
  update proc_requests set status = p_status, done_at = case when p_status = 'done' then now() end, updated_at = now() where id = p_id;
  insert into events (user_email, type, details) values (current_email(), 'proc_request_status', jsonb_build_object('request_id', p_id, 'status', p_status));
end $$;

-- ---------- 5. commit packages to an order (whole or part) ----------
create or replace function proc_commit(p_line int, p_pallet bigint, p_lbs numeric default null, p_tag text default null) returns order_picks
language plpgsql security definer set search_path = public as $$
declare ln order_lines; o orders; p pallets; pk order_picks; other text; child pallets;
begin
  perform no_view_as();
  if not (can_edit('processing') or can_edit('distribution')) then raise exception 'Only Processing or Distribution can commit product to orders'; end if;
  select * into ln from order_lines where id = p_line;
  if ln.id is null then raise exception 'Order line not found'; end if;
  select * into o from orders where id = ln.order_id for update;
  if o.status <> 'pending' then raise exception 'Only confirmed, open orders can get product'; end if;
  if o.stop_id is not null then raise exception 'This order is on a load. Take it off the load first.'; end if;
  select * into p from pallets where id = p_pallet for update;
  if p.id is null then raise exception 'Package not found'; end if;
  if p.product <> ln.product then raise exception '% is %, this line is %', p.code, product_label(p.product), product_label(ln.product); end if;
  if lower(coalesce(canonical_strain(p.strain), p.strain, '')) <> lower(coalesce(canonical_strain(ln.strain), ln.strain)) then
    raise exception '% is %, this line is %', p.code, coalesce(p.strain, 'no strain'), ln.strain;
  end if;
  perform _proc_free(p, 'committed');
  if p_lbs is not null and p_lbs < coalesce(p.current_weight, 0) then
    -- split off what the order needs (new METRC package, or tag pending); it stays where the package is
    if p.status = 'in_freezer' then
      child := split_pallet(p.id, p_lbs, p_tag, nullif(trim(coalesce(p_tag, '')), '') is null, null, 'for an order', true);
    else
      perform _proc_tag(p_tag);
      insert into pallets (code, strain, zone, harvest_date, og_weight, current_weight, package_tag, tag_pending, parent_id, status, received_site, origin_site)
      values (p.code || '-' || (select count(*) + 1 from pallets where parent_id = p.id), p.strain, p.zone, p.harvest_date, p_lbs, p_lbs,
              upper(nullif(trim(coalesce(p_tag, '')), '')), nullif(trim(coalesce(p_tag, '')), '') is null, p.id, 'unslotted', p.received_site, p.origin_site)
      returning * into child;
      update pallets set current_weight = current_weight - p_lbs, updated_at = now() where id = p.id;
      perform _proc_event('split', p.id, p_lbs, jsonb_build_object('child', child.code, 'child_id', child.id, 'remaining', p.current_weight - p_lbs), 'for an order');
    end if;
    p := child;
  end if;
  insert into order_picks (order_id, order_line_id, pallet_id, lbs, created_by)
  values (o.id, ln.id, p.id, coalesce(p.current_weight, 0), current_email()) returning * into pk;
  perform pick_event('fulfill_assigned', o.id, p.id, pk.lbs, jsonb_build_object('strain', ln.strain, 'product', ln.product, 'from', 'processing'));
  return pk;
end $$;

-- Fulfillment: a line only takes its own product
do $$
declare d text;
begin
  select pg_get_functiondef('pick_pallet(integer,bigint)'::regprocedure) into d;
  if d not like '%product_label%' then
    execute replace(d, '  select coalesce(o2.so_number, c.name) into other',
      '  if p.product <> ln.product then raise exception ''% is %, this line is %'', p.code, product_label(p.product), product_label(ln.product); end if;' || chr(10) ||
      '  select coalesce(o2.so_number, c.name) into other');
  end if;
end $$;

-- Fulfillment sees each line's product
do $$
declare d text;
begin
  select pg_get_functiondef('fulfillment_orders(integer)'::regprocedure) into d;
  if d not like '%''product'', ol.product%' then
    execute replace(d, '''strain'', ol.strain, ''lbs'', ol.lbs,', '''strain'', ol.strain, ''product'', ol.product, ''lbs'', ol.lbs,');
  end if;
end $$;

-- ---------- 6. Sales: orders and invoices with dry products ----------
create or replace function create_order(p_customer integer, p_lines jsonb, p_po text default null, p_wanted date default null, p_notes text default null,
                                        p_terms text default null, p_confirm boolean default true) returns orders
language plpgsql security definer set search_path = public as $$
declare o orders; l jsonb; s text; yr int; pr numeric; n int := 0; prod text;
begin
  perform no_view_as();
  if not can_edit('sales') then raise exception 'Only Sales can create orders'; end if;
  if not exists (select 1 from customers where id = p_customer) then raise exception 'Pick a customer'; end if;
  insert into orders (customer_id, status, order_date, source, notes, po_number, wanted_date, created_by, payment_terms, confirmed_by, confirmed_at)
  values (p_customer, case when p_confirm then 'pending' else 'draft' end, current_date, 'app', nullif(trim(p_notes), ''), nullif(trim(p_po), ''), p_wanted,
          current_email(), nullif(p_terms, ''), case when p_confirm then current_email() end, case when p_confirm then now() end)
  returning * into o;
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]')) loop
    s := coalesce(canonical_strain(l ->> 'strain'), nullif(trim(l ->> 'strain'), ''));
    if s is null or coalesce((l ->> 'lbs')::numeric, 0) <= 0 then continue; end if;
    prod := coalesce(nullif(l ->> 'product', ''), 'fresh_frozen');
    if prod not in ('fresh_frozen','standards','smalls','trim','bucked','unbucked') then raise exception 'Unknown product %', prod; end if;
    yr := coalesce((l ->> 'crop_year')::int, crop_year());
    pr := nullif(l ->> 'price', '')::numeric;
    if pr is null and prod = 'fresh_frozen' then select t.price_per_lb into pr from terms_for(p_customer, yr) t; end if;
    insert into order_lines (order_id, strain, product, lbs, price_per_lb, price_override, crop_year)
    values (o.id, s, prod, (l ->> 'lbs')::numeric, pr, nullif(l ->> 'price', '') is not null, yr);
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'Add at least one line with lbs'; end if;
  insert into events (user_email, type, details)
  values (current_email(), 'order_created', jsonb_build_object('order_id', o.id, 'so', o.so_number, 'customer', (select name from customers where id = o.customer_id), 'lines', n));
  select * into o from orders where id = o.id;
  return o;
end $$;

-- batch names: FL26-GV-OCAL-FF-Strain for fresh frozen, ...-DF-... for dry flower products
create or replace function batch_name(p_year int, p_site text, p_strain text, p_product text) returns text
language sql immutable as $$
  select 'FL' || right(coalesce(p_year, 0)::text, 2) || '-' || case upper(coalesce(p_site, '')) when 'GVR' then 'GV' else 'OH' end
         || '-OCAL-' || case when coalesce(p_product, 'fresh_frozen') = 'fresh_frozen' then 'FF' else 'DF' end || '-' || regexp_replace(coalesce(p_strain, ''), '[^A-Za-z0-9#]', '', 'g')
$$;
do $$
declare d text;
begin
  select pg_get_functiondef('_make_invoice(integer)'::regprocedure) into d;
  if d not like '%product_label(ln.product)%' then
    d := replace(d, '''Fresh Frozen - '' || ln.crop_year, ln.strain || '' - Fresh Frozen''',
                    'product_label(ln.product) || '' - '' || ln.crop_year, ln.strain || '' - '' || product_label(ln.product)');
    d := replace(d, 'coalesce(ln.price_per_lb, (select t.price_per_lb from terms_for(o.customer_id, ln.crop_year) t), 0)',
                    'coalesce(ln.price_per_lb, case when ln.product = ''fresh_frozen'' then (select t.price_per_lb from terms_for(o.customer_id, ln.crop_year) t) end, 0)');
    d := replace(d, 'p.received_site, case when p.code like ''G%'' then ''GVR'' else ''OHR'' end), ln.strain)',
                    'p.received_site, case when p.code like ''G%'' then ''GVR'' else ''OHR'' end), ln.strain, ln.product)');
    execute d;
  end if;
end $$;

-- ---------- 7. yields per strain and crop year ----------
create or replace function proc_yields(p_year int default null)
 returns table(strain text, crop_year int, wet_lbs numeric, bucked_in numeric, bucked numeric, buck_trim numeric, buck_mold numeric, moisture numeric,
               trim_in numeric, standards numeric, smalls numeric, trim_lbs numeric, trim_mold numeric, trim_loss numeric, buck_runs int, trim_runs int)
language sql stable security definer set search_path = public as $$
  with wet as (
    select coalesce(canonical_strain(p.strain), p.strain) s, coalesce(p.crop_year, extract(year from p.harvest_date)::int) y, sum(p.og_weight) lbs
      from pallets p where p.product in ('wet','unbucked') and p.parent_id is null and p.run_id is null and p.merged_into is null and p.status <> 'archived'
     group by 1, 2),
  outs as (
    select r.strain s, r.crop_year y, r.kind, p.product, sum(p.og_weight) lbs
      from proc_runs r join pallets p on p.run_id = r.id where r.status = 'done' group by 1, 2, 3, 4),
  runs as (
    select r.strain s, r.crop_year y, r.kind, sum(r.input_lbs) inp, sum(r.mold_lbs) mold, sum(r.loss_lbs) loss, count(*) n
      from proc_runs r where r.status = 'done' group by 1, 2, 3),
  k as (select s, y from wet union select s, y from runs)
  select k.s, k.y, coalesce(w.lbs, 0),
         coalesce(b.inp, 0), coalesce((select lbs from outs o where o.s = k.s and o.y = k.y and o.kind = 'buck' and o.product = 'bucked'), 0),
         coalesce((select lbs from outs o where o.s = k.s and o.y = k.y and o.kind = 'buck' and o.product = 'trim'), 0),
         coalesce(b.mold, 0), coalesce(b.loss, 0),
         coalesce(t.inp, 0),
         coalesce((select lbs from outs o where o.s = k.s and o.y = k.y and o.kind = 'trim' and o.product = 'standards'), 0),
         coalesce((select lbs from outs o where o.s = k.s and o.y = k.y and o.kind = 'trim' and o.product = 'smalls'), 0),
         coalesce((select lbs from outs o where o.s = k.s and o.y = k.y and o.kind = 'trim' and o.product = 'trim'), 0),
         coalesce(t.mold, 0), coalesce(t.loss, 0), coalesce(b.n, 0)::int, coalesce(t.n, 0)::int
    from k
    left join wet w on w.s = k.s and w.y is not distinct from k.y
    left join runs b on b.s = k.s and b.y is not distinct from k.y and b.kind = 'buck'
    left join runs t on t.s = k.s and t.y is not distinct from k.y and t.kind = 'trim'
   where p_year is null or k.y = p_year
   order by k.y desc nulls last, k.s
$$;

-- ---------- 9. everything the Processing screens need (Processing users may not have Production or Sales) ----------
create or replace function proc_data() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_module('processing') or has_module('sales') or has_module('distribution')) then raise exception 'The Processing module isn''t switched on for your account'; end if;
  return jsonb_build_object(
    'harvests', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'crop_year', h.crop_year, 'site', h.site, 'field', f.name, 'strain', h.strain, 'status', h.status,
          'planned_on', h.planned_on, 'harvested_on', h.harvested_on, 'raw_lbs', coalesce(h.raw_lbs, (select sum(b) from unnest(h.raw_bins) b)),
          'plants', coalesce(h.plants_harvested, h.plants)) order by coalesce(h.harvested_on, h.planned_on) desc)
        from cult_harvests h left join fields f on f.id = h.field_id
       where h.kind = 'dry' and h.status <> 'cancelled' and h.crop_year >= extract(year from current_date)::int - 1), '[]'),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'order_id', o.id, 'so', o.so_number, 'customer_id', o.customer_id, 'customer', c.name,
          'strain', l.strain, 'product', l.product, 'lbs', l.lbs, 'crop_year', l.crop_year, 'wanted', o.wanted_date, 'on_load', o.stop_id is not null,
          'picked', (select coalesce(sum(x.lbs), 0) from order_picks x where x.order_line_id = l.id)) order by o.wanted_date nulls last, o.id)
        from order_lines l join orders o on o.id = l.order_id join customers c on c.id = o.customer_id
       where o.status = 'pending' and l.product <> 'fresh_frozen' and l.lbs > 0), '[]'),
    'customers', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.name) from customers c where c.active), '[]'),
    'held', coalesce((select jsonb_agg(jsonb_build_object('pallet_id', x.pallet_id, 'so', o.so_number, 'customer', c.name))
        from order_picks x join orders o on o.id = x.order_id join customers c on c.id = o.customer_id
        join pallets p on p.id = x.pallet_id where p.product <> 'fresh_frozen' and o.status = 'pending'), '[]'));
end $$;

-- ---------- 8. processors (Processing Admins) ----------
create or replace function proc_save_processor(p jsonb) returns proc_processors
language plpgsql security definer set search_path = public as $$
declare x proc_processors;
begin
  perform no_view_as();
  if not (is_mod_admin('processing') or is_owner()) then raise exception 'Only a Processing Admin can change processors'; end if;
  if nullif(trim(p ->> 'name'), '') is null then raise exception 'Name?'; end if;
  if nullif(p ->> 'id', '') is null then
    insert into proc_processors (name, short, in_house, license, active, sort, notes)
    values (trim(p ->> 'name'), nullif(trim(p ->> 'short'), ''), coalesce((p ->> 'in_house')::boolean, false), nullif(trim(p ->> 'license'), ''),
            coalesce((p ->> 'active')::boolean, true), coalesce(nullif(p ->> 'sort', '')::int, 9), nullif(trim(p ->> 'notes'), ''))
    returning * into x;
  else
    update proc_processors set name = trim(p ->> 'name'), short = nullif(trim(p ->> 'short'), ''), in_house = coalesce((p ->> 'in_house')::boolean, false),
           license = nullif(trim(p ->> 'license'), ''), active = coalesce((p ->> 'active')::boolean, true), notes = nullif(trim(p ->> 'notes'), '')
     where id = (p ->> 'id')::int returning * into x;
  end if;
  insert into events (user_email, type, note) values (current_email(), 'proc_settings', 'processor ' || x.name);
  return x;
end $$;

do $$
declare f text;
begin
  foreach f in array array['proc_make_wet(bigint,jsonb,integer,date)','proc_send(bigint[],integer,date)','proc_receive(bigint[],text,jsonb)',
    'proc_mark_dried(bigint[])','proc_start_run(text,jsonb,bigint,text,text,date)','proc_edit_run(bigint,jsonb,bigint,text)','proc_cancel_run(bigint)',
    'proc_finish_run(bigint,jsonb,numeric,text,date)','proc_save_request(jsonb)','proc_request_status(bigint,text)','proc_commit(integer,bigint,numeric,text)',
    'proc_yields(integer)','proc_save_processor(jsonb)','proc_data()'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

select 'processing' as module, count(*) as people from module_access where module = 'processing'
union all select 'trailers', count(*) from freezers where kind = 'trailer'
union all select 'trailer spots', count(*) from slots s join freezers f on f.id = s.freezer_id where f.kind = 'trailer';
