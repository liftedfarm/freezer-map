begin;
-- Migration 056: CCOF approved materials list + which sites are CCOF certified.
-- Run once in Supabase after 055_compliance.sql: SQL Editor > New query > paste > Run. Safe to re-run.
--
--  * The CCOF OSP Materials List (MyCCOF, generated 10/23/2026, 104 entries) is loaded into comp_ccof_list. Compliance can load a
--    newer one any time: CCOF > CCOF list > drop the PDF.
--  * Production and Nursery products are linked to their CCOF list entry; the link sets approved (Allowed or Restricted),
--    the listing (OMRI / CDFA OIM / WSDA / CCOF reviewed) and CCOF's restriction text. Products not on the list stay "Not reviewed".
--  * Sites and certifications: OHR and GVR are CCOF certified, the 1PN nursery is not (Compliance > Settings > Sites).
--    Logs and products at sites that aren't certified are left out of the CCOF checks and warnings.
set client_min_messages = warning;

-- ---------- sites and certifications ----------
create table if not exists comp_certs (
  site        text primary key,
  label       text,
  ccof        boolean not null default false,
  notes       text,
  updated_by  text,
  updated_at  timestamptz not null default now()
);
insert into comp_certs (site, label, ccof, notes, updated_by) values
  ('OHR', 'Oak Hill Ranch', true, null, 'setup'),
  ('GVR', '1363 Green Valley Rd', true, null, 'setup'),
  ('1PN', '1PN nursery (361 Webb Rd)', false, null, 'setup')
on conflict (site) do nothing;

create or replace function comp_site_certified(p_site text, p_module text default null) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select ccof from comp_certs where upper(site) = upper(coalesce(nullif(trim(p_site), ''), case when p_module = 'nursery' then '1PN' end))),
                  coalesce(p_module, 'cultivation') <> 'nursery')
$$;

create or replace function comp_set_cert(p_site text, p_ccof boolean, p_notes text default null) returns void
language plpgsql security definer set search_path = public as $$
declare c comp_certs;
begin
  if not comp_is_admin() then raise exception 'Only a Compliance Admin can change certifications'; end if;
  select * into c from comp_certs where upper(site) = upper(trim(p_site));
  if c.site is null then
    insert into comp_certs (site, label, ccof, notes, updated_by) values (upper(trim(p_site)), upper(trim(p_site)), p_ccof, nullif(trim(p_notes), ''), current_email());
  else
    update comp_certs set ccof = p_ccof, notes = coalesce(nullif(trim(p_notes), ''), notes), updated_by = current_email(), updated_at = now() where site = c.site;
  end if;
  perform _comp_event('comp_cert', upper(trim(p_site)), jsonb_build_object('site', upper(trim(p_site)), 'ccof', p_ccof, 'was', c.ccof));
end $$;

-- ---------- the CCOF list ----------
create table if not exists comp_ccof_list (
  id               serial primary key,
  code             text not null,
  name             text not null,
  manufacturer     text,
  category         text,
  approved_on      date,
  status           text,          -- Allowed / Restricted / Unknown …
  listing          text,          -- OMRI listed / CDFA OIM Approved / WSDA listed / CCOF reviewed
  restriction      text,
  comment          text,
  action_required  boolean not null default false,
  active           boolean not null default true,
  list_date        date,
  updated_at       timestamptz not null default now()
);
create unique index if not exists comp_ccof_list_uq on comp_ccof_list (code, name, coalesce(comment, ''));
alter table input_products add column if not exists ccof_code text;

do $$
declare t text;
begin
  foreach t in array array['comp_certs','comp_ccof_list'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists comp_read on %I', t);
    execute format('create policy comp_read on %I for select to authenticated using (comp_can_read())', t);
    execute format('grant select on %I to authenticated', t);
  end loop;
end $$;

/** copy a product's CCOF list entry onto it (status, listing, restriction) */
create or replace function _comp_apply_ccof(p_product int) returns void
language plpgsql security definer set search_path = public as $$
declare m input_products; e comp_ccof_list;
begin
  select * into m from input_products where id = p_product;
  if m.ccof_code is null then return; end if;
  select * into e from comp_ccof_list where code = m.ccof_code and active order by action_required, id limit 1;
  if e.id is null then
    update input_products set ccof_status = 'unknown', ccof_notes = concat_ws(' ', 'CCOF code ' || m.ccof_code || ' is no longer on the CCOF list.', ccof_notes),
      ccof_by = 'CCOF list', ccof_at = now() where id = p_product;
    return;
  end if;
  update input_products set
    ccof_status = case when e.action_required or coalesce(e.status, '') !~* '^(allowed|restricted)' then 'pending'
                       else 'approved' end,
    listing = case when e.listing ~* 'omri' then 'OMRI' when e.listing ~* 'cdfa' then 'CDFA OIM' when e.listing ~* 'wsda' then 'WSDA'
                   when e.listing ~* 'ccof' then 'CCOF approved' else coalesce(listing, e.listing) end,
    listing_no = e.code,
    restrictions = case when e.status ~* 'restricted' or e.action_required then e.restriction else restrictions end,
    ccof_by = 'CCOF list', ccof_at = now()
  where id = p_product;
end $$;
revoke execute on function _comp_apply_ccof(int) from public, anon, authenticated;

/** load a CCOF list (rows read from the PDF). Entries not in the new list are switched off; linked products are refreshed. */
create or replace function _comp_ccof_load(p_date date, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; n_new int := 0; n_upd int := 0; n_gone int; n_link int := 0; was boolean; p record;
begin
  update comp_ccof_list set active = false where active;
  for r in select * from jsonb_array_elements(p_rows) loop
    if nullif(trim(r ->> 'code'), '') is null or nullif(trim(r ->> 'name'), '') is null then continue; end if;
    select active into was from comp_ccof_list where code = trim(r ->> 'code') and name = trim(r ->> 'name') and coalesce(comment, '') = coalesce(nullif(trim(r ->> 'comment'), ''), '');
    insert into comp_ccof_list (code, name, manufacturer, category, approved_on, status, listing, restriction, comment, action_required, active, list_date, updated_at)
    values (trim(r ->> 'code'), trim(r ->> 'name'), nullif(trim(r ->> 'manufacturer'), ''), nullif(trim(r ->> 'category'), ''), nullif(r ->> 'approved_on', '')::date,
            nullif(trim(r ->> 'status'), ''), nullif(trim(r ->> 'listing'), ''), nullif(trim(r ->> 'restriction'), ''), nullif(trim(r ->> 'comment'), ''),
            coalesce((r ->> 'action_required')::boolean, false), true, p_date, now())
    on conflict (code, name, coalesce(comment, '')) do update set manufacturer = excluded.manufacturer, category = excluded.category, approved_on = excluded.approved_on,
      status = excluded.status, listing = excluded.listing, restriction = excluded.restriction, action_required = excluded.action_required,
      active = true, list_date = excluded.list_date, updated_at = now();
    if found and was is null then n_new := n_new + 1; else n_upd := n_upd + 1; end if;
  end loop;
  select count(*) into n_gone from comp_ccof_list where not active;
  -- products not linked yet: link when the name matches an entry exactly (ignoring case, punctuation, ® ™)
  for p in select m.id, e.code from input_products m
             join lateral (select code from comp_ccof_list e where e.active
                             and regexp_replace(lower(e.name), '[^a-z0-9]+', '', 'g') = regexp_replace(lower(m.name), '[^a-z0-9]+', '', 'g') order by id limit 1) e on true
            where m.ccof_code is null loop
    update input_products set ccof_code = p.code where id = p.id; n_link := n_link + 1;
  end loop;
  perform _comp_apply_ccof(id) from input_products where ccof_code is not null;
  return jsonb_build_object('new', n_new, 'updated', n_upd, 'off_list', n_gone, 'linked', n_link,
    'active', (select count(*) from comp_ccof_list where active));
end $$;
revoke execute on function _comp_ccof_load(date, jsonb) from public, anon, authenticated;

create or replace function comp_import_ccof(p_date date, p_rows jsonb, p_file text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  if not comp_can_edit() then raise exception 'Only Compliance can load the CCOF list'; end if;
  if jsonb_array_length(coalesce(p_rows, '[]')) < 5 then raise exception 'That doesn''t look like a CCOF materials list (too few entries)'; end if;
  r := _comp_ccof_load(coalesce(p_date, current_date), p_rows);
  perform _comp_event('comp_ccof_import', coalesce(p_file, 'CCOF list'), r || jsonb_build_object('date', p_date));
  return r;
end $$;

create or replace function comp_link_ccof(p_product int, p_code text) returns void
language plpgsql security definer set search_path = public as $$
declare m input_products;
begin
  if not comp_can_edit() then raise exception 'Only Compliance can link products to the CCOF list'; end if;
  select * into m from input_products where id = p_product;
  if m.id is null then raise exception 'Product not found'; end if;
  if nullif(trim(p_code), '') is not null and not exists (select 1 from comp_ccof_list where code = trim(p_code) and active) then raise exception 'Code % isn''t on the CCOF list', p_code; end if;
  update input_products set ccof_code = nullif(trim(p_code), ''), updated_at = now() where id = p_product;
  if nullif(trim(p_code), '') is null then
    update input_products set ccof_status = 'unknown', listing_no = null, ccof_by = current_email(), ccof_at = now() where id = p_product;
  else perform _comp_apply_ccof(p_product); end if;
  perform _comp_event('comp_material', m.name, jsonb_build_object('id', p_product, 'ccof_code', p_code, 'changes', jsonb_build_object('ccof_code', p_code)));
end $$;

-- ---------- CCOF checks only at certified sites ----------
create or replace function comp_material_issues(p_since date default null) returns table (
  log_id bigint, module text, log_on date, site text, area text, product text, issue text, product_id int)
language sql stable security definer set search_path = public as $$
  select l.id, l.module, l.log_on, l.site, l.area, x ->> 'product',
         case when m.id is null then 'not on the product list'
              when m.ccof_status = 'not_allowed' then 'not allowed'
              when m.ccof_status = 'pending' then 'approval pending'
              when m.ccof_status = 'unknown' and m.ccof_code is null then 'not on the CCOF list'
              when m.ccof_status = 'unknown' then 'not reviewed'
              else 'listing had expired' end, m.id
    from ops_logs l
    cross join lateral jsonb_array_elements(coalesce(l.products, '[]')) x
    left join lateral (select * from input_products m where lower(m.name) = lower(x ->> 'product') and m.module = l.module order by m.active desc limit 1) m on true
   where comp_can_read() and l.kind in ('feed','spray') and l.log_on >= coalesce(p_since, make_date(extract(year from current_date)::int, 1, 1))
     and comp_site_certified(l.site, l.module)
     and nullif(trim(x ->> 'product'), '') is not null
     and (m.id is null or m.ccof_status <> 'approved' or (m.listing_expires is not null and m.listing_expires < l.log_on))
   order by l.log_on desc
$$;

-- ---------- the list as of 10/23/2026 ----------
create temp table _ccof_seed (code text, name text, manufacturer text, category text, approved_on date, status text, listing text, restriction text, comment text, action_required boolean) on commit drop;
create temp table _ccof_map (product text, code text) on commit drop;
-- CCOF OSP Materials List generated 10/23/2026 for DNA Organics, Inc. dba Lifted (104 entries)
insert into _ccof_seed (code, name, manufacturer, category, approved_on, status, listing, restriction, comment, action_required) values
  ('01771', 'Down To Earth All Natural Oyster Shell', 'Down To Earth Distributors, Inc.', 'Crop Fertilizers and Soil Amendments', '2025-08-27', 'Unknown', 'Formerly Third Party Approved', 'Confirm if you still use this material. If yes, submit a complete, current ingredient statement from the manufacturer. Additional information may be required. If we are unable to re-approve this material or you do not remove it from your OSP, you will be notified to cease use.', 'ingredient in custom planting medium', true),
  ('08492', 'Acadian Organic Liquid Seaweed Concentrate 0.1-0-5', 'Acadian Seaplants Limited', 'Crop Fertilizers and Soil Amendments', '2024-09-23', 'Allowed', 'OMRI listed', null, null, false),
  ('21523', 'AGLIME 75', 'Blue Mountain Minerals', 'Crop Fertilizers and Soil Amendments', '2022-09-22', 'Allowed', 'CDFA OIM Approved', null, 'Added to Central Compost by supplier', false),
  ('29387', 'Agricultural Limestone', 'Blue Mountain Minerals', 'Crop Fertilizers and Soil Amendments', '2022-09-22', 'Allowed', 'CDFA OIM Approved', null, 'Added to Central Compost by supplier', false),
  ('00295', 'AgroThrive LF, 2.5-2.5-1.5 Liquid Organic Fertilizer', 'AgroThrive, Inc.', 'Crop Fertilizers and Soil Amendments', '2026-06-24', 'Allowed', 'OMRI listed', null, null, false),
  ('33060', 'Agrothrive LFP 2.0-7.0-0.3', 'AgroThrive, Inc.', 'Crop Fertilizers and Soil Amendments', '2024-09-23', 'Allowed', 'CDFA OIM Approved', null, null, false),
  ('13176', 'AgroThrive LFP, 2-7-0.3 Liquid Organic Fertilizer', 'AgroThrive, Inc.', 'Crop Fertilizers and Soil Amendments', '2023-09-05', 'Allowed', 'OMRI listed', null, null, false),
  ('00319', 'ALASKA® Fish Fertilizer 5-1-1', 'Lilly Miller Brands', 'Crop Fertilizers and Soil Amendments', '2024-09-23', 'Allowed', 'OMRI listed', 'Caution: This product has been inspected and approved for use in NOP organic production by OMRI. Footnote: This product is a liquid fertilizer subject to the requirements of NOP Guidance 5012.', null, false),
  ('28466', 'ALGACELL®FULL K MICROS', 'AGROPLASMA FERTICELL, SA DE CV', 'Crop Fertilizers and Soil Amendments', '2022-08-09', 'Restricted', 'OMRI listed', 'Micronutrient deficiency must be documented by soil or tissue testing or other documented and verifiable method as approved by a certifying agent. Must not be used as an herbicide, defoliant or desiccant. Refer to specific ingredient categories for applicable use restrictions.', null, false),
  ('27635', 'Axcel', 'Advancing Eco Agriculture', 'Crop Fertilizers and Soil Amendments', '2023-09-05', 'Restricted', 'CDFA OIM Approved', 'Micronutrients may be used only in cases where deficiency is documented by soil or tissue testing or other documented and verifiable method as approved by the certifying agent.', null, false),
  ('00538', 'Azomite® Micronized Natural Trace Minerals For Soil 0-0-0.2', 'AZOMITE Mineral Products, Inc.', 'Crop Fertilizers and Soil Amendments', '2025-05-09', 'Allowed', 'OMRI listed', null, 'ingredient in custom planting medium', false),
  ('29583', 'Bio S.I. Agricultural Formula Soil Inoculant', 'Bio S.I. Technology', 'Crop Fertilizers and Soil Amendments', '2022-09-22', 'Allowed', 'OMRI listed', null, null, false),
  ('02310', 'BioAg Ful-Power Humic Acid', 'Faust Bio-Agricultural Services Inc.', 'Crop Fertilizers and Soil Amendments', '2024-09-23', 'Allowed', 'OMRI listed', null, null, false),
  ('06865', 'BioFlora® Seaweed Creme®', 'BioFlora', 'Crop Fertilizers and Soil Amendments', '2022-08-09', 'Allowed', 'OMRI listed', null, null, false),
  ('29298', 'BioMend+', 'Coast Bio', 'Crop Fertilizers and Soil Amendments', '2022-08-09', 'Allowed', 'CDFA OIM Approved', null, null, false),
  ('00779', 'Biomin Booster 153 Complexed Minerals for Soil and Foliar Application 1-0-0', 'JH Biotech, Inc.', 'Crop Fertilizers and Soil Amendments', '2024-09-23', 'Restricted', 'OMRI listed', 'May be used as a plant or soil amendment if soil deficiency of magnesium is documented by testing. Micronutrient deficiency must be documented by soil or tissue testing or other documented and verifiable method as approved by a certifying agent. Must not be used as an herbicide, defoliant or desiccant. Caution: This product has been inspected and approved for use in NOP organic production by OMRI. Footnote: This product is a liquid fertilizer subject to the requirements of NOP Guidance 5012.', null, false),
  ('00782', 'Biomin Boron Minerals for Soil and Foliar Application', 'JH Biotech, Inc.', 'Crop Fertilizers and Soil Amendments', '2023-09-05', 'Restricted', 'OMRI listed', 'Micronutrient deficiency must be documented by soil or tissue testing or other documented and verifiable method as approved by a certifying agent. Must not be used as an herbicide, defoliant or desiccant.', null, false),
  ('00786', 'Biomin Calcium Amino Acid Complexed Minerals for Soil and Foliar Application', 'JH Biotech, Inc.', 'Crop Fertilizers and Soil Amendments', '2022-08-09', 'Allowed', 'OMRI listed', null, null, false),
  ('00788', 'Biomin Copper', 'JH Biotech, Inc.', 'Crop Fertilizers and Soil Amendments', '2022-09-22', 'Restricted', 'OMRI listed', 'Micronutrient deficiency must be documented by soil or tissue testing or other documented and verifiable method as approved by a certifying agent. Must not be used as an herbicide, defoliant or desiccant.', null, false),
  ('00791', 'Biomin Iron Complexed Mineral for Soil and Foliar Application 1-0-0', 'JH Biotech, Inc.', 'Crop Fertilizers and Soil Amendments', '2022-09-22', 'Restricted', 'OMRI listed', 'Micronutrient deficiency must be documented by soil or tissue testing or other documented and verifiable method as approved by a certifying agent. Must not be used as an herbicide, defoliant or desiccant.', null, false),
  ('00795', 'Biomin Manganese Complexed Mineral for Soil and Foliar Application 1-0-0', 'JH Biotech, Inc.', 'Crop Fertilizers and Soil Amendments', '2022-09-22', 'Restricted', 'OMRI listed', 'Micronutrient deficiency must be documented by soil or tissue testing or other documented and verifiable method as approved by a certifying agent. Must not be used as an herbicide, defoliant or desiccant.', null, false),
  ('00797', 'Biomin Zinc Complexed Mineral for Soil and Foliar Application 1-0-0', 'JH Biotech, Inc.', 'Crop Fertilizers and Soil Amendments', '2022-09-22', 'Restricted', 'OMRI listed', 'Micronutrient deficiency must be documented by soil or tissue testing or other documented and verifiable method as approved by a certifying agent. Must not be used as an herbicide, defoliant or desiccant.', null, false),
  ('28837', 'Biosci Humate', 'BioScientific, Inc.', 'Crop Fertilizers and Soil Amendments', '2022-08-09', 'Allowed', 'CDFA OIM Approved', null, null, false),
  ('30041', 'Calcium 6', 'KWS Distributing, LLC', 'Crop Fertilizers and Soil Amendments', '2024-09-23', 'Allowed', 'WSDA listed', null, null, false),
  ('15056', 'Cascade Organic Worm Castings', 'California Soils, Inc.', 'Crop Fertilizers and Soil Amendments', '2025-05-09', 'Allowed', 'OMRI listed', null, 'ingredient in custom planting medium', false),
  ('17754', 'Clean Calcium', 'Agro-K Corporation', 'Crop Fertilizers and Soil Amendments', '2024-09-23', 'Restricted', 'WSDA listed', 'Only for use as a foliar spray to treat physiological disorders associated with calcium uptake.', null, false),
  ('04196', 'Compass Minerals Protassium+™ Standard Fines For Organic Production Sulfate of Potash 0-0-50 Plus 17% Sulfur', 'Compass Minerals Ogden Inc.', 'Crop Fertilizers and Soil Amendments', '2022-09-22', 'Allowed', 'OMRI listed', null, null, false),
  ('01196', 'Compost', 'Central Coast Worm Farm, LLC', 'Crop Fertilizers and Soil Amendments', '2022-08-09', 'Allowed', 'CDFA OIM Approved', null, null, false),
  ('09783', 'Converted Organics 2-2-2', 'Converted Organics, LLC', 'Crop Fertilizers and Soil Amendments', '2026-06-24', 'Allowed', 'OMRI listed', null, null, false),
  ('33393', 'Cosmic Connections Cosmic Coir', 'Cosmic Connections LLC', 'Crop Fertilizers and Soil Amendments', '2025-05-09', 'Allowed', 'OMRI listed', null, 'ingredient in custom planting medium', false),
  ('05944', 'Diamond K Solution Grade Ultra Fines Sulfate of Potash 0-0-50', 'Diamond K Gypsum', 'Crop Fertilizers and Soil Amendments', '2023-09-05', 'Allowed', 'OMRI listed', null, null, false),
  ('10626', 'Down to Earth All Natural Fertilizer Bio-Live Starter & Transplant Mix 5-4-2', 'Down To Earth Distributors, Inc.', 'Crop Fertilizers and Soil Amendments', '2025-05-09', 'Allowed', 'OMRI listed', null, 'ingredient in custom planting medium', false),
  ('01757', 'Down To Earth All Natural Fertilizer Blood Meal 12-0-0', 'Down To Earth Distributors, Inc.', 'Crop Fertilizers and Soil Amendments', '2024-09-23', 'Allowed', 'OMRI listed', null, null, false),
  ('17834', 'Fish On 2-3-0.2', 'Pacific Northwest Organics LLC', 'Crop Fertilizers and Soil Amendments', '2024-09-23', 'Allowed', 'CDFA OIM Approved', null, null, false),
  ('20549', 'Grower''s Secret Nitrogen 16-0-0 Plant-Based Water Soluble Nitrogen', 'Grower''s Secret, Inc.', 'Crop Fertilizers and Soil Amendments', '2023-09-05', 'Allowed', 'OMRI listed', null, null, false),
  ('28908', 'High Nitrogen Liquid Fertilizer 5-0-0', 'Ductor Americas Inc', 'Crop Fertilizers and Soil Amendments', '2022-09-22', 'Restricted', 'CDFA OIM Approved', 'Must comply with the requirements of NOP 5012. Approved for use in NOP organic production by CDFA. Use must not contribute to contamination of crops, soil or water. NOP 205.203 (c).', null, false),
  ('21044', 'Holloway Gypsum 70%', 'H. M. Holloway, Inc.', 'Crop Fertilizers and Soil Amendments', '2022-09-22', 'Allowed', 'OMRI listed', null, 'Added to Central Compost by supplier', false),
  ('20230', 'HoloCal Ultra-micronized nutrient', 'Advancing Eco Agriculture', 'Crop Fertilizers and Soil Amendments', '2025-08-27', 'Allowed', 'CCOF reviewed', null, null, false),
  ('33202', 'Kelp Help', 'Pacific Northwest Organics LLC', 'Crop Fertilizers and Soil Amendments', '2024-09-23', 'Allowed', 'CDFA OIM Approved', null, null, false),
  ('08959', 'Lava Rock', 'Clearlake Lava', 'Crop Fertilizers and Soil Amendments', '2025-05-09', 'Allowed', 'CCOF reviewed', null, 'ingredient in custom planting medium', false),
  ('15674', 'Loveland Products Leaf Life Humic 600 For Soil and Foliar Applications', 'Loveland Products, Inc.', 'Crop Fertilizers and Soil Amendments', '2024-09-23', 'Allowed', 'OMRI listed', null, null, false),
  ('37479', 'Loveland Products Leaf Life™ Ca', 'Loveland Products, Inc.', 'Crop Fertilizers and Soil Amendments', '2026-08-18', 'Restricted', 'OMRI listed', 'For use as a foliar spray to treat a physiological disorder associated with calcium uptake.', null, false),
  ('02157', 'Microelements 1-0-0', 'Agroplasma, Inc.', 'Crop Fertilizers and Soil Amendments', '2022-09-22', 'Restricted', 'CDFA OIM Approved', 'Micronutrients may be used only in cases where deficiency is documented by soil or tissue testing or other documented and verifiable method as approved by the certifying agent.', null, false),
  ('12164', 'MicroPak', 'Advancing Eco Agriculture', 'Crop Fertilizers and Soil Amendments', '2023-09-05', 'Restricted', 'WSDA listed', 'Deficiency must be documented.', null, false),
  ('03697', 'Nature Safe Fertilizers 7-12-0 Fertilizer For Organic Production', 'Darling Ingredients', 'Crop Fertilizers and Soil Amendments', '2025-08-18', 'Allowed', 'OMRI listed', null, null, false),
  ('35798', 'N-Charge Pulse A Verdesian Nue Solution A Premium Non-Sterile High Adhesion Peat Inoculant for Pulse Crops - Pea, Vetch, Lentil and Chickpea/Garbanzo', 'Verdesian Life Sciences, U.S., LLC', 'Crop Fertilizers and Soil Amendments', '2024-12-10', 'Allowed', 'OMRI listed', null, null, false),
  ('02697', 'NOR•CAL Perlite Inc. Horticultural Perlite', 'NorCal Perlite Inc.', 'Crop Fertilizers and Soil Amendments', '2025-05-09', 'Allowed', 'OMRI listed', null, 'ingredient in custom planting medium''', false),
  ('10354', 'Organic BioLink Cal Plus 7% 0-6-0', 'SAN Group Biotech USA, Inc.', 'Crop Fertilizers and Soil Amendments', '2024-09-23', 'Allowed', 'WSDA listed', null, null, false),
  ('15511', 'Organic BioLink Moly4', 'SAN Group Biotech USA, Inc.', 'Crop Fertilizers and Soil Amendments', '2024-09-23', 'Restricted', 'WSDA listed', 'Deficiency must be documented.', null, false),
  ('26437', 'Phos Fish 1-7-0', 'Pacific Northwest Organics LLC', 'Crop Fertilizers and Soil Amendments', '2022-08-09', 'Allowed', 'CDFA OIM Approved', null, null, false),
  ('10801', 'PhotoMag ultra micronized nutrient', 'Advancing Eco Agriculture', 'Crop Fertilizers and Soil Amendments', '2023-09-05', 'Restricted', 'WSDA listed', 'Deficiency must be documented.', null, false),
  ('04495', 'Phyta-Grow Bone Meal 4-14-0', 'California Organic Fertilizers Inc.', 'Crop Fertilizers and Soil Amendments', '2024-09-26', 'Allowed', 'CDFA OIM Approved', null, null, false),
  ('15417', 'ProK 0-0-20', 'Agroplasma, Inc.', 'Crop Fertilizers and Soil Amendments', '2022-09-22', 'Allowed', 'CDFA OIM Approved', null, null, false),
  ('04757', 'PRO-MOSS TBK Professional Fibrous Blond Sphagnum Peat Moss', 'Premier Horticulture, Inc.', 'Crop Fertilizers and Soil Amendments', '2025-05-09', 'Allowed', 'OMRI listed', null, 'ingredient in custom planting medium', false),
  ('32529', 'Pure Worm Castings', 'Central Coast Worm Farm, LLC', 'Crop Fertilizers and Soil Amendments', '2023-09-05', 'Allowed', 'CDFA OIM Approved', null, null, false),
  ('18380', 'Rebound Boron nutrient solution', 'Advancing Eco Agriculture', 'Crop Fertilizers and Soil Amendments', '2023-09-05', 'Restricted', 'WSDA listed', 'Deficiency must be documented.', null, false),
  ('18379', 'Rebound Cobalt nutrient solution', 'Advancing Eco Agriculture', 'Crop Fertilizers and Soil Amendments', '2023-09-05', 'Restricted', 'WSDA listed', 'Deficiency must be documented.', null, false),
  ('18372', 'Rebound Copper nutrient solution', 'Advancing Eco Agriculture', 'Crop Fertilizers and Soil Amendments', '2023-09-05', 'Restricted', 'WSDA listed', 'Deficiency must be documented.', null, false),
  ('18381', 'Rebound Iron nutrient solution', 'Advancing Eco Agriculture', 'Crop Fertilizers and Soil Amendments', '2023-09-05', 'Restricted', 'WSDA listed', 'Micronutrients may be used only in cases where deficiency is documented by soil or tissue testing or other documented and verifiable method as approved by the certifying agent.', null, false),
  ('18378', 'Rebound Manganese nutrient solution', 'Advancing Eco Agriculture', 'Crop Fertilizers and Soil Amendments', '2023-09-05', 'Restricted', 'WSDA listed', 'Deficiency must be documented.', null, false),
  ('17860', 'Rebound Molybdenum nutrient solution', 'Advancing Eco Agriculture', 'Crop Fertilizers and Soil Amendments', '2023-09-05', 'Restricted', 'WSDA listed', 'Deficiency must be documented.', null, false),
  ('17859', 'Rebound Zinc nutrient solution', 'Advancing Eco Agriculture', 'Crop Fertilizers and Soil Amendments', '2023-09-05', 'Restricted', 'WSDA listed', 'Deficiency must be documented.', null, false),
  ('12165', 'Rejuvenate', 'Advancing Eco Agriculture', 'Crop Fertilizers and Soil Amendments', '2023-09-05', 'Allowed', 'WSDA listed', null, null, false),
  ('27554', 'SeaCrop', 'Advancing Eco Agriculture', 'Crop Fertilizers and Soil Amendments', '2025-12-16', 'Allowed', 'CDFA OIM Approved', null, null, false),
  ('16293', 'SeaShield', 'Advancing Eco Agriculture', 'Crop Fertilizers and Soil Amendments', '2025-04-23', 'Allowed', 'WSDA listed', null, null, false),
  ('12166', 'SeaStim', 'Advancing Eco Agriculture', 'Crop Fertilizers and Soil Amendments', '2023-09-05', 'Allowed', 'WSDA listed', null, null, false),
  ('05255', 'SLF-100', 'Ozona Environmental, LLC', 'Crop Fertilizers and Soil Amendments', '2024-09-23', 'Allowed', 'OMRI listed', null, null, false),
  ('00362', 'SQM Allganic Potassium Natural Soil Amendments and Fertilizers Sulfate of Potash Water Soluble 0-0-52', 'SQM North America Corp.', 'Crop Fertilizers and Soil Amendments', '2024-09-20', 'Allowed', 'OMRI listed', null, null, false),
  ('05533', 'Superzyme® Biological Growth Factor 1-0-4', 'JH Biotech, Inc.', 'Crop Fertilizers and Soil Amendments', '2022-08-09', 'Allowed', 'OMRI listed', null, null, false),
  ('03416', 'Tainio Biologicals, Inc. BFMS Biological Farm Management System Micro 5000 Organic Biological Foliar Nutrient 0-0-15', 'Tainio Biologicals, Inc.', 'Crop Fertilizers and Soil Amendments', '2024-09-23', 'Allowed', 'OMRI listed', 'Caution: The arsenic level of this product exceeds 20ppm. Application to certified organic farms must not contribute to contamination of crops, soil, or water.', null, false),
  ('13233', 'Tainio Biologicals, Inc. BFMS Biological Farm Management System MycoGenesis Biological Root Inoculant', 'Tainio Biologicals, Inc.', 'Crop Fertilizers and Soil Amendments', '2025-04-23', 'Allowed', 'OMRI listed', null, null, false),
  ('21284', 'Tainio Biologicals, Inc. BFMS Biological Farm Management System Spectrum PSB Phosphorus Solubilizing Biological Soil Inoculant', 'Tainio Biologicals, Inc.', 'Crop Fertilizers and Soil Amendments', '2025-04-23', 'Allowed', 'OMRI listed', null, null, false),
  ('05847', 'TRUE Organic Products, Inc 10-5-2', 'True Organic Products, Inc.', 'Crop Fertilizers and Soil Amendments', '2022-08-09', 'Allowed', 'OMRI listed', null, null, false),
  ('05854', 'TRUE Organic Products, Inc 13-0-0', 'True Organic Products, Inc.', 'Crop Fertilizers and Soil Amendments', '2026-09-02', 'Allowed', 'OMRI listed', null, null, false),
  ('20557', 'TRUE Organic Products, Inc True 3-2-2', 'True Organic Products, Inc.', 'Crop Fertilizers and Soil Amendments', '2026-06-24', 'Allowed', 'OMRI listed', 'Caution: This product has been inspected and approved for use in NOP organic production by OMRI. Footnote: This product is a liquid fertilizer subject to the requirements of NOP Guidance 5012.', null, false),
  ('19065', 'TRUE Organic Products, Inc True Nitro Soy 14-0-0', 'True Organic Products, Inc.', 'Crop Fertilizers and Soil Amendments', '2025-05-09', 'Allowed', 'OMRI listed', null, 'ingredient in custom planting medium', false),
  ('05940', 'Ultra Fine AG® Gypsum Soil Conditioner', 'Western Mining and Minerals, Inc.', 'Crop Fertilizers and Soil Amendments', '2025-05-09', 'Allowed', 'OMRI listed', null, 'ingredient in custom planting medium', false),
  ('18269', 'C.F.O.', 'Miller Chemical & Fertilizer LLC', 'Crop Management Tools and Production Aids', '2025-09-05', 'Allowed', 'WSDA listed', null, null, false),
  ('03690', 'Natural Wet® Wetting Agent', 'JH Biotech, Inc.', 'Crop Management Tools and Production Aids', '2022-08-09', 'Allowed', 'OMRI listed', null, null, false),
  ('05710', 'ThermX™ 70 Soil Conditioner Natural Wetting Agent', 'American Extracts', 'Crop Management Tools and Production Aids', '2025-12-16', 'Allowed', 'OMRI listed', null, null, false),
  ('34646', 'aginnovation Seedworx Organic Green', 'AgInnovation LLC', 'Crop Pest, Weed, and Disease Control', '2026-04-21', 'Restricted', 'OMRI listed', 'May only be used if the requirements of 205.206(e) are met, which require the use of preventive, mechanical, physical, and other pest, weed, and disease management practices. For use as an inert ingredient in combination with permitted active pesticidal ingredients.', 'Must be used only with an allowed pesticide; not approved for standalone use for seed visibility.', false),
  ('00530', 'AzaGuard', 'Biosafe Systems', 'Crop Pest, Weed, and Disease Control', '2022-08-09', 'Restricted', 'OMRI listed', 'May only be used if the requirements of 205.206(e) are met, which require the use of preventive, mechanical, physical, and other pest, weed, and disease management practices.', null, false),
  ('00534', 'AzaMax® Botanical Insecticide, Miticide, and Nematicide', 'Parry America Inc.', 'Crop Pest, Weed, and Disease Control', '2022-08-09', 'Restricted', 'OMRI listed', 'May only be used if the requirements of 205.206(e) are met, which require the use of preventive, mechanical, physical, and other pest, weed, and disease management practices.', null, false),
  ('13951', 'Bio-Tam 2.0', 'Gowan Company, LLC', 'Crop Pest, Weed, and Disease Control', '2026-08-25', 'Restricted', 'OMRI listed', 'May only be used if the requirements of 205.206(e) are met, which require the use of preventive, mechanical, physical, and other pest, weed, and disease management practices.', null, false),
  ('09379', 'BioWorks RootShield® PLUS+ WP Biological Fungicide', 'BioWorks, Inc.', 'Crop Pest, Weed, and Disease Control', '2026-08-25', 'Restricted', 'OMRI listed', 'May only be used if the requirements of 205.206(e) are met, which require the use of preventive, mechanical, physical, and other pest, weed, and disease management practices.', null, false),
  ('01680', 'DES-X® Insecticidal Soap Concentrate', 'Certis USA', 'Crop Pest, Weed, and Disease Control', '2022-08-09', 'Restricted', 'OMRI listed', 'For use as an algicide/demosser, herbicide or insecticide. When used as an herbicide may only be used for farmstead maintenance (roadways, ditches, right of ways, building perimeters) and ornamental crops. May only be used if the requirements of 205.206(e) are met, which require the use of preventive, mechanical, physical, and other pest, weed, and disease management practices.', null, false),
  ('28612', 'DiPel DF Biological Insecticide Water Dispersible Granule', 'Valent BioSciences® LLC', 'Crop Pest, Weed, and Disease Control', '2023-09-05', 'Restricted', 'OMRI listed', 'May only be used if the requirements of 205.206(e) are met, which require the use of preventive, mechanical, physical, and other pest, weed, and disease management practices.', null, false),
  ('01727', 'DiPel® DF Biological Insecticide Dry Flowable', 'Valent BioSciences® LLC', 'Crop Pest, Weed, and Disease Control', '2025-02-21', 'Restricted', 'OMRI listed', 'May only be used if the requirements of 205.206(e) are met, which require the use of preventive, mechanical, physical, and other pest, weed, and disease management practices.', null, false),
  ('18821', 'JMS Flower Farms, Inc. JMS Stylet-Oil', 'JMS Flower Farms, Inc.', 'Crop Pest, Weed, and Disease Control', '2022-08-09', 'Restricted', 'OMRI listed', 'For use as an insecticide (including acaricide or mite control) and for plant disease control as dormant, suffocating, and stylet (summer) sprays. May only be used if the requirements of 205.206(e) are met, which require the use of preventive, mechanical, physical, and other pest, weed, and disease management practices.', null, false),
  ('10869', 'Mulch', 'Generic', 'Crop Pest, Weed, and Disease Control', '2025-09-29', 'Allowed', 'CCOF reviewed', null, 'ingredient in custom planting medium. Emerald Peat redwood bark from Mendocino Forest Products. 9/29/25 Affidavit of Input Material Composition.', false),
  ('10869', 'Mulch', 'Generic', 'Crop Pest, Weed, and Disease Control', '2025-09-29', 'Allowed', 'CCOF reviewed', null, 'ingredient in custom planting medium. Aged Fir Bark from Sierra Pacific Industries. 9/29/25 Affidavit of Input Material Composition.', false),
  ('16161', 'Mycotrol ESO Emulsifiable Suspension Mycoinsecticide', 'Certis USA', 'Crop Pest, Weed, and Disease Control', '2024-09-20', 'Restricted', 'OMRI listed', 'May only be used if the requirements of 205.206(e) are met, which require the use of preventive, mechanical, physical, and other pest, weed, and disease management practices.', null, false),
  ('34579', 'Mycotrol® WPO Wettable Powder Mycoinsecticide', 'Certis USA', 'Crop Pest, Weed, and Disease Control', '2025-02-21', 'Restricted', 'OMRI listed', 'May only be used if the requirements of 205.206(e) are met, which require the use of preventive, mechanical, physical, and other pest, weed, and disease management practices.', null, false),
  ('29740', 'PFR-97 10% ES Microbial Insecticide', 'Certis USA', 'Crop Pest, Weed, and Disease Control', '2024-09-20', 'Restricted', 'OMRI listed', 'May only be used if the requirements of 205.206(e) are met, which require the use of preventive, mechanical, physical, and other pest, weed, and disease management practices.', null, false),
  ('08879', 'PFR-97 20% WDG Microbial Insecticide', 'Certis USA', 'Crop Pest, Weed, and Disease Control', '2025-02-21', 'Restricted', 'OMRI listed', 'May only be used if the requirements of 205.206(e) are met, which require the use of preventive, mechanical, physical, and other pest, weed, and disease management practices.', null, false),
  ('04830', 'PyGanic Crop Protection EC 1.4 II', 'MGK', 'Crop Pest, Weed, and Disease Control', '2022-08-09', 'Restricted', 'OMRI listed', 'May only be used if the requirements of 205.206(e) are met, which require the use of preventive, mechanical, physical, and other pest, weed, and disease management practices.', null, false),
  ('04832', 'PyGanic Crop Protection EC 5.0 II', 'MGK', 'Crop Pest, Weed, and Disease Control', '2024-09-23', 'Restricted', 'OMRI listed', 'May only be used if the requirements of 205.206(e) are met, which require the use of preventive, mechanical, physical, and other pest, weed, and disease management practices.', null, false),
  ('19944', 'Regalia CG Biofungicide', 'Marrone Bio Innovations', 'Crop Pest, Weed, and Disease Control', '2025-02-21', 'Restricted', 'OMRI listed', 'May only be used if the requirements of 205.206(e) are met, which require the use of preventive, mechanical, physical, and other pest, weed, and disease management practices.', null, false),
  ('04921', 'Regalia® Biofungicide', 'Marrone Bio Innovations', 'Crop Pest, Weed, and Disease Control', '2022-08-09', 'Restricted', 'OMRI listed', 'May only be used if the requirements of 205.206(e) are met, which require the use of preventive, mechanical, physical, and other pest, weed, and disease management practices.', null, false),
  ('05189', 'Seduce Insect Bait Ant, Earwig, and Cutworm Bait', 'Certis USA', 'Crop Pest, Weed, and Disease Control', '2026-04-20', 'Restricted', 'OMRI listed', 'May only be used if the requirements of 205.206(e) are met, which require the use of preventive, mechanical, physical, and other pest, weed, and disease management practices.', null, false),
  ('07500', 'Sil-MATRIX™ Fungicide/Miticide/Insecticide', 'PQ LLC', 'Crop Pest, Weed, and Disease Control', '2024-09-23', 'Restricted', 'OMRI listed', 'For use as plant disease control, or as an insecticide (including acaricide or mite control). May only be used if the requirements of 205.206(e) are met, which require the use of preventive, mechanical, physical, and other pest, weed, and disease management practices.', null, false),
  ('29077', 'Thyme Guard Bactericide, Fungicide and Insecticide', 'Agro Bio USA', 'Crop Pest, Weed, and Disease Control', '2025-08-18', 'Restricted', 'OMRI listed', 'May only be used if the requirements of 205.206(e) are met, which require the use of preventive, mechanical, physical, and other pest, weed, and disease management practices.', null, false),
  ('03463', 'UPL Microthiol Disperss Micronized Wettable Sulfur Fungicide', 'UPL NA Inc.', 'Crop Pest, Weed, and Disease Control', '2023-09-05', 'Restricted', 'OMRI listed', 'For use as plant disease control, or as an insecticide (including acaricide or mite control). For use as slug and snail bait. May only be used if the requirements of 205.206(e) are met, which require the use of preventive, mechanical, physical, and other pest, weed, and disease management practices.', null, false),
  ('25781', 'Alcohol - Ethanol, Isopropanol (equipment surfaces only)', 'Generic', 'Processing Sanitizers and Cleaners', '2023-09-27', 'Restricted', 'CCOF reviewed', 'Must not directly contact organic products. Air drying or rinse is required. Have material label(s) available during inspections.', 'for cleaning and disinfecting bucking plates', false);
insert into _ccof_map (product, code) values
  ('agrothrive lf (2.5-2.5-2.5)', '00295'),
  ('agrothrive lfp (2-7-0)', '13176'),
  ('lfp', '13176'),
  ('azaguard', '00530'),
  ('bio-tam 2.0', '13951'),
  ('biolink molybdenum', '15511'),
  ('biomin calcium', '00786'),
  ('biomin copper', '00788'),
  ('biomin iron', '00791'),
  ('biomin manganese', '00795'),
  ('biomin zinc', '00797'),
  ('biomin booster', '00779'),
  ('cfo', '18269'),
  ('c.f.o.', '18269'),
  ('clean calcium', '17754'),
  ('dipel df', '01727'),
  ('diamond k 0-0-50', '05944'),
  ('diamond k sop (0-0-50)', '05944'),
  ('sop', '05944'),
  ('humic 600', '15674'),
  ('microthiol disperss', '03463'),
  ('sulfur', '03463'),
  ('nature safe 7-12-0', '03697'),
  ('pyganic', '04830'),
  ('rebound cobalt', '18379'),
  ('regalia', '04921'),
  ('spectrum psb', '21284'),
  ('thermx70', '05710'),
  ('true organics (14-0-0)', '19065'),
  ('true organics 13-0-0', '05854'),
  ('true organics (13-0-0)', '05854'),
  ('worm compost', '01196'),
  ('gs 16-0-0', '20549'),
  ('humic acid (ful-power)', '02310'),
  ('kelp help', '33202'),
  ('pfr-97', '08879');

-- dashboard numbers (only products used at certified sites)
create or replace function comp_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not has_module('compliance') then raise exception 'The Compliance module isn''t switched on for your account'; end if;
  with dl as (select * from comp_deadlines())
  select jsonb_build_object(
    'overdue', (select count(*) from dl where due_on < current_date),
    'due_soon', (select count(*) from dl where due_on >= current_date and due_on <= current_date + remind_days),
    'due_30', (select count(*) from dl where due_on between current_date and current_date + 30),
    'no_date', (select count(*) from dl where due_on is null and kind = 'obligation'),
    'docs', (select count(*) from comp_docs where deleted_at is null and current),
    'docs_by_type', (select coalesce(jsonb_object_agg(doc_type, n), '{}') from (select doc_type, count(*) n from comp_docs where deleted_at is null and current group by 1) x),
    'metrc_todo', (select count(*) from comp_metrc_actions where status = 'todo'),
    'metrc_error', (select count(*) from comp_metrc_actions where status = 'error'),
    'errors_open', (select count(*) from comp_metrc_errors where status = 'open'),
    'playbook', (select count(*) from comp_playbook),
    'materials', (select count(*) from input_products m where active and (m.module <> 'nursery' or comp_site_certified('1PN'))),
    'materials_approved', (select count(*) from input_products m where active and ccof_status = 'approved' and (m.module <> 'nursery' or comp_site_certified('1PN'))),
    'materials_unreviewed', (select count(*) from input_products m where active and ccof_status in ('unknown','pending') and (m.module <> 'nursery' or comp_site_certified('1PN'))),
    'materials_no_docs', (select count(*) from input_products m where m.active and m.ccof_status = 'approved' and (m.module <> 'nursery' or comp_site_certified('1PN'))
                            and not exists (select 1 from comp_doc_links k join comp_docs d on d.id = k.doc_id where k.ref_kind = 'material' and k.ref_id = m.id::text and d.deleted_at is null)),
    'material_issues', (select count(*) from comp_material_issues(null)),
    'not_on_list', (select count(*) from input_products m where m.active and m.ccof_code is null and (m.module <> 'nursery' or comp_site_certified('1PN'))),
    'ccof_list', (select jsonb_build_object('entries', count(*), 'date', max(list_date), 'action', count(*) filter (where action_required)) from comp_ccof_list where active),
    'certs', (select coalesce(jsonb_object_agg(site, ccof), '{}') from comp_certs),
    'last_recon', (select coalesce(jsonb_object_agg(license, at), '{}') from (select license, max(uploaded_at) at from comp_metrc_uploads group by 1) x),
    'licenses', (select coalesce(jsonb_agg(license_no order by sort, license_no), '[]') from licenses where active and kind <> 'transport'),
    'customers_missing', (select count(*) from comp_customers() where status in ('missing','expired')),
    'tests_no_file', (select count(*) from cult_tests t where t.results_on is not null and t.crop_year = extract(year from current_date)::int
                        and not exists (select 1 from comp_doc_links k join comp_docs d on d.id = k.doc_id where k.ref_kind = 'test' and k.ref_id = t.id::text and d.deleted_at is null)),
    'backup', (select to_jsonb(b) from comp_backup_runs b order by id desc limit 1),
    'backup_waiting', (select count(*) from comp_docs where file_path is not null and ((deleted_at is null and backed_up_at is null) or (deleted_at is not null and sp_item_id is not null and not sp_archived))),
    'sp_site', (select value from app_settings where key = 'comp.sp_site'),
    'sp_root', (select value from app_settings where key = 'comp.sp_root'),
    'weight_tol', (select value from app_settings where key = 'comp.weight_tol'),
    'stale_days', (select value from app_settings where key = 'comp.stale_days')
  ) into r;
  return r;
end $$;

-- load it (only if no newer list was loaded in the app already)
select _comp_ccof_load('2026-10-23', (select jsonb_agg(to_jsonb(s)) from _ccof_seed s))
 where coalesce((select max(list_date) from comp_ccof_list), '2000-01-01') <= '2026-10-23';
-- products whose names differ from CCOF's (matched by hand), only where nobody linked them yet
update input_products m set ccof_code = x.code from _ccof_map x where lower(m.name) = x.product and m.ccof_code is null
   and exists (select 1 from comp_ccof_list e where e.code = x.code and e.active);
select _comp_apply_ccof(id) from input_products where ccof_code is not null;
update input_products set ccof_notes = coalesce(ccof_notes, 'Not found on the CCOF materials list (10/23/2026). Link it under CCOF > Approved materials if it''s listed under another name, or add it in MyCCOF before using it.')
 where ccof_code is null and ccof_status = 'unknown' and module = 'cultivation';

-- ---------- grants ----------
do $$
declare f text;
begin
  foreach f in array array['comp_site_certified(text,text)','comp_set_cert(text,boolean,text)','comp_import_ccof(date,jsonb,text)','comp_link_ccof(int,text)',
                           'comp_material_issues(date)','comp_overview()'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

select (select count(*) from comp_ccof_list where active) as ccof_entries,
       (select count(*) from input_products where ccof_code is not null) as products_linked,
       (select count(*) from input_products where module = 'cultivation' and active and ccof_code is null) as production_products_not_on_list,
       (select string_agg(site || ' ' || case when ccof then 'certified' else 'not certified' end, ', ' order by site) from comp_certs) as sites;
commit;
