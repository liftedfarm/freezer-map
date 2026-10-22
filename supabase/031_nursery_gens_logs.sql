-- Migration 031: Nursery generations (G1 > G2 > G3 field moms > G4 production clones), mother lots, rooting data,
-- locations (Webb greenhouse benches, Webb hoops 1-18, Zion hoops 1-6 rented, rooting trailers 1-4),
-- the season Plan, and logs shared with Production (spray, feed, labor) plus nursery lab tests (HLVD).
-- Run after 028 (029/030 are tag imports and can go in any order). Safe to re-run.
set client_min_messages = warning;

-- ---------- locations (was "rooms") ----------
alter table nursery_rooms add column if not exists place text not null default 'Webb';     -- Webb, Zion
alter table nursery_rooms add column if not exists rented boolean not null default false;
alter table nursery_rooms add column if not exists beds jsonb not null default '[]';       -- [{"bed":"A","cap":126}, ...]
alter table nursery_rooms add column if not exists capacity int;                           -- plants (hoops: sum of beds)
alter table nursery_rooms add column if not exists trays int;                              -- trailers: trays they hold
alter table nursery_rooms drop constraint if exists nursery_rooms_kind_check;
update nursery_rooms set kind = 'bench' where kind = 'mother';
update nursery_rooms set kind = 'trailer' where kind = 'clone';
alter table nursery_rooms add constraint nursery_rooms_kind_check check (kind in ('bench','hoop','trailer','greenhouse','veg','other'));
alter table nursery_rooms drop constraint if exists nursery_rooms_site_name_key;
create unique index if not exists nursery_rooms_place_name_uq on nursery_rooms (site, place, name);

-- the old starter rooms become a greenhouse and a trailer; then the real layout
update nursery_rooms set name = 'Greenhouse', kind = 'greenhouse' where name = 'Mother room' and not exists (select 1 from nursery_rooms where name = 'Greenhouse');
update nursery_rooms set name = 'Trailer 1', kind = 'trailer', trays = 388 where name = 'Clone room' and not exists (select 1 from nursery_rooms where name = 'Trailer 1');
update nursery_rooms set sort = 99 where name = 'Greenhouse' and sort < 99;
update nursery_rooms set sort = 201 where name = 'Trailer 1' and sort < 100;
insert into nursery_rooms (site, place, name, kind, sort) select '1PN', 'Webb', 'GH B' || n, 'bench', 100 + n from generate_series(1, 8) n on conflict do nothing;
insert into nursery_rooms (site, place, name, kind, trays, sort) select '1PN', 'Webb', 'Trailer ' || n, 'trailer', 388, 200 + n from generate_series(1, 4) n on conflict do nothing;
insert into nursery_rooms (site, place, name, kind, beds, capacity, sort)
select '1PN', 'Webb', 'Hoop ' || h, 'hoop', jsonb_build_array(jsonb_build_object('bed','A','cap',a), jsonb_build_object('bed','B','cap',b), jsonb_build_object('bed','C','cap',c)), a + b + c, 300 + h
  from (values (1,126,178,132),(2,132,174,126),(3,105,136,101),(4,75,100,75),(5,150,200,150),(6,150,200,150),(7,152,202,150),(8,150,200,150),(9,150,200,150),
               (10,150,200,150),(11,150,200,150),(12,122,162,122),(13,150,200,150),(14,150,200,150),(15,150,200,150),(16,150,200,150),(17,150,200,150),(18,150,200,150)) v(h,a,b,c)
on conflict do nothing;
insert into nursery_rooms (site, place, name, kind, rented, beds, capacity, sort)
select '1PN', 'Zion', 'Zion Hoop ' || h, 'hoop', true, jsonb_build_array(jsonb_build_object('bed','A','cap',a), jsonb_build_object('bed','B','cap',b), jsonb_build_object('bed','C','cap',c)), a + b + c, 400 + h
  from (values (1,120,160,120),(2,120,160,120),(3,117,162,120),(4,120,160,120),(5,120,160,120),(6,160,160,162)) v(h,a,b,c)
on conflict do nothing;

-- ---------- mothers are lots: one METRC tag, a count, a generation ----------
alter table nursery_mothers add column if not exists qty int not null default 1 check (qty >= 0);
alter table nursery_mothers add column if not exists lost int not null default 0 check (lost >= 0);
alter table nursery_mothers add column if not exists gen smallint not null default 2 check (gen between 1 and 3);
alter table nursery_mothers add column if not exists season int;                  -- the crop year these moms feed (G1/G2/G3 for the 2027 crop = 2027)
alter table nursery_mothers add column if not exists bed text;                    -- A, B, C (hoops)
alter table nursery_mothers add column if not exists pot text;                    -- 4", 1G, 10L
alter table nursery_mothers add column if not exists cuts_per_plant numeric;      -- estimate for this lot
alter table nursery_mothers add column if not exists batch_id bigint references nursery_batches(id) on delete set null;   -- the batch they came from
update nursery_mothers set season = coalesce(season, extract(year from coalesce(started_on, created_at::date))::int + case when gen < 3 then 1 else 0 end);

-- ---------- batches: which generation, where cut from, rooting data ----------
alter table nursery_batches add column if not exists gen smallint not null default 4 check (gen between 1 and 4);
alter table nursery_batches add column if not exists season int;
alter table nursery_batches add column if not exists mother_id bigint references nursery_mothers(id) on delete set null;
alter table nursery_batches add column if not exists trays numeric;
alter table nursery_batches add column if not exists emerged_on date;          -- first roots seen
alter table nursery_batches add column if not exists sort1_on date;
alter table nursery_batches add column if not exists s1_vigorous int;
alter table nursery_batches add column if not exists s1_minimal int;
alter table nursery_batches add column if not exists s1_none int;
alter table nursery_batches add column if not exists s1_dead int;
alter table nursery_batches add column if not exists sort2_on date;
alter table nursery_batches add column if not exists s2_vigorous int;
alter table nursery_batches add column if not exists s2_minimal int;
alter table nursery_batches add column if not exists s2_none int;
alter table nursery_batches add column if not exists s2_dead int;
alter table nursery_batches add column if not exists moved_out_on date;
update nursery_batches set season = coalesce(season, extract(year from cut_on)::int);

-- ---------- per-strain planning numbers (blank = the defaults in Settings) ----------
create table if not exists nursery_strain_plan (
  strain       text primary key,
  cuts_g3      numeric,     -- cuttings per G3 field mom
  cuts_g2      numeric,     -- cuttings per G2 greenhouse mom
  cuts_g1      numeric,
  notes        text,
  updated_at   timestamptz not null default now()
);
alter table nursery_strain_plan enable row level security;
drop policy if exists n_read on nursery_strain_plan; drop policy if exists n_add on nursery_strain_plan; drop policy if exists n_edit on nursery_strain_plan; drop policy if exists n_delete on nursery_strain_plan;
create policy n_read on nursery_strain_plan for select to authenticated using (has_module('nursery') or is_admin());
create policy n_add on nursery_strain_plan for insert to authenticated with check (has_module('nursery') and not impersonating());
create policy n_edit on nursery_strain_plan for update to authenticated using (has_module('nursery')) with check (has_module('nursery') and not impersonating());
create policy n_delete on nursery_strain_plan for delete to authenticated using (has_module('nursery') and not impersonating());
grant select, insert, update, delete on nursery_strain_plan to authenticated;

-- ---------- lab tests (HLVD etc.) ----------
create table if not exists nursery_tests (
  id          bigserial primary key,
  site        text not null default '1PN' references nursery_sites(code) on update cascade,
  strain      text not null,
  mother_id   bigint references nursery_mothers(id) on delete set null,
  room_id     int references nursery_rooms(id) on delete set null,
  test        text not null default 'HLVD',
  round       int not null default 1,
  plants      int,               -- plants in the group
  tested      int,               -- how many sampled
  vial_from   text,
  vial_to     text,
  tested_on   date not null default current_date,
  result      text not null default 'pending' check (result in ('pending','negative','positive','inconclusive')),
  culled      int not null default 0,
  action      text,
  notes       text,
  created_by  text default current_email(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- logs shared by Nursery and Production: spray, feed, labor ----------
create table if not exists input_products (
  id           serial primary key,
  name         text not null unique,
  manufacturer text,
  full_name    text,
  rate         numeric,
  rate_unit    text,
  kind         text,         -- insecticide, fungicide, fertilizer…
  npk          text,
  notes        text,
  active       boolean not null default true
);
insert into input_products (name, manufacturer, full_name, rate, rate_unit, kind, npk) values
  ('Azaguard','BioSafe Systems','AzaGuard',3,'mL/Gal','Insect growth regulator',null),
  ('Biomin Booster','JH Biotech','Biomin Booster 123',5,'mL/Gal','Plant nutrient','1-0-0'),
  ('Biomin Calcium','JH Biotech','Biomin Calcium',5,'mL/Gal','Plant nutrient','1-0-0'),
  ('Biomin Iron','JH Biotech','Biomin Iron',null,null,'Plant nutrient',null),
  ('Biomin Manganese','JH Biotech','Biomin Manganese',null,null,'Plant nutrient',null),
  ('Clean Calcium','Agro-K','Clean Calcium',10,'mL/Gal','Foliar calcium',null),
  ('Explorer','Grower''s Secret Inc.',null,6.6,'g/Gal',null,null),
  ('GS 16-0-0','Grower''s Secret Inc.','Grower''s Secret Nitrogen',6.6,'g/Gal','Organic nitrogen','16-0-0'),
  ('Humic 600','Loveland Products, Inc.','Humic 600',null,null,'Humic acid','0-0-1'),
  ('Humic Acid (Ful-Power)','BioAg','Ful-Power',12,'mL/Gal','Fulvic acid',null),
  ('Kelp','Humboldt Organics',null,null,null,null,null),
  ('Kelp Help','Pacific Northwest Organic','Kelp Help',null,'oz/Gal','Plant nutrient',null),
  ('LFP','AgroThrive, Inc.','AgroThrive General Purpose',12,'mL/Gal','Organic fertilizer','2-7-0.3'),
  ('MAP',null,null,2.5,'g/Gal',null,null),
  ('Metasolate',null,'Metasolate',1,'g/Gal',null,null),
  ('PFR-97','Certis Biologicals','PFR-97 20% WDG',null,null,'Bioinsecticide',null),
  ('Pyganic','MGK','Pyganic Crop Protection EC',10,'mL/Gal','Botanical insecticide',null),
  ('Regalia','Marrone Bio Innovations','Regalia Biofungicide',10,'mL/Gal','Biofungicide',null),
  ('SOP','Diamond K Gypsum','Diamond K Ultra Fines SOP',4,'g/Gal','Potassium sulfate','0-0-50'),
  ('Sulfur','UPL','Microthiol Disperss',6,'g/Gal','Wettable sulfur',null),
  ('True Leaf Life','True Organic Products, Inc.','True Leaf Life',15.1,'mL/Gal','Organic fertilizer',null),
  ('Venerate','Marrone Bio Innovations','Venerate Bioinsecticide',null,'tbsp/Gal','Bioinsecticide',null),
  ('Verde','Humboldt Organics','Verde',1,'mL/Gal',null,null)
on conflict (name) do nothing;

create table if not exists ops_logs (
  id          bigserial primary key,
  module      text not null check (module in ('nursery','cultivation')),
  kind        text not null check (kind in ('spray','feed','labor')),
  site        text not null,            -- 1PN, OHR, GVR
  area        text,                     -- Webb, GH, Hoops 1-4, Block 2…
  log_on      date not null default current_date,
  start_at    time,
  end_at      time,
  sqft        numeric,
  spray_type  text,                     -- IPM, foliar, sulfur…
  water_gal   numeric,
  applicator  text,
  products    jsonb not null default '[]',   -- [{"product":"Pyganic","rate":10,"unit":"mL/Gal","total":250,"total_unit":"mL"}]
  task        text,                     -- labor: cut, clean, stick, transplant, sort, other
  strain      text,
  batch_id    bigint references nursery_batches(id) on delete set null,
  qty         numeric,                  -- labor: clones (or plants) done
  crew        int,                      -- people
  hours       numeric,                  -- hours each
  notes       text,
  created_by  text default current_email(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists ops_logs_idx on ops_logs (module, kind, log_on desc);

do $$
declare t text;
begin
  foreach t in array array['nursery_tests','ops_logs','input_products'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists n_read on %I', t);
    execute format('drop policy if exists n_add on %I', t);
    execute format('drop policy if exists n_edit on %I', t);
    execute format('drop policy if exists n_delete on %I', t);
  end loop;
end $$;
create policy n_read on nursery_tests for select to authenticated using (has_module('nursery') or is_admin());
create policy n_add on nursery_tests for insert to authenticated with check (has_module('nursery') and not impersonating());
create policy n_edit on nursery_tests for update to authenticated using (has_module('nursery')) with check (has_module('nursery') and not impersonating());
create policy n_delete on nursery_tests for delete to authenticated using (has_module('nursery') and not impersonating());
-- logs: each module sees and writes its own
create policy n_read on ops_logs for select to authenticated using (has_module(module) or is_admin());
create policy n_add on ops_logs for insert to authenticated with check (has_module(module) and not impersonating());
create policy n_edit on ops_logs for update to authenticated using (has_module(module)) with check (has_module(module) and not impersonating());
create policy n_delete on ops_logs for delete to authenticated using (has_module(module) and not impersonating());
-- products: anyone in Nursery or Production reads and adds; Admins of either edit
create policy n_read on input_products for select to authenticated using (has_module('nursery') or has_module('cultivation') or is_admin());
create policy n_add on input_products for insert to authenticated with check ((has_module('nursery') or has_module('cultivation')) and not impersonating());
create policy n_edit on input_products for update to authenticated using (is_mod_admin('nursery') or is_mod_admin('cultivation')) with check (not impersonating());
grant select, insert, update, delete on nursery_tests, ops_logs to authenticated;
grant select, insert, update on input_products to authenticated;
grant usage on sequence nursery_tests_id_seq, ops_logs_id_seq, input_products_id_seq to authenticated;

-- activity
create or replace function ops_log_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare r jsonb := to_jsonb(coalesce(new, old));
begin
  if tg_op = 'UPDATE' then new.updated_at := now(); r := to_jsonb(new); end if;
  insert into events (user_email, type, note, details)
  values (current_email(), case when r ->> 'module' = 'nursery' then 'nursery_log_' else 'cult_log_' end || (r ->> 'kind') || '_' || lower(tg_op),
          coalesce(r ->> 'area', r ->> 'strain'), jsonb_build_object('row', r));
  return coalesce(new, old);
end $$;
drop trigger if exists ops_logs_audit on ops_logs;
create trigger ops_logs_audit before insert or update or delete on ops_logs for each row execute function ops_log_audit();
drop trigger if exists nursery_tests_audit on nursery_tests;
create trigger nursery_tests_audit before insert or update or delete on nursery_tests for each row execute function nursery_audit();
drop trigger if exists nursery_tests_strain on nursery_tests;
create trigger nursery_tests_strain before insert or update of strain on nursery_tests for each row execute function cult_strain_name();

-- rooms/locations: Nursery Admins add and edit (policies from 028); allow delete of unused ones
drop policy if exists n_delete on nursery_rooms;
create policy n_delete on nursery_rooms for delete to authenticated using (is_mod_admin('nursery') and not impersonating());
grant delete on nursery_rooms to authenticated;

-- ---------- settings: the planning numbers ----------
create or replace function set_nursery_setting(p_key text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
declare was text;
begin
  perform no_view_as();
  if not is_mod_admin('nursery') then raise exception 'Only a Nursery Admin can change Nursery settings'; end if;
  if p_key not in ('nursery.clone_price','nursery.terms','nursery.root_days','nursery.ready_warn_days',
                   'nursery.buffer_pct','nursery.deliver_pct','nursery.tray','nursery.cuts_g3','nursery.cuts_g2','nursery.cuts_g1',
                   'nursery.g3_veg_days','nursery.g3_root_days','nursery.g2_lead_days','nursery.g1_lead_days','nursery.wage') then
    raise exception 'Unknown setting %', p_key;
  end if;
  if p_key <> 'nursery.terms' and p_value !~ '^\d+(\.\d+)?$' then raise exception 'Enter a number'; end if;
  select value into was from app_settings where key = p_key;
  insert into app_settings values (p_key, coalesce(p_value, '')) on conflict (key) do update set value = excluded.value;
  insert into events (user_email, type, note, details) values (current_email(), 'nursery_setting', p_key, jsonb_build_object('key', p_key, 'value', p_value, 'was', was));
end $$;
-- defaults from the 2026 workbook (only if not set yet)
insert into app_settings (key, value) values
  ('nursery.buffer_pct','15'), ('nursery.deliver_pct','3'), ('nursery.tray','72'), ('nursery.cuts_g3','18'), ('nursery.cuts_g2','15'), ('nursery.cuts_g1','15'),
  ('nursery.root_days','16'), ('nursery.g3_veg_days','40'), ('nursery.g3_root_days','40'), ('nursery.g2_lead_days','115'), ('nursery.g1_lead_days','116'), ('nursery.wage','24')
on conflict (key) do nothing;
-- root days was 14 before; the workbook runs ~16
update app_settings set value = '16' where key = 'nursery.root_days' and value = '14';

-- G3 batch planted out as field moms: make the mother lot, close the batch
create or replace function nursery_plant_moms(p_batch bigint, p_room int, p_bed text, p_qty int, p_tag text, p_on date default null) returns nursery_mothers
language plpgsql security definer set search_path = public as $$
declare b nursery_batches; m nursery_mothers;
begin
  perform no_view_as();
  if not has_module('nursery') then raise exception 'The Nursery module isn''t switched on for your account'; end if;
  select * into b from nursery_batches where id = p_batch for update;
  if b.id is null then raise exception 'Batch not found'; end if;
  if b.gen = 4 then raise exception 'G4 clones go to the farms, not into the hoops'; end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'How many plants?'; end if;
  if p_qty > b.cuttings - b.lost - coalesce((select sum(plants) from nursery_deliveries where batch_id = b.id), 0)
             - coalesce((select sum(qty + lost) from nursery_mothers where batch_id = b.id), 0) then
    raise exception 'That batch doesn''t have % plants left', p_qty;
  end if;
  insert into nursery_mothers (site, room_id, strain, plant_tag, started_on, qty, gen, season, bed, batch_id, pot)
  values (b.site, p_room, b.strain, nullif(upper(trim(p_tag)), ''), coalesce(p_on, current_date), p_qty, b.gen, coalesce(b.season, extract(year from current_date)::int),
          nullif(upper(trim(p_bed)), ''), b.id, null)
  returning * into m;
  -- the batch is done once every plant is planted, delivered or counted lost
  update nursery_batches x set stage = 'done', moved_out_on = coalesce(moved_out_on, coalesce(p_on, current_date))
   where x.id = b.id and x.cuttings - x.lost - coalesce((select sum(plants) from nursery_deliveries where batch_id = x.id), 0)
                         - coalesce((select sum(qty + lost) from nursery_mothers where batch_id = x.id), 0) <= 0;
  update nursery_batches set moved_out_on = coalesce(moved_out_on, coalesce(p_on, current_date)) where id = b.id;
  return m;
end $$;
revoke execute on function nursery_plant_moms(bigint, int, text, int, text, date), ops_log_audit() from public, anon;
grant execute on function nursery_plant_moms(bigint, int, text, int, text, date) to authenticated;

select 'ok' as nursery_gens_logs, (select count(*) from nursery_rooms) as locations, (select count(*) from input_products) as products;
