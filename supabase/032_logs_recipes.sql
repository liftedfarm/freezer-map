-- Migration 032: field logs the way Farm Data OHR keeps them (rates per acre x acres, fertigation runs, foliar feed/pesticide,
-- amendments and side dress, field actions with equipment), recipes (Vegetative / Transition / Flower fertigation, Foliar Recipe A),
-- product prices for cost per acre, and where nursery mothers came from (Internal, TC, HVN).
-- Run after 031. Safe to re-run. 033 then imports the 2026 OHR logs and the current nursery G1 inventory.
set client_min_messages = warning;

alter table ops_logs add column if not exists method text;          -- Fertigation, Foliar, Amendment / side dress, Drench…
alter table ops_logs add column if not exists acres numeric;        -- acres covered (rates are per acre)
alter table ops_logs add column if not exists run_min numeric;      -- fertigation run time
alter table ops_logs add column if not exists equipment text;       -- labor: tractor, implement, tools
alter table ops_logs add column if not exists recipe text;          -- recipe used, if any
create index if not exists ops_logs_site_idx on ops_logs (module, site, log_on desc);

-- products: price for cost per acre, pesticide details for the spray log
alter table input_products add column if not exists price numeric;           -- $ per unit
alter table input_products add column if not exists price_unit text;         -- gal, lb, fl oz…
alter table input_products add column if not exists pesticide boolean not null default false;
alter table input_products add column if not exists epa_reg text;
alter table input_products add column if not exists rei_hours numeric;
alter table input_products add column if not exists phi_days numeric;
alter table input_products add column if not exists active_ingredient text;

insert into input_products (name, manufacturer, rate, rate_unit, kind, npk, price, price_unit, pesticide) values
  ('True Organics (8-0-0)', 'True Organics', 8.5, 'gal/acre', 'Liquid nitrogen', '8-0-0', 1.37, 'gal', false),
  ('True Organics (14-0-0)', 'True Organics', 5, 'lb/acre', 'Nitrogen', '14-0-0', null, null, false),
  ('True Organics (16-0-0)', 'True Organics', 32, 'lb/acre', 'Nitrogen', '16-0-0', null, null, false),
  ('Agrothrive LFP (2-7-0)', 'Agrothrive', 8, 'gal/acre', 'Liquid fish', '2-7-0', 6.6, 'gal', false),
  ('Agrothrive LF (2.5-2.5-2.5)', 'Agrothrive', null, 'gal/acre', 'Liquid fish', '2.5-2.5-2.5', null, null, false),
  ('Diamond K SOP (0-0-50)', 'Diamond K', 8.5, 'lb/acre', 'Potassium sulfate', '0-0-50', 0.86, 'lb', false),
  ('Biomin Copper', 'JH Biotech', 7.85, 'fl oz/acre', 'Micronutrient', null, 0.17, 'fl oz', false),
  ('Biomin Zinc', 'JH Biotech', 7.4, 'fl oz/acre', 'Micronutrient', null, 0.17, 'fl oz', false),
  ('Regalia', 'Marrone Biosciences', 32, 'fl oz/acre', 'Biofungicide', null, 1.86, 'fl oz', true),
  ('Maritime Kelp', 'Maritime', 1, 'gal/acre', 'Kelp', null, 65.64, 'gal', false),
  ('Biolink Molybdenum', 'San Agrow', null, 'fl oz/acre', 'Micronutrient', null, null, null, false),
  ('Rebound Cobalt', 'AEA', null, 'fl oz/acre', 'Micronutrient', null, null, null, false),
  ('DiPel DF', 'Valent Biosciences', null, 'lb/acre', 'Bt insecticide (caterpillars)', null, null, null, true),
  ('Microthiol Disperss', 'UPL', null, 'lb/acre', 'Sulfur fungicide', null, null, null, true),
  ('ThermX70', 'American Extracts', null, 'fl oz/acre', 'Surfactant (yucca)', null, null, null, false),
  ('CFO', null, null, 'fl oz/acre', null, null, null, null, false),
  ('Spectrum PSB', null, null, 'g/acre', 'Microbial', null, null, null, false),
  ('Bio-Tam 2.0', null, null, 'lb/acre', 'Biofungicide', null, null, null, true),
  ('Nature Safe 7-12-0', 'Nutrien', null, 'lb/acre', 'Dry fertilizer (side dress)', '7-12-0', null, null, false),
  ('True Organics 13-0-0', 'Nutrien', null, 'lb/acre', 'Dry fertilizer (side dress)', '13-0-0', null, null, false),
  ('Worm Compost', 'CCWF', null, 'ton/acre', 'Compost', null, null, null, false),
  ('Gypsum', 'CCWF', null, 'ton/acre', 'Amendment', null, null, null, false)
on conflict (name) do nothing;
update input_products set price = 0.2, price_unit = 'fl oz' where name in ('Biomin Iron', 'Biomin Manganese') and price is null;
update input_products set price = 0.23, price_unit = 'fl oz' where name = 'Biomin Calcium' and price is null;
update input_products set price = 0.093, price_unit = 'fl oz' where name = 'Humic 600' and price is null;
update input_products set pesticide = true where name in ('Azaguard','Pyganic','PFR-97','Regalia','Sulfur','Venerate','DiPel DF','Microthiol Disperss','Bio-Tam 2.0');

-- ---------- recipes ----------
create table if not exists ops_recipes (
  id          serial primary key,
  module      text not null check (module in ('nursery','cultivation')),
  kind        text not null check (kind in ('spray','feed')),
  name        text not null,
  method      text,                         -- Fertigation, Foliar…
  stage       text,                         -- Vegetative, Transition, Flower
  water_per_acre numeric,                   -- foliar: gallons of water per acre
  products    jsonb not null default '[]',  -- [{"product":"Biomin Iron","rate":80,"unit":"fl oz","basis":"acre"}]
  notes       text,
  active      boolean not null default true,
  sort        int not null default 0,
  updated_at  timestamptz not null default now(),
  unique (module, name)
);
alter table ops_recipes enable row level security;
drop policy if exists n_read on ops_recipes; drop policy if exists n_add on ops_recipes; drop policy if exists n_edit on ops_recipes; drop policy if exists n_delete on ops_recipes;
create policy n_read on ops_recipes for select to authenticated using (has_module(module) or is_admin());
create policy n_add on ops_recipes for insert to authenticated with check (is_mod_admin(module) and not impersonating());
create policy n_edit on ops_recipes for update to authenticated using (is_mod_admin(module)) with check (is_mod_admin(module) and not impersonating());
create policy n_delete on ops_recipes for delete to authenticated using (is_mod_admin(module) and not impersonating());
grant select, insert, update, delete on ops_recipes to authenticated;
grant usage on sequence ops_recipes_id_seq to authenticated;

insert into ops_recipes (module, kind, name, method, stage, products, notes, sort) values
  ('cultivation', 'feed', 'Vegetative (NPK 3-1-2)', 'Fertigation', 'Vegetative',
   '[{"product":"True Organics (8-0-0)","rate":8.5,"unit":"gal","basis":"acre"},{"product":"Agrothrive LFP (2-7-0)","rate":8,"unit":"gal","basis":"acre"},{"product":"Diamond K SOP (0-0-50)","rate":8.5,"unit":"lb","basis":"acre"},{"product":"Biomin Iron","rate":80,"unit":"fl oz","basis":"acre"},{"product":"Biomin Manganese","rate":58,"unit":"fl oz","basis":"acre"},{"product":"Biomin Copper","rate":7.85,"unit":"fl oz","basis":"acre"},{"product":"Biomin Zinc","rate":7.4,"unit":"fl oz","basis":"acre"}]',
   'From Farm Data OHR 2026', 1),
  ('cultivation', 'feed', 'Transition (NPK 1-1-1)', 'Fertigation', 'Transition',
   '[{"product":"True Organics (8-0-0)","rate":3,"unit":"gal","basis":"acre"},{"product":"Agrothrive LFP (2-7-0)","rate":20,"unit":"gal","basis":"acre"},{"product":"Diamond K SOP (0-0-50)","rate":10,"unit":"lb","basis":"acre"},{"product":"Biomin Iron","rate":80,"unit":"fl oz","basis":"acre"},{"product":"Biomin Manganese","rate":58,"unit":"fl oz","basis":"acre"},{"product":"Biomin Copper","rate":7.85,"unit":"fl oz","basis":"acre"},{"product":"Biomin Zinc","rate":7.4,"unit":"fl oz","basis":"acre"}]',
   'From Farm Data OHR 2026', 2),
  ('cultivation', 'feed', 'Flower (NPK 1-3-3)', 'Fertigation', 'Flower',
   '[{"product":"True Organics (8-0-0)","rate":2,"unit":"gal","basis":"acre"},{"product":"Agrothrive LFP (2-7-0)","rate":25,"unit":"gal","basis":"acre"},{"product":"Diamond K SOP (0-0-50)","rate":8,"unit":"lb","basis":"acre"},{"product":"Biomin Iron","rate":80,"unit":"fl oz","basis":"acre"},{"product":"Biomin Manganese","rate":58,"unit":"fl oz","basis":"acre"},{"product":"Biomin Copper","rate":7.85,"unit":"fl oz","basis":"acre"},{"product":"Biomin Zinc","rate":7.4,"unit":"fl oz","basis":"acre"}]',
   'From Farm Data OHR 2026', 3)
on conflict (module, name) do nothing;
insert into ops_recipes (module, kind, name, method, water_per_acre, products, notes, sort) values
  ('cultivation', 'spray', 'Foliar Recipe A', 'Foliar', 40,
   '[{"product":"True Organics (8-0-0)","rate":1.1,"unit":"gal","basis":"acre"},{"product":"Agrothrive LFP (2-7-0)","rate":2,"unit":"gal","basis":"acre"},{"product":"Regalia","rate":32,"unit":"fl oz","basis":"acre"},{"product":"Maritime Kelp","rate":1,"unit":"gal","basis":"acre"},{"product":"Humic 600","rate":96,"unit":"fl oz","basis":"acre"},{"product":"Biomin Calcium","rate":64,"unit":"fl oz","basis":"acre"},{"product":"Biomin Iron","rate":64,"unit":"fl oz","basis":"acre"},{"product":"Biomin Manganese","rate":64,"unit":"fl oz","basis":"acre"},{"product":"Biomin Copper","rate":32,"unit":"fl oz","basis":"acre"},{"product":"Biomin Zinc","rate":32,"unit":"fl oz","basis":"acre"}]',
   '40 gal water per acre. From Farm Data OHR 2026', 10)
on conflict (module, name) do nothing;

-- ---------- nursery: where a mother lot came from ----------
alter table nursery_mothers add column if not exists source text;     -- Internal, TC (tissue culture), HVN (Haze Valley), seed
-- Tiffani's 2027 sheet assumes 20 cuts per G1 mom; flag batches under 60% rooted
update app_settings set value = '20' where key = 'nursery.cuts_g1' and value = '15';
insert into app_settings (key, value) values ('nursery.low_success', '60') on conflict (key) do nothing;
create or replace function set_nursery_setting(p_key text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
declare was text;
begin
  perform no_view_as();
  if not is_mod_admin('nursery') then raise exception 'Only a Nursery Admin can change Nursery settings'; end if;
  if p_key not in ('nursery.clone_price','nursery.terms','nursery.root_days','nursery.ready_warn_days',
                   'nursery.buffer_pct','nursery.deliver_pct','nursery.tray','nursery.cuts_g3','nursery.cuts_g2','nursery.cuts_g1',
                   'nursery.g3_veg_days','nursery.g3_root_days','nursery.g2_lead_days','nursery.g1_lead_days','nursery.wage','nursery.low_success') then
    raise exception 'Unknown setting %', p_key;
  end if;
  if p_key <> 'nursery.terms' and p_value !~ '^\d+(\.\d+)?$' then raise exception 'Enter a number'; end if;
  select value into was from app_settings where key = p_key;
  insert into app_settings values (p_key, coalesce(p_value, '')) on conflict (key) do update set value = excluded.value;
  insert into events (user_email, type, note, details) values (current_email(), 'nursery_setting', p_key, jsonb_build_object('key', p_key, 'value', p_value, 'was', was));
end $$;

select 'ok' as logs_recipes, (select count(*) from ops_recipes) as recipes, (select count(*) from input_products) as products;
