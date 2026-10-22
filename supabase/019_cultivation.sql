-- Migration 019: Cultivation module (plantings, harvest schedule, testing, harvest actuals, planning).
-- Run once in Supabase after 018_modules_sites_fields.sql: SQL Editor > New query > paste > Run. Safe to re-run.
-- Only users with the 'cultivation' module (Settings > Users) can see or change any of this.
--
--  plantings      what went in the ground: strain x field x date, plants, spacing, nursery
--  harvests       the harvest log: one row per planned harvest (fresh frozen, dry, combine, strip header),
--                 with the estimates that drive labor, dry ice, trucks and testing, then the actuals
--                 (date, plants, raw bin weights, pallets). Pallets made here land in the freezer app
--                 as "Needs a spot".
--  tests          lab tests: one per field (area composite) and one per dry flower harvest
--  flower_picks   dry flower lbs wanted per strain
--  demand / plan / nursery_orders / receipts   next season: lbs needed, plants to order, deliveries, receiving
--  yield_history  older seasons' yields (from the Data Tapes) for planning
--  cult_log       every change, who and when
set client_min_messages = warning;

alter table sites add column if not exists pallet_prefix text;
update sites set pallet_prefix = case code when 'OHR' then 'P' when 'GVR' then 'G' end where pallet_prefix is null;

-- ---------- tables ----------
create table if not exists cult_plantings (
  id            bigserial primary key,
  crop_year     int not null default crop_year(),
  site          text not null references sites(code),
  field_id      int references fields(id),
  strain        text not null,
  batch         int,
  source        text not null default 'clone' check (source in ('clone','seed','auto')),
  nursery       text,
  planted_on    date,
  plants        int,             -- plants in the field (after loss and replanting)
  plant_loss    int,
  spacing_in    numeric,
  beds          numeric,
  acres         numeric,         -- blank = worked out from plants x spacing
  license       text,
  first_flower  date,
  est_lbs_per_plant numeric,     -- fresh frozen projection after planting
  seed_lbs      numeric,
  notes         text,
  created_by    text default current_email(),
  created_at    timestamptz not null default now(),
  updated_by    text,
  updated_at    timestamptz not null default now()
);
create index if not exists cult_plantings_year_idx on cult_plantings (crop_year, site);

create table if not exists cult_harvests (
  id            bigserial primary key,
  crop_year     int not null default crop_year(),
  site          text not null references sites(code),
  field_id      int references fields(id),
  strain        text not null,
  planting_id   bigint references cult_plantings(id) on delete set null,
  kind          text not null default 'ff' check (kind in ('ff','dry','combine','strip')),
  status        text not null default 'planned' check (status in ('planned','done','cancelled')),
  planned_on    date,            -- harvest date (combine: the cut date)
  plants        int,
  est_lbs_per_plant numeric,     -- fresh frozen lbs per plant
  est_raw_per_plant numeric,     -- dry harvest: raw lbs per plant
  deleaf_rate   numeric,         -- plants per man-hour (blank = site default)
  buck_rate     numeric,         -- lbs per man-hour (blank = site default)
  dry_conversion numeric,        -- blank = site default
  acres         numeric,         -- biomass
  est_yield_per_acre numeric,    -- biomass, dry lbs per acre
  days_to_merge int,             -- combine: cut -> merge
  days_to_harvest int,           -- combine: cut -> harvest
  -- actuals
  harvested_on  date,
  plants_harvested int,
  raw_bins      numeric[] not null default '{}',   -- raw weights as they come off the field
  raw_lbs       numeric,                           -- blank = sum of bins
  ff_lbs        numeric,                           -- packaged fresh frozen lbs (blank = sum of its pallets)
  bucked_lbs    numeric,
  trim_lbs      numeric,
  mold_lbs      numeric,
  metrc_name    text,
  notes         text,
  created_by    text default current_email(),
  created_at    timestamptz not null default now(),
  updated_by    text,
  updated_at    timestamptz not null default now()
);
create index if not exists cult_harvests_year_idx on cult_harvests (crop_year, site, planned_on);

alter table pallets add column if not exists harvest_id bigint references cult_harvests(id) on delete set null;
create index if not exists pallets_harvest_idx on pallets (harvest_id);

create table if not exists cult_test_protocols (
  kind        text primary key check (kind in ('ff','biomass','dry')),
  label       text not null,
  per         text not null,          -- Area / Strain
  sample      text not null,          -- Composite / Individual
  opens_days  int not null default 14,
  closes_days int not null default 7,
  tests       text not null default ''
);
insert into cult_test_protocols values
  ('ff', 'Fresh Frozen', 'Area', 'Composite', 14, 7, 'CA Category 3 Pesticides  •  ICAL Pesticide Panel'),
  ('biomass', 'Biomass', 'Area', 'Composite', 14, 7, 'Full Cannabinoid Panel  •  Moisture  •  CA Category 3 Pesticides  •  ICAL Pesticide Panel'),
  ('dry', 'Dry Flower', 'Strain', 'Individual', 14, 7, 'Full Cannabinoid Panel  •  Moisture  •  Heavy Metals  •  CA Category 3 Pesticides + ICAL Panel  •  Microbials (Inhalable)')
on conflict (kind) do nothing;
insert into app_settings values ('cult.sample_weekday', '4'), ('cult.labs', 'Infinite Chemical Analysis|Bel-Costa|Encore'),
  ('cult.equipment', 'Swather|Merger|Combine|Stripper Header'), ('cult.ready_days', '2')
on conflict do nothing;

create table if not exists cult_tests (
  id           bigserial primary key,
  crop_year    int not null default crop_year(),
  site         text not null references sites(code),
  kind         text not null check (kind in ('area','strain')),
  field_id     int references fields(id),
  harvest_id   bigint references cult_harvests(id) on delete cascade,
  lab          text,
  test_ref     text,
  sampled_on   date,
  submitted_on date,
  results_on   date,
  result       text,           -- Pass / Fail / text
  notes        text,
  created_by   text default current_email(),
  created_at   timestamptz not null default now(),
  updated_by   text,
  updated_at   timestamptz not null default now(),
  check ((kind = 'area' and field_id is not null) or (kind = 'strain' and harvest_id is not null))
);
create unique index if not exists cult_tests_area_uq on cult_tests (crop_year, field_id) where kind = 'area';
create unique index if not exists cult_tests_strain_uq on cult_tests (harvest_id) where kind = 'strain';

create table if not exists cult_flower_picks (
  id        bigserial primary key,
  crop_year int not null default crop_year(),
  strain    text not null,
  dry_lbs   numeric not null check (dry_lbs >= 0),
  notes     text,
  updated_by text, updated_at timestamptz not null default now()
);
create unique index if not exists cult_flower_picks_uq on cult_flower_picks (crop_year, lower(strain));

-- next season
create table if not exists cult_demand (
  id        bigserial primary key,
  crop_year int not null,
  strain    text not null,
  lbs       numeric not null check (lbs >= 0),     -- fresh frozen lbs to grow for
  notes     text,
  updated_by text, updated_at timestamptz not null default now()
);
create unique index if not exists cult_demand_uq on cult_demand (crop_year, lower(strain));

create table if not exists cult_plan (
  id          bigserial primary key,
  crop_year   int not null,
  site        text not null references sites(code),
  field_id    int references fields(id),
  strain      text not null,
  nursery     text,
  source      text not null default 'clone' check (source in ('clone','seed','auto')),
  plants      int not null check (plants >= 0),
  overage_pct numeric not null default 3,
  spacing_in  numeric,
  est_lbs_per_plant numeric,     -- blank = history average
  trial       boolean not null default false,
  notes       text,
  created_by  text default current_email(),
  updated_by  text, updated_at timestamptz not null default now()
);
create index if not exists cult_plan_year_idx on cult_plan (crop_year);

create table if not exists cult_nursery_orders (
  id          bigserial primary key,
  crop_year   int not null,
  plan_id     bigint references cult_plan(id) on delete set null,
  site        text not null references sites(code),
  strain      text not null,
  nursery     text,
  plants      int not null check (plants >= 0),
  cut_on      date,
  deliver_on  date,
  plant_on    date,
  status      text not null default 'planned' check (status in ('planned','ordered','confirmed','received','cancelled')),
  notes       text,
  created_by  text default current_email(),
  updated_by  text, updated_at timestamptz not null default now()
);
create index if not exists cult_nursery_orders_year_idx on cult_nursery_orders (crop_year);

create table if not exists cult_receipts (
  id          bigserial primary key,
  crop_year   int not null default crop_year(),
  site        text not null references sites(code),
  strain      text not null,
  batch       int not null default 1,
  nursery     text,
  source      text not null default 'clone' check (source in ('clone','seed','auto')),
  order_id    bigint references cult_nursery_orders(id) on delete set null,
  received_on date,
  received    int not null default 0,
  rejected    int not null default 0,
  notes       text,
  created_by  text default current_email(),
  updated_by  text, updated_at timestamptz not null default now()
);

create table if not exists cult_yield_history (
  id           bigserial primary key,
  crop_year    int not null,
  site         text not null,
  strain       text not null,
  field        text,
  plants       int,
  ff_lbs       numeric,
  planted_on   date,
  harvested_on date,
  source       text not null default 'import'
);
create index if not exists cult_yield_history_strain_idx on cult_yield_history (lower(strain));

create table if not exists cult_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  user_email text,
  tbl        text not null,
  row_id     bigint,
  op         text not null,
  data       jsonb,
  was        jsonb
);
create index if not exists cult_log_row_idx on cult_log (tbl, row_id, at desc);
create index if not exists cult_log_at_idx on cult_log (at desc);

-- ---------- who changed what ----------
create or replace function cult_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare d jsonb; w jsonb;
begin
  -- bulk imports (set local cult.import = 'on') aren't logged row by row
  if current_setting('cult.import', true) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    insert into cult_log (user_email, tbl, row_id, op, was) values (current_email(), tg_table_name, old.id, 'delete', to_jsonb(old));
    return old;
  end if;
  if tg_op = 'UPDATE' then
    new.updated_by := current_email(); new.updated_at := now();
    d := to_jsonb(new) - 'updated_at' - 'updated_by'; w := to_jsonb(old) - 'updated_at' - 'updated_by';
    if d = w then return new; end if;
    -- only what changed
    select jsonb_object_agg(k, d -> k), jsonb_object_agg(k, w -> k) into d, w
      from jsonb_object_keys(d) k where d -> k is distinct from w -> k;
  else
    if to_jsonb(new) ? 'updated_by' then new.updated_by := current_email(); end if;
    d := to_jsonb(new); w := null;
  end if;
  insert into cult_log (user_email, tbl, row_id, op, data, was) values (current_email(), tg_table_name, new.id, lower(tg_op), d, w);
  return new;
end $$;

-- strain names go through the Strains list (so "Wilson Zero #1" and "#1 Wilson Zero" are the same strain)
create or replace function cult_strain_name() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.strain := coalesce(canonical_strain(new.strain), trim(new.strain));
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['cult_plantings','cult_harvests','cult_tests','cult_flower_picks','cult_demand','cult_plan',
                           'cult_nursery_orders','cult_receipts','cult_yield_history'] loop
    execute format('drop trigger if exists %I on %I', t || '_audit', t);
    if t <> 'cult_yield_history' then
      execute format('create trigger %I before insert or update or delete on %I for each row execute function cult_audit()', t || '_audit', t);
    end if;
    if t not in ('cult_tests') then
      execute format('drop trigger if exists %I on %I', t || '_strain', t);
      execute format('create trigger %I before insert or update of strain on %I for each row execute function cult_strain_name()', t || '_strain', t);
    end if;
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists cult_read on %I', t);
    execute format('drop policy if exists cult_add on %I', t);
    execute format('drop policy if exists cult_edit on %I', t);
    execute format('drop policy if exists cult_delete on %I', t);
    execute format('create policy cult_read on %I for select to authenticated using (has_module(''cultivation''))', t);
    execute format('create policy cult_add on %I for insert to authenticated with check (has_module(''cultivation'') and not impersonating())', t);
    execute format('create policy cult_edit on %I for update to authenticated using (has_module(''cultivation'')) with check (has_module(''cultivation'') and not impersonating())', t);
    execute format('create policy cult_delete on %I for delete to authenticated using (has_module(''cultivation'') and not impersonating())', t);
    execute format('grant select, insert, update, delete on %I to authenticated', t);
    execute format('grant usage on sequence %I to authenticated', t || '_id_seq');
  end loop;
end $$;

alter table cult_test_protocols enable row level security;
drop policy if exists cult_read on cult_test_protocols; drop policy if exists cult_edit on cult_test_protocols;
create policy cult_read on cult_test_protocols for select to authenticated using (has_module('cultivation'));
create policy cult_edit on cult_test_protocols for update to authenticated using (has_module('cultivation')) with check (has_module('cultivation') and not impersonating());
grant select, update on cult_test_protocols to authenticated;

alter table cult_log enable row level security;
drop policy if exists cult_read on cult_log;
create policy cult_read on cult_log for select to authenticated using (has_module('cultivation'));
grant select on cult_log to authenticated;

-- module settings (sampling day, labs, equipment) live in app_settings under "cult."
create or replace function set_cult_setting(p_key text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_module('cultivation');
  if p_key not like 'cult.%' then raise exception 'Not a cultivation setting'; end if;
  insert into app_settings values (p_key, coalesce(p_value, '')) on conflict (key) do update set value = excluded.value;
  insert into cult_log (user_email, tbl, op, data) values (current_email(), 'app_settings', 'update', jsonb_build_object(p_key, p_value));
end $$;

-- ---------- pallets from a harvest ----------
-- p_rows: [{"lbs": 650, "tag": "1A40...", "code": "P1250" (optional)}]
-- Each becomes a pallet in the freezer app with no spot yet ("Needs a spot" in Review).
create or replace function cult_add_pallets(p_harvest bigint, p_rows jsonb) returns text[]
language plpgsql security definer set search_path = public as $$
declare h cult_harvests; f fields; s sites; r jsonb; v_code text; v_tag text; v_lbs numeric; used text;
        pre text; nxt int; p pallets; out text[] := '{}'; pd date;
begin
  perform require_module('cultivation');
  perform require_staff();
  select * into h from cult_harvests where id = p_harvest for update;
  if not found then raise exception 'Harvest not found'; end if;
  if h.kind not in ('ff') then raise exception 'Pallets are for fresh frozen harvests'; end if;
  select * into f from fields where id = h.field_id;
  select * into s from sites where code = h.site;
  select planted_on into pd from cult_plantings where id = h.planting_id;
  pre := case when f.kind = 'trials' then 'T' else coalesce(s.pallet_prefix, 'P') end;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_lbs := nullif(r ->> 'lbs', '')::numeric;
    v_tag := upper(nullif(trim(r ->> 'tag'), ''));
    v_code := upper(nullif(trim(r ->> 'code'), ''));
    if v_lbs is null or v_lbs <= 0 then raise exception 'Every pallet needs a weight'; end if;
    if v_tag is not null then
      used := tag_in_use(v_tag, null);
      if used is not null then raise exception 'Tag % is already on pallet %', v_tag, used; end if;
    end if;
    if v_code is null then
      select coalesce(max(substring(code from length(pre) + 1)::int), 0) + 1 into nxt
        from pallets where code ~ ('^' || pre || '[0-9]+$');
      v_code := pre || case when pre = 'T' then lpad(nxt::text, 3, '0') else nxt::text end;
    end if;
    if exists (select 1 from pallets where code = v_code) then raise exception 'Pallet % already exists', v_code; end if;
    insert into pallets (code, strain, zone, harvest_date, planting_date, og_weight, current_weight, package_tag, tag_pending,
                         status, slot_id, harvest_id, received_site, notes)
    values (v_code, h.strain, coalesce(f.name, ''), coalesce(h.harvested_on, current_date), pd, v_lbs, v_lbs, v_tag, v_tag is null,
            'unslotted', null, h.id, case when h.site = 'GVR' then 'GVR' end, nullif(trim(r ->> 'note'), ''))
    returning * into p;
    insert into events (user_email, type, pallet_id, lbs, note, details)
    values (current_email(), 'harvested', p.id, v_lbs, null,
            jsonb_build_object('strain', h.strain, 'field', f.name, 'site', h.site, 'harvest_id', h.id, 'tag', v_tag));
    out := out || v_code;
  end loop;
  update cult_harvests set status = 'done', harvested_on = coalesce(harvested_on, current_date) where id = h.id;
  return out;
end $$;

revoke execute on function cult_add_pallets(bigint, jsonb), set_cult_setting(text, text), cult_audit(), cult_strain_name() from public, anon;
grant execute on function cult_add_pallets(bigint, jsonb), set_cult_setting(text, text) to authenticated;

-- ---------- yields ----------
-- one row per harvest with its actual numbers (pallet lbs when the harvest has pallets)
create or replace view cult_harvest_actuals with (security_invoker = true) as
  select h.id, h.crop_year, h.site, h.field_id, h.strain, h.kind, h.planting_id, h.harvested_on,
         coalesce(h.plants_harvested, h.plants) as plants,
         coalesce(h.raw_lbs, (select sum(b) from unnest(h.raw_bins) b)) as raw_lbs,
         coalesce(h.ff_lbs, (select sum(p.og_weight) from pallets p where p.harvest_id = h.id and p.parent_id is null)) as ff_lbs,
         (select count(*) from pallets p where p.harvest_id = h.id) as pallets
    from cult_harvests h
   where h.status = 'done';
grant select on cult_harvest_actuals to authenticated;

-- check
select (select count(*) from cult_test_protocols) as protocols, has_module('cultivation') as you_have_it;
