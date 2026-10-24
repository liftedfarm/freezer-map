-- Migration 057: harvest log > push > finish, auto METRC tags, trial strains, sort + machine trim runs, and fixes.
-- Run once in Supabase after 056_ccof_list.sql: SQL Editor > New query > paste > Run. Safe to re-run.
--
--  * Fresh frozen pallets are logged "Not pushed": they sit on the freezer map (they can be moved) but aren't packages yet.
--    Anything about them can be fixed in the Harvest log. Push turns them into packages (one at a time or all) and queues
--    the METRC steps: harvest plants into the batch (plants + wet weight), then create the packages.
--  * Finish harvest: closes the log, works out the waste (wet weight - pushed pallets) and queues "Record waste"
--    (due 48 hours later) and "Finish harvest" in METRC.
--  * A day that doesn't finish: Continue tomorrow makes the next day's harvest (own METRC batch, name -2, -3...).
--  * A harvest's strain can be renamed at harvest (planting mix-ups); the planting keeps its planted name.
--  * Pallet numbers make the METRC tag (P53 -> 1A406030007AD3D000010053) from per-site rules in Production Settings.
--  * Trial strains: a checkbox on the strain, kept on each planting; trial plantings make T pallets.
--  * Processing: Sort runs (bucked -> bucked standards + smalls) and Machine trim runs (-> standards + trim, no piece rate).
--  * Fixes: OHR <-> GVR moves queue a manifest to-do, METRC to-do tag column, trailer spots, order shipped dates.
set client_min_messages = warning;

-- =====================================================================================================
-- 1. columns
-- =====================================================================================================
alter table pallets add column if not exists pushed boolean not null default true;          -- false = logged at harvest, not a package yet
alter table pallets add column if not exists machine_trimmed boolean not null default false;  -- internal only: never on METRC, invoices, manifests, portal
alter table pallets add column if not exists span_to_slot int references slots(id) on delete set null;   -- trailers: also takes the spots up to here
alter table cult_weights add column if not exists pushed boolean not null default false;    -- in METRC (part of the batch's wet weight)
alter table cult_harvests add column if not exists parent_id bigint references cult_harvests(id) on delete set null;   -- day 2+ of a harvest
alter table cult_harvests add column if not exists day_no int not null default 1;
alter table cult_harvests add column if not exists metrc_wet_lbs numeric not null default 0;  -- wet weight already sent to METRC
alter table cult_harvests add column if not exists metrc_plants int not null default 0;      -- plants already harvested in METRC
alter table cult_harvests add column if not exists waste_lbs numeric;
alter table cult_harvests add column if not exists planted_strain text;                      -- what the planting called it, when renamed at harvest
alter table comp_metrc_actions add column if not exists due_at timestamptz;
alter table comp_metrc_actions add column if not exists harvest_id bigint;
alter table strains add column if not exists trial boolean not null default false;
alter table cult_plantings add column if not exists trial boolean not null default false;
-- existing weights on finished harvests are already in METRC (or were handled by hand)
update cult_weights w set pushed = true from cult_harvests h where h.id = w.harvest_id and h.status = 'done' and not w.pushed;
update cult_harvests h set metrc_wet_lbs = coalesce((select sum(lbs) from cult_weights w where w.harvest_id = h.id and w.kind = 'raw'), 0),
       metrc_plants = coalesce(plants_harvested, plants, 0)
 where h.status = 'done' and h.metrc_wet_lbs = 0;

-- =====================================================================================================
-- 2. tag rules: pallet number -> METRC tag
-- =====================================================================================================
create table if not exists tag_rules (
  site    text not null,
  letter  text not null check (letter ~ '^[A-Z]{1,3}$'),
  prefix  text not null check (length(prefix) between 10 and 20),
  "offset" int not null default 0,
  digits  int not null default 9,
  license text,
  active  boolean not null default true,
  notes   text,
  updated_by text, updated_at timestamptz not null default now(),
  primary key (site, letter)
);
alter table tag_rules enable row level security;
drop policy if exists read_staff on tag_rules;
create policy read_staff on tag_rules for select to authenticated using (is_staff());
grant select on tag_rules to authenticated;
-- OHR P53 = 1A406030007AD3D000010053; GVR G359 = 1A406030007C3E5000000359. Trials (T) are left off until the labels are checked.
insert into tag_rules (site, letter, prefix, "offset", license, notes) values
  ('OHR', 'P', '1A406030007AD3D', 10000, 'CCL25-0000017', 'P + number = tag ...0000 (10000 + number)'),
  ('GVR', 'G', '1A406030007C3E5', 0, 'CCL25-0000175', 'G + number = tag ...0000 + number')
on conflict (site, letter) do nothing;

create or replace function tag_for_code(p_site text, p_code text) returns text
language sql stable security definer set search_path = public as $$
  select r.prefix || lpad((r."offset" + substring(p_code from '[0-9]+$')::int)::text, r.digits, '0')
    from tag_rules r
   where r.site = p_site and r.active and p_code ~ ('^' || r.letter || '[0-9]+$')
$$;

-- is this tag on the available list for the site (tag_ranges, loaded from METRC)? null = no list for that prefix
create or replace function tag_available(p_tag text) returns boolean
language sql stable security definer set search_path = public as $$
  select case when not exists (select 1 from tag_ranges r where r.active and left(p_tag, length(r.prefix)) = r.prefix and length(p_tag) = length(r.prefix) + r.digits)
              then null
              else exists (select 1 from tag_ranges r where r.active and left(p_tag, length(r.prefix)) = r.prefix and length(p_tag) = length(r.prefix) + r.digits
                              and substring(p_tag from length(r.prefix) + 1) ~ '^[0-9]+$'
                              and substring(p_tag from length(r.prefix) + 1)::bigint between r.first_n and r.last_n) end
$$;

create or replace function save_tag_rule(p jsonb) returns tag_rules
language plpgsql security definer set search_path = public as $$
declare r tag_rules;
begin
  perform no_view_as();
  if not (is_mod_admin('cultivation') or is_mod_admin('distribution') or is_owner()) then raise exception 'Only a Production or Distribution Admin can change tag rules'; end if;
  if coalesce((p ->> 'delete')::boolean, false) then
    delete from tag_rules where site = p ->> 'site' and letter = upper(p ->> 'letter');
    return null;
  end if;
  insert into tag_rules (site, letter, prefix, "offset", digits, license, active, notes, updated_by, updated_at)
  values (p ->> 'site', upper(trim(p ->> 'letter')), upper(trim(p ->> 'prefix')), coalesce(nullif(p ->> 'offset', '')::int, 0),
          coalesce(nullif(p ->> 'digits', '')::int, 9), nullif(trim(p ->> 'license'), ''), coalesce((p ->> 'active')::boolean, true),
          nullif(trim(p ->> 'notes'), ''), current_email(), now())
  on conflict (site, letter) do update set prefix = excluded.prefix, "offset" = excluded."offset", digits = excluded.digits, license = excluded.license,
         active = excluded.active, notes = excluded.notes, updated_by = excluded.updated_by, updated_at = now()
  returning * into r;
  insert into events (user_email, type, note, details) values (current_email(), 'tag_rule', r.site || ' ' || r.letter, to_jsonb(r));
  return r;
end $$;

-- the next pallet for a harvest: number, tag from the rule, and whether METRC lists that tag as available
create or replace function cult_next_pallet(p_harvest bigint, p_skip int default 0) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare h cult_harvests; pre text; nxt int; c text; t text; i int := 0;
begin
  if not has_module('cultivation') then raise exception 'Not allowed'; end if;
  select * into h from cult_harvests where id = p_harvest;
  if h.id is null then raise exception 'Harvest not found'; end if;
  pre := cult_pallet_letter(h);
  select coalesce(max(substring(code from length(pre) + 1)::int), 0) + 1 into nxt from pallets where code ~ ('^' || pre || '[0-9]+$');
  nxt := nxt + greatest(coalesce(p_skip, 0), 0);
  loop
    c := pre || case when pre = 'T' then lpad(nxt::text, 3, '0') else nxt::text end;
    t := tag_for_code(h.site, c);
    exit when not exists (select 1 from pallets where code = c) and (t is null or tag_in_use(t, null) is null);
    nxt := nxt + 1; i := i + 1;
    exit when i > 500;
  end loop;
  return jsonb_build_object('code', c, 'tag', t, 'available', case when t is null then null else tag_available(t) end, 'letter', pre);
end $$;

-- =====================================================================================================
-- 3. trial strains
-- =====================================================================================================
create or replace function planting_trial_default() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and not new.trial then
    new.trial := coalesce((select s.trial from strains s where s.id = strain_id_of(new.strain)), false);
  end if;
  return new;
end $$;
drop trigger if exists cult_plantings_trial on cult_plantings;
create trigger cult_plantings_trial before insert on cult_plantings for each row execute function planting_trial_default();

-- the letter a harvest's pallets get: T for a trial planting or a trials field, else the site's prefix
create or replace function cult_pallet_letter(h cult_harvests) returns text
language sql stable security definer set search_path = public as $$
  select case when coalesce((select pl.trial from cult_plantings pl where pl.id = h.planting_id), false)
                or exists (select 1 from fields f where f.id = h.field_id and f.kind = 'trials') then 'T'
              else coalesce((select s.pallet_prefix from sites s where s.code = h.site), 'P') end
$$;

-- =====================================================================================================
-- 4. harvest log: add / fix / remove pallets and bins before they're pushed
-- =====================================================================================================
create or replace function cult_add_pallets(p_harvest bigint, p_rows jsonb) returns text[]
language plpgsql security definer set search_path = public as $$
declare h cult_harvests; f fields; r jsonb; v_code text; v_tag text; v_lbs numeric; used text;
        pre text; nxt int; p pallets; out text[] := '{}'; pd date; dest int; tr boolean;
begin
  perform require_module('cultivation');
  perform require_staff();
  perform cult_guard_done(p_harvest);
  select * into h from cult_harvests where id = p_harvest for update;
  if not found then raise exception 'Harvest not found'; end if;
  if h.kind not in ('ff') then raise exception 'Pallets are for fresh frozen harvests'; end if;
  if h.status = 'planned' and h.stage is null then h := cult_start(h.id); end if;
  select * into f from fields where id = h.field_id;
  select planted_on, trial into pd, tr from cult_plantings where id = h.planting_id;
  pre := cult_pallet_letter(h);
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_lbs := nullif(r ->> 'lbs', '')::numeric;
    v_tag := upper(nullif(trim(r ->> 'tag'), ''));
    v_code := upper(nullif(trim(r ->> 'code'), ''));
    if v_lbs is null or v_lbs <= 0 then raise exception 'Every pallet needs a weight'; end if;
    if v_code is null and v_tag ~ '[0-9]{4}$' and right(v_tag, 4)::int > 0 and tag_for_code(h.site, pre || '1') is null then   -- no rule: …10053 → P53
      v_code := pre || case when pre = 'T' then lpad(right(v_tag, 4)::int::text, 3, '0') else right(v_tag, 4)::int::text end;
      if exists (select 1 from pallets where code = v_code) then v_code := null; end if;
    end if;
    if v_code is null then
      select coalesce(max(substring(code from length(pre) + 1)::int), 0) + 1 into nxt from pallets where code ~ ('^' || pre || '[0-9]+$');
      v_code := pre || case when pre = 'T' then lpad(nxt::text, 3, '0') else nxt::text end;
    end if;
    if exists (select 1 from pallets where code = v_code) then raise exception 'Pallet % already exists', v_code; end if;
    -- the tag comes from the pallet number when the site has a rule (unless one was typed or scanned)
    if v_tag is null and not coalesce((r ->> 'pending')::boolean, false) then v_tag := tag_for_code(h.site, v_code); end if;
    if v_tag is not null then
      used := tag_in_use(v_tag, null);
      if used is not null then raise exception 'Tag % is already on pallet %', v_tag, used; end if;
    end if;
    dest := harvest_slot(h.site);
    insert into pallets (code, strain, zone, harvest_date, planting_date, og_weight, current_weight, package_tag, tag_pending,
                         status, slot_id, harvest_id, received_site, notes, boxes, partial, pushed)
    values (v_code, h.strain, coalesce(f.name, ''), coalesce(h.harvested_on, current_date), pd, v_lbs, v_lbs, v_tag, v_tag is null,
            case when dest is null then 'unslotted' else 'in_freezer' end, dest, h.id, case when h.site = 'GVR' and dest is null then 'GVR' end,
            nullif(trim(r ->> 'note'), ''), nullif(r ->> 'boxes', '')::int, coalesce((r ->> 'partial')::boolean, false),
            coalesce((r ->> 'pushed')::boolean, false) and h.status = 'done')
    returning * into p;
    insert into events (user_email, type, pallet_id, to_slot_id, lbs, note, details)
    values (current_email(), 'harvested', p.id, dest, v_lbs, null,
            jsonb_build_object('strain', h.strain, 'field', f.name, 'site', h.site, 'harvest_id', h.id, 'tag', v_tag, 'boxes', p.boxes,
                               'partial', p.partial, 'pushed', p.pushed));
    out := out || v_code;
  end loop;
  return out;
end $$;

-- fix a pallet that isn't pushed yet: {"lbs": 640, "boxes": 60, "tag": "1A4...", "pending": false, "partial": true, "note": "", "code": "P841"}
create or replace function cult_edit_pallet(p_pallet bigint, p jsonb) returns pallets
language plpgsql security definer set search_path = public as $$
declare x pallets; v_tag text; used text; v_code text; v_lbs numeric; h cult_harvests;
begin
  perform require_module('cultivation');
  select * into x from pallets where id = p_pallet for update;
  if x.id is null or x.harvest_id is null then raise exception 'Not a harvest pallet'; end if;
  perform cult_guard_done(x.harvest_id);
  if x.pushed then raise exception '% is already pushed (a package). Fix it on the freezer map: Adjust weight, Enter tag.', x.code; end if;
  select * into h from cult_harvests where id = x.harvest_id;
  v_lbs := coalesce(nullif(p ->> 'lbs', '')::numeric, x.og_weight);
  if v_lbs is null or v_lbs <= 0 then raise exception 'Enter a weight'; end if;
  v_code := coalesce(upper(nullif(trim(p ->> 'code'), '')), x.code);
  if v_code <> x.code and exists (select 1 from pallets where code = v_code) then raise exception 'Pallet % already exists', v_code; end if;
  if p ? 'tag' or p ? 'pending' then
    v_tag := case when coalesce((p ->> 'pending')::boolean, false) then null else upper(nullif(trim(p ->> 'tag'), '')) end;
  else
    v_tag := case when v_code <> x.code then coalesce(tag_for_code(h.site, v_code), x.package_tag) else x.package_tag end;
  end if;
  if v_tag is not null then
    used := tag_in_use(v_tag, x.id);
    if used is not null then raise exception 'Tag % is already on pallet %', v_tag, used; end if;
  end if;
  update pallets set code = v_code, og_weight = v_lbs, current_weight = v_lbs, package_tag = v_tag, tag_pending = v_tag is null,
         boxes = case when p ? 'boxes' then nullif(p ->> 'boxes', '')::int else boxes end,
         partial = case when p ? 'partial' then coalesce((p ->> 'partial')::boolean, false) else partial end,
         notes = case when p ? 'note' then nullif(trim(p ->> 'note'), '') else notes end, updated_at = now()
   where id = x.id returning * into x;
  insert into events (user_email, type, pallet_id, lbs, note, details)
  values (current_email(), 'harvest_fix', x.id, v_lbs, null, jsonb_build_object('harvest_id', x.harvest_id, 'changes', p, 'code', x.code, 'tag', v_tag));
  return x;
end $$;

-- take a pallet back out of the log: not pushed (any time), or pushed and untouched (as before)
create or replace function cult_remove_pallet(p_pallet bigint) returns void
language plpgsql security definer set search_path = public as $$
declare p pallets;
begin
  perform require_module('cultivation'); perform no_view_as();
  select * into p from pallets where id = p_pallet for update;
  if p.id is null or p.harvest_id is null then raise exception 'Not a harvest pallet'; end if;
  perform cult_guard_done(p.harvest_id);
  if p.pushed and exists (select 1 from events where pallet_id = p.id and type not in ('harvested','harvest_fix','move')) then
    raise exception '% is already a package and has been changed. Remove it from the freezer map instead.', p.code;
  end if;
  if p.pushed then raise exception '% is already pushed. Un-push it first (Production Admin).', p.code; end if;
  update pallets set status = 'archived', slot_id = null, span_to_slot = null, notes = concat_ws(' ', notes, '(logged by mistake)'), updated_at = now() where id = p.id;
  insert into events (user_email, type, pallet_id, lbs, details)
  values (current_email(), 'harvest_undone', p.id, p.current_weight, jsonb_build_object('harvest_id', p.harvest_id));
end $$;

-- bins: only ones not yet sent to METRC can change
create or replace function cult_edit_weight(p_id bigint, p_lbs numeric) returns cult_weights
language plpgsql security definer set search_path = public as $$
declare w cult_weights;
begin
  perform require_module('cultivation'); perform no_view_as();
  select * into w from cult_weights where id = p_id for update;
  if w.id is null then raise exception 'Not found'; end if;
  perform cult_guard_done(w.harvest_id);
  if w.pushed then raise exception 'That bin is already in METRC (pushed). Fix it with a METRC adjustment.'; end if;
  if p_lbs is null or p_lbs <= 0 then raise exception 'Enter a weight'; end if;
  update cult_weights set lbs = p_lbs where id = w.id returning * into w;
  perform cult_weights_sync(w.harvest_id);
  insert into events (user_email, type, lbs, details) values (current_email(), 'harvest_bin_fix', p_lbs, jsonb_build_object('harvest_id', w.harvest_id, 'weight_id', w.id));
  return w;
end $$;

create or replace function cult_remove_weight(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare w cult_weights;
begin
  perform require_module('cultivation'); perform no_view_as();
  select * into w from cult_weights where id = p_id;
  if w.id is null then return; end if;
  perform cult_guard_done(w.harvest_id);
  if w.pushed and not is_mod_admin('cultivation') then raise exception 'That bin is already in METRC (pushed). Only a Production Admin can remove it.'; end if;
  delete from cult_weights where id = p_id;
  update cult_harvests set raw_bins = coalesce((select array_agg(lbs order by id) from cult_weights where harvest_id = w.harvest_id and kind = 'raw'), '{}'),
         dry_lbs = (select sum(lbs) from cult_weights where harvest_id = w.harvest_id and kind in ('tote','dry')),
         metrc_wet_lbs = greatest(metrc_wet_lbs - case when w.pushed then w.lbs else 0 end, 0)
   where id = w.harvest_id;
end $$;

-- plants harvested today (the METRC "harvest plants" count); fills in from the schedule, the lead can change it
create or replace function cult_set_plants(p_harvest bigint, p_plants int) returns void
language plpgsql security definer set search_path = public as $$
declare h cult_harvests;
begin
  perform require_module('cultivation'); perform no_view_as();
  perform cult_guard_done(p_harvest);
  select * into h from cult_harvests where id = p_harvest for update;
  if p_plants is null or p_plants < 0 then raise exception 'Enter the plants harvested'; end if;
  if p_plants < h.metrc_plants then raise exception '% plants are already in METRC for this harvest', h.metrc_plants; end if;
  update cult_harvests set plants_harvested = p_plants, updated_by = current_email(), updated_at = now() where id = h.id;
end $$;

-- rename at harvest (planting mix-up): the harvest and its pallets take the new strain; the planting keeps its name
create or replace function cult_rename(p_harvest bigint, p_strain text) returns void
language plpgsql security definer set search_path = public as $$
declare h cult_harvests; s text := coalesce(canonical_strain(p_strain), nullif(trim(p_strain), ''));
begin
  perform require_module('cultivation'); perform no_view_as();
  perform cult_guard_done(p_harvest);
  select * into h from cult_harvests where id = p_harvest for update;
  if h.id is null then raise exception 'Harvest not found'; end if;
  if s is null then raise exception 'Enter the strain'; end if;
  if lower(s) = lower(h.strain) then return; end if;
  if strain_id_of(s) is null then insert into strains (name, notes) values (s, 'Added when a harvest was renamed'); end if;
  update cult_harvests set strain = s, planted_strain = coalesce(planted_strain, h.strain), lot_id = null, updated_by = current_email(), updated_at = now() where id = h.id;
  update pallets set strain = s, lot_id = null, updated_at = now() where harvest_id = h.id and status not in ('archived');
  update pallets set lot_id = harvest_lot(h.id) where harvest_id = h.id and status not in ('archived');
  insert into events (user_email, type, note, details) values (current_email(), 'harvest_renamed', s,
         jsonb_build_object('harvest_id', h.id, 'from', h.strain, 'to', s, 'pallets', (select count(*) from pallets where harvest_id = h.id and status <> 'archived')));
end $$;

-- =====================================================================================================
-- 5. push, un-push, finish, continue tomorrow
-- =====================================================================================================
create or replace function cult_batch_name(h cult_harvests) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(trim(h.metrc_name), ''),
                  (select nullif(trim(p.metrc_name), '') || '-' || h.day_no from cult_harvests p where p.id = h.parent_id),
                  (select l.metrc_name from harvest_lots l where l.id = h.lot_id),
                  h.strain || ' ' || to_char(coalesce(h.harvested_on, h.planned_on, current_date), 'MM/DD'))
$$;

-- push: send plants + wet weight to METRC (if any is new), then turn the chosen pallets into packages. p_pallets null = all not pushed.
create or replace function cult_push(p_harvest bigint, p_pallets bigint[] default null, p_allow_pending boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare h cult_harvests; new_wet numeric; new_plants int; ids bigint[]; p pallets; packed numeric; d text; n int := 0; bad text;
begin
  perform require_module('cultivation'); perform no_view_as();
  perform cult_guard_done(p_harvest);
  select * into h from cult_harvests where id = p_harvest for update;
  if h.id is null then raise exception 'Harvest not found'; end if;
  if h.kind not in ('ff') then raise exception 'Push is for fresh frozen harvests. Dry harvests go to METRC when you finish.'; end if;
  select array_agg(id order by id) into ids from pallets
   where harvest_id = h.id and not pushed and status not in ('archived') and (p_pallets is null or id = any(p_pallets));
  if ids is null then raise exception 'Nothing to push'; end if;
  -- checks
  select string_agg(code, ', ') into bad from pallets where id = any(ids) and package_tag is null;
  if bad is not null and not p_allow_pending then raise exception 'No METRC tag yet: %. Add the tags, or push them as tag pending.', bad; end if;
  select string_agg(a.code, ', ') into bad from pallets a join pallets b on b.package_tag = a.package_tag and b.id <> a.id
   where a.id = any(ids) and a.package_tag is not null and b.status in ('in_freezer','unslotted','in_transit','at_processor');
  if bad is not null then raise exception 'Tag used twice: %', bad; end if;
  if coalesce(h.plants_harvested, 0) <= 0 then raise exception 'Enter the plants harvested first (METRC harvests plants into the batch)'; end if;
  -- METRC: harvest the plants (and the bins logged since the last push) into the batch
  select coalesce(sum(lbs), 0) into new_wet from cult_weights where harvest_id = h.id and kind = 'raw' and not pushed;
  new_plants := coalesce(h.plants_harvested, 0) - h.metrc_plants;
  if new_wet > 0 or new_plants > 0 then
    d := cult_batch_name(h);
    insert into events (user_email, type, lbs, note, details)
    values (current_email(), 'harvest_plants', new_wet, d,
            jsonb_build_object('harvest_id', h.id, 'site', h.site, 'strain', h.strain, 'batch', d, 'plants', greatest(new_plants, 0), 'wet_lbs', new_wet,
                               'field', (select name from fields where id = h.field_id), 'day', h.day_no));
    update cult_weights set pushed = true where harvest_id = h.id and kind = 'raw' and not pushed;
    update cult_harvests set metrc_wet_lbs = metrc_wet_lbs + new_wet, metrc_plants = greatest(metrc_plants, coalesce(plants_harvested, 0)) where id = h.id
    returning * into h;
  end if;
  if h.metrc_wet_lbs <= 0 then raise exception 'Log the raw bins first. METRC needs the wet weight before packages can be made.'; end if;
  select coalesce(sum(og_weight), 0) into packed from pallets where harvest_id = h.id and status <> 'archived' and (pushed or id = any(ids));
  if packed > h.metrc_wet_lbs + 0.5 then
    raise exception 'The pallets (% lbs) would be more than the wet weight in METRC (% lbs). Log the missing bins, or fix a pallet weight.', round(packed, 1), round(h.metrc_wet_lbs, 1);
  end if;
  -- the packages
  for p in select * from pallets where id = any(ids) order by id loop
    update pallets set pushed = true, updated_at = now() where id = p.id;
    insert into events (user_email, type, pallet_id, lbs, details)
    values (current_email(), 'pushed', p.id, p.og_weight, jsonb_build_object('harvest_id', h.id, 'site', h.site, 'batch', cult_batch_name(h), 'tag', p.package_tag, 'strain', p.strain));
    n := n + 1;
  end loop;
  return jsonb_build_object('pushed', n, 'wet_lbs', h.metrc_wet_lbs, 'packed_lbs', packed, 'new_wet', new_wet, 'new_plants', greatest(new_plants, 0));
end $$;

-- un-push (Production Admin): only while nothing else has happened to the package and METRC hasn't been done
create or replace function cult_unpush(p_pallet bigint) returns void
language plpgsql security definer set search_path = public as $$
declare p pallets; ev bigint; a comp_metrc_actions;
begin
  perform require_module('cultivation'); perform no_view_as();
  if not is_mod_admin('cultivation') then raise exception 'Only a Production Admin can un-push'; end if;
  select * into p from pallets where id = p_pallet for update;
  if p.id is null or not p.pushed or p.harvest_id is null then raise exception 'Not a pushed harvest pallet'; end if;
  if exists (select 1 from cult_harvests where id = p.harvest_id and status = 'done') then raise exception 'The harvest is finished. Reopen it first.'; end if;
  select max(id) into ev from events where pallet_id = p.id and type = 'pushed';
  if exists (select 1 from events where pallet_id = p.id and id > coalesce(ev, 0) and type not in ('move')) then
    raise exception '% has been changed since it was pushed. Fix it on the freezer map.', p.code;
  end if;
  if exists (select 1 from order_picks where pallet_id = p.id) or pallet_open_load(p.id) is not null then raise exception '% is held for an order or on a load', p.code; end if;
  select * into a from comp_metrc_actions where event_id = ev;
  if a.status = 'done' then raise exception '% is already a package in METRC. Fix it there and on the freezer map.', p.code; end if;
  update comp_metrc_actions set status = 'skipped', note = 'Un-pushed in the Harvest log', done_by = current_email(), done_at = now() where event_id = ev and status = 'todo';
  update pallets set pushed = false, updated_at = now() where id = p.id;
  insert into events (user_email, type, pallet_id, lbs, details) values (current_email(), 'unpushed', p.id, p.og_weight, jsonb_build_object('harvest_id', p.harvest_id));
end $$;

-- finish: everything pushed, then METRC gets the waste (due in 48 hours) and the finish
create or replace function cult_finish(p_harvest bigint, p_plants int default null, p_notes text default null) returns void
language plpgsql security definer set search_path = public as $$
declare h cult_harvests; packed numeric; waste numeric; d text; new_wet numeric; bad text;
begin
  perform require_module('cultivation'); perform no_view_as();
  select * into h from cult_harvests where id = p_harvest for update;
  if h.id is null then raise exception 'Harvest not found'; end if;
  if h.status = 'done' then raise exception 'This harvest is already finished'; end if;
  if p_plants is not null then update cult_harvests set plants_harvested = p_plants where id = h.id returning * into h; end if;
  if h.kind = 'ff' then
    select string_agg(code, ', ' order by id) into bad from pallets where harvest_id = h.id and not pushed and status <> 'archived';
    if bad is not null then raise exception 'Push every pallet before you finish (not pushed: %)', bad; end if;
    select coalesce(sum(lbs), 0) into new_wet from cult_weights where harvest_id = h.id and kind = 'raw' and not pushed;
    if new_wet > 0 or coalesce(h.plants_harvested, 0) > h.metrc_plants then
      d := cult_batch_name(h);
      insert into events (user_email, type, lbs, note, details)
      values (current_email(), 'harvest_plants', new_wet, d, jsonb_build_object('harvest_id', h.id, 'site', h.site, 'strain', h.strain, 'batch', d,
              'plants', greatest(coalesce(h.plants_harvested, 0) - h.metrc_plants, 0), 'wet_lbs', new_wet, 'day', h.day_no));
      update cult_weights set pushed = true where harvest_id = h.id and kind = 'raw' and not pushed;
      update cult_harvests set metrc_wet_lbs = metrc_wet_lbs + new_wet, metrc_plants = greatest(metrc_plants, coalesce(plants_harvested, 0)) where id = h.id returning * into h;
    end if;
    select coalesce(sum(og_weight), 0) into packed from pallets where harvest_id = h.id and pushed and status <> 'archived';
    waste := greatest(round(h.metrc_wet_lbs - packed, 2), 0);
    d := cult_batch_name(h);
    if h.metrc_wet_lbs > 0 then
      insert into events (user_email, type, lbs, note, details)
      values (current_email(), 'harvest_waste', waste, d, jsonb_build_object('harvest_id', h.id, 'site', h.site, 'strain', h.strain, 'batch', d,
              'wet_lbs', h.metrc_wet_lbs, 'packed_lbs', packed, 'due', now() + interval '48 hours'));
      insert into events (user_email, type, note, details)
      values (current_email(), 'harvest_finish', d, jsonb_build_object('harvest_id', h.id, 'site', h.site, 'strain', h.strain, 'batch', d, 'due', now() + interval '48 hours'));
    end if;
  elsif h.kind = 'dry' then
    -- dry flower: the wet weight goes into METRC; the wet package is made in Processing
    select coalesce(sum(lbs), 0) into new_wet from cult_weights where harvest_id = h.id and kind = 'raw' and not pushed;
    if new_wet > 0 then
      d := cult_batch_name(h);
      insert into events (user_email, type, lbs, note, details)
      values (current_email(), 'harvest_plants', new_wet, d, jsonb_build_object('harvest_id', h.id, 'site', h.site, 'strain', h.strain, 'batch', d,
              'plants', greatest(coalesce(h.plants_harvested, h.plants, 0) - h.metrc_plants, 0), 'wet_lbs', new_wet, 'day', h.day_no, 'dry', true));
      update cult_weights set pushed = true where harvest_id = h.id and kind = 'raw' and not pushed;
      update cult_harvests set metrc_wet_lbs = metrc_wet_lbs + new_wet, metrc_plants = coalesce(plants_harvested, plants, 0) where id = h.id returning * into h;
    end if;
  end if;
  update cult_harvests set status = 'done', stage = null, harvested_on = coalesce(harvested_on, current_date),
         plants_harvested = coalesce(plants_harvested, plants), waste_lbs = waste,
         notes = case when nullif(trim(p_notes), '') is null then notes else concat_ws(E'\n', notes, trim(p_notes)) end,
         updated_by = current_email(), updated_at = now()
   where id = h.id;
end $$;

-- didn't finish today: today's harvest is finished as its own batch, tomorrow's is added (same planting and schedule line)
create or replace function cult_continue(p_harvest bigint, p_plants int, p_on date default null, p_notes text default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare h cult_harvests; root cult_harvests; nid bigint; dn int; left_ int; base text;
begin
  perform require_module('cultivation'); perform no_view_as();
  select * into h from cult_harvests where id = p_harvest for update;
  if h.id is null then raise exception 'Harvest not found'; end if;
  if h.kind not in ('ff','dry') then raise exception 'Continue tomorrow is for flower harvests'; end if;
  perform cult_finish(h.id, p_plants, p_notes);
  select * into h from cult_harvests where id = p_harvest;
  select * into root from cult_harvests where id = coalesce(h.parent_id, h.id);
  select coalesce(max(day_no), 1) + 1 into dn from cult_harvests where id = root.id or parent_id = root.id;
  -- plants still standing in that planting
  left_ := greatest(coalesce((select pl.plants - coalesce(pl.plant_loss, 0) from cult_plantings pl where pl.id = h.planting_id), root.plants, 0)
                    - coalesce((select sum(coalesce(x.plants_harvested, 0)) from cult_harvests x where x.planting_id = h.planting_id and x.status = 'done' and x.kind = h.kind), 0), 0);
  if h.planting_id is null then left_ := greatest(coalesce(root.plants, 0) - coalesce((select sum(coalesce(x.plants_harvested, 0)) from cult_harvests x where (x.id = root.id or x.parent_id = root.id) and x.status = 'done'), 0), 0); end if;
  base := coalesce(nullif(trim(root.metrc_name), ''), (select l.metrc_name from harvest_lots l where l.id = root.lot_id));
  insert into cult_harvests (crop_year, site, field_id, strain, planting_id, kind, status, planned_on, plants, est_lbs_per_plant, est_raw_per_plant,
                             deleaf_rate, buck_rate, dry_conversion, acres, est_yield_per_acre, metrc_name, parent_id, day_no, notes, created_by, planted_strain)
  values (h.crop_year, h.site, h.field_id, h.strain, h.planting_id, h.kind, 'planned', coalesce(p_on, current_date + 1), nullif(left_, 0),
          h.est_lbs_per_plant, h.est_raw_per_plant, h.deleaf_rate, h.buck_rate, h.dry_conversion, null, h.est_yield_per_acre,
          case when base is not null then base || '-' || dn end, root.id, dn, 'Day ' || dn || ' of ' || h.strain, current_email(), h.planted_strain)
  returning id into nid;
  if root.id = h.id and base is not null and h.metrc_name is null then null; end if;
  insert into events (user_email, type, note, details) values (current_email(), 'harvest_continued', h.strain,
         jsonb_build_object('harvest_id', h.id, 'next_id', nid, 'day', dn, 'plants_left', left_));
  return nid;
end $$;

-- reopen keeps working as before (Production Admin), and pallets stay as they are
-- =====================================================================================================
-- 6. not pushed = not a package: no orders, loads, runs, splits, menu
-- =====================================================================================================
create or replace function _assert_pushed(p_pallet bigint, p_what text) returns void
language plpgsql stable security definer set search_path = public as $$
declare c text;
begin
  select code into c from pallets where id = p_pallet and not pushed;
  if c is not null then raise exception '% isn''t pushed yet (still in the Harvest log), so it can''t go on %.', c, p_what; end if;
end $$;
create or replace function pushed_guard_pick() returns trigger language plpgsql security definer set search_path = public as $$
begin perform _assert_pushed(new.pallet_id, 'an order'); return new; end $$;
drop trigger if exists pushed_guard on order_picks;
create trigger pushed_guard before insert or update of pallet_id on order_picks for each row execute function pushed_guard_pick();
create or replace function pushed_guard_load() returns trigger language plpgsql security definer set search_path = public as $$
begin if new.pallet_id is not null then perform _assert_pushed(new.pallet_id, 'a load'); end if; return new; end $$;
drop trigger if exists pushed_guard on load_items;
create trigger pushed_guard before insert or update of pallet_id on load_items for each row execute function pushed_guard_load();
create or replace function pushed_guard_run() returns trigger language plpgsql security definer set search_path = public as $$
begin perform _assert_pushed(new.pallet_id, 'a processing run'); return new; end $$;
drop trigger if exists pushed_guard on proc_run_inputs;
create trigger pushed_guard before insert or update of pallet_id on proc_run_inputs for each row execute function pushed_guard_run();
create or replace function pushed_guard_pallet() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.parent_id is not null and exists (select 1 from pallets where id = new.parent_id and not pushed) then
      raise exception 'That pallet isn''t pushed yet. Fix it in the Harvest log instead of splitting it.';
    end if;
    return new;
  end if;
  if not old.pushed and not new.pushed then
    if new.status in ('shipped','depleted','merged','in_transit','at_processor') and new.status is distinct from old.status then
      raise exception '% isn''t pushed yet (still in the Harvest log)', old.code;
    end if;
    if new.merged_into is not null and old.merged_into is null then raise exception '% isn''t pushed yet', old.code; end if;
    if new.container_id is not null and old.container_id is null then raise exception '% isn''t pushed yet, so it can''t go on a mixed pallet', old.code; end if;
  end if;
  return new;
end $$;
drop trigger if exists pushed_guard on pallets;
create trigger pushed_guard before insert or update on pallets for each row execute function pushed_guard_pallet();

-- the menu counts packages only
do $$
declare d text;
begin
  select pg_get_functiondef('_menu_numbers()'::regprocedure) into d;
  if d not like '%p.pushed%' then
    if position('p.status in (''in_freezer'',''unslotted'') and p.strain is not null' in d) = 0 then raise exception '_menu_numbers: patch point not found'; end if;
    execute replace(d, 'p.status in (''in_freezer'',''unslotted'') and p.strain is not null', 'p.status in (''in_freezer'',''unslotted'') and p.pushed and p.strain is not null');
  end if;
  select pg_get_functiondef('_proc_free(pallets,text)'::regprocedure) into d;
  if d not like '%pushed%' then
    execute replace(d, '  if p.container_id is not null then', '  if not p.pushed then raise exception ''% isn''''t pushed yet (still in the Harvest log)'', p.code; end if;
  if p.container_id is not null then');
  end if;
end $$;

-- weight changes on the map to a pallet that isn't pushed just change the log (no METRC step)
-- =====================================================================================================
-- 7. METRC to-do: new steps, OHR <-> GVR moves, tag column fix
-- =====================================================================================================
create or replace function _comp_queue_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare a text; lic text; p pallets; s text; fs text; ts text; due timestamptz;
begin
  if new.pallet_id is not null then select * into p from pallets where id = new.pallet_id; end if;
  if new.type = 'move' and p.id is not null then
    select f.site into fs from slots x join freezers f on f.id = x.freezer_id where x.id = new.from_slot_id;
    select f.site into ts from slots x join freezers f on f.id = x.freezer_id where x.id = new.to_slot_id;
  end if;
  a := case new.type
    when 'harvested' then case when coalesce((new.details ->> 'pushed')::boolean, true) and coalesce(p.pushed, true) then 'Create package from harvest' end
    when 'pushed' then 'Create package from harvest'
    when 'harvest_plants' then case when coalesce((new.details ->> 'dry')::boolean, false) then 'Harvest plants (dry, wet weight)' else 'Harvest plants into batch (wet weight)' end
    when 'harvest_waste' then 'Record harvest waste'
    when 'harvest_finish' then 'Finish harvest'
    when 'proc_wet' then 'Create wet package from harvest'
    when 'created' then 'New package entered by hand'
    when 'split_from' then 'New package (split)'
    when 'merge' then 'Combine packages'
    when 'weight_adjust' then case when coalesce(p.pushed, true) then 'Adjust package weight' end
    when 'tag_set' then case when not coalesce(p.pushed, true) then null when new.details ->> 'from' is null then 'Tag a pending package' else 'Change package tag' end
    when 'proc_output' then 'Create package from processing run'
    when 'proc_used' then 'Use package in processing run'
    when 'proc_run_done' then 'Record run waste / moisture loss'
    when 'proc_sent' then 'Transfer to drying processor (manifest)'
    when 'proc_received' then 'Receive back from drying processor'
    when 'shipped' then 'Ship to customer (transfer manifest)'
    when 'received' then 'Transfer between licenses'
    when 'move' then case when fs is not null and ts is not null and fs <> ts and coalesce(p.pushed, true) then 'Transfer manifest needed (' || fs || ' > ' || ts || ')' end
    else null end;
  if a is null then return new; end if;
  lic := case
    when new.type in ('harvested', 'proc_wet', 'pushed', 'harvest_plants', 'harvest_waste', 'harvest_finish') then coalesce(comp_site_cult_license(new.details ->> 'site'), comp_pallet_license(new.pallet_id))
    when new.type = 'move' then comp_site_cult_license(fs)
    when new.pallet_id is not null then comp_pallet_license(new.pallet_id)
    else null end;
  due := nullif(new.details ->> 'due', '')::timestamptz;
  s := concat_ws(' · ', p.code, coalesce(p.strain, new.details ->> 'strain'), new.details ->> 'batch', coalesce(new.details ->> 'run', null), coalesce(new.details ->> 'processor', null), coalesce(new.details ->> 'load', null),
                 case when new.type = 'merge' then 'from ' || (select string_agg(v, ', ') from jsonb_array_elements_text(coalesce(new.details -> 'sources', '[]')) v) end,
                 case when new.type = 'proc_run_done' then concat_ws(' ', new.details ->> 'kind', new.details ->> 'strain') end,
                 case when new.type = 'harvest_plants' then (new.details ->> 'plants') || ' plants, ' || (new.details ->> 'wet_lbs') || ' lbs wet' end,
                 case when new.type = 'harvest_waste' then 'wet ' || (new.details ->> 'wet_lbs') || ' - packaged ' || (new.details ->> 'packed_lbs') end);
  insert into comp_metrc_actions (event_id, at, license, action, pallet_id, code, tag, lbs, summary, details, due_at, harvest_id)
  values (new.id, new.at, lic, a, new.pallet_id, p.code,
          case when new.type = 'weight_adjust' then p.package_tag else coalesce(new.details ->> 'tag', case when new.type = 'tag_set' then new.details ->> 'to' end, p.package_tag) end,
          new.lbs, nullif(s, ''),
          jsonb_strip_nulls(new.details || jsonb_build_object('type', new.type, 'by', new.user_email, 'note', new.note)),
          due, nullif(new.details ->> 'harvest_id', '')::bigint)
  on conflict (event_id) do nothing;
  return new;
exception when others then return new;   -- never block the real action
end $$;
-- fix the tag column on weight adjustments already queued
update comp_metrc_actions a set tag = p.package_tag from pallets p where p.id = a.pallet_id and a.action = 'Adjust package weight' and a.tag ~ '^[0-9.]+$';

-- a harvest is "waiting on METRC" until its waste and finish steps are checked off
create or replace function cult_metrc_status() returns table (harvest_id bigint, open_steps int, next_due timestamptz)
language sql stable security definer set search_path = public as $$
  select a.harvest_id, count(*)::int, min(a.due_at) from comp_metrc_actions a
   where a.harvest_id is not null and a.status = 'todo' and has_module('cultivation')
   group by a.harvest_id
$$;

-- =====================================================================================================
-- 8. processing: sort runs and machine trim runs
-- =====================================================================================================
alter table pallets drop constraint if exists pallets_product_check;
alter table pallets add constraint pallets_product_check check (product in ('fresh_frozen','wet','unbucked','bucked','bucked_standards','standards','smalls','trim'));
alter table proc_runs drop constraint if exists proc_runs_kind_check;
alter table proc_runs add constraint proc_runs_kind_check check (kind in ('buck','sort','trim','machine'));
insert into finishes (code, name, pallet_product, metrc_label, uom, sort) values ('BS', 'Bucked Standards', 'bucked_standards', 'Bucked Standards', 'lb', 4)
on conflict (code) do nothing;
create or replace function product_label(p text) returns text language sql immutable as $$
  select case p when 'fresh_frozen' then 'Fresh Frozen' when 'wet' then 'Wet (raw)' when 'unbucked' then 'Unbucked' when 'bucked' then 'Bucked'
                when 'bucked_standards' then 'Bucked Standards' when 'standards' then 'Standards' when 'smalls' then 'Smalls' when 'trim' then 'Trim'
                else initcap(coalesce(p, '')) end
$$;
do $$
declare d text;
begin
  -- inputs: sort takes bucked; machine takes smalls / bucked / bucked standards; hand trim also takes smalls, bucked standards, machine trimmed standards
  select pg_get_functiondef('_proc_set_inputs(proc_runs,jsonb)'::regprocedure) into d;
  if d not like '%r.kind = ''sort''%' then
    if position('if r.kind = ''trim'' and p.product <> ''bucked'' then raise exception ''% is %. Trimming takes bucked packages.'', p.code, product_label(p.product); end if;' in d) = 0 then
      raise exception '_proc_set_inputs: patch point not found'; end if;
    d := replace(d, 'if r.kind = ''trim'' and p.product <> ''bucked'' then raise exception ''% is %. Trimming takes bucked packages.'', p.code, product_label(p.product); end if;',
      'if r.kind = ''trim'' and not (p.product in (''bucked'',''bucked_standards'',''smalls'') or (p.product = ''standards'' and p.machine_trimmed)) then raise exception ''% is %. Trimming takes bucked, bucked standards, smalls or machine trimmed standards.'', p.code, product_label(p.product); end if;
    if r.kind = ''sort'' and p.product <> ''bucked'' then raise exception ''% is %. Sorting takes bucked flower.'', p.code, product_label(p.product); end if;
    if r.kind = ''machine'' and p.product not in (''bucked'',''bucked_standards'',''smalls'') then raise exception ''% is %. The trim machine takes bucked, bucked standards or smalls.'', p.code, product_label(p.product); end if;');
    execute d;
  end if;
  select pg_get_functiondef('proc_start_run(text,jsonb,bigint,text,text,date)'::regprocedure) into d;
  if d not like '%''sort''%' then
    d := replace(d, 'if p_kind not in (''buck'',''trim'') then raise exception ''Bucking or trimming?''; end if;', 'if p_kind not in (''buck'',''sort'',''trim'',''machine'') then raise exception ''Bucking, sorting, trimming or machine trimming?''; end if;');
    d := replace(d, 'c := case p_kind when ''buck'' then ''B'' else ''T'' end', 'c := case p_kind when ''buck'' then ''B'' when ''sort'' then ''S'' when ''machine'' then ''M'' else ''T'' end');
    if d not like '%''sort''%' then raise exception 'proc_start_run: patch point not found'; end if;
    execute d;
  end if;
  select pg_get_functiondef('proc_finish_run(bigint,jsonb,numeric,text,date)'::regprocedure) into d;
  if d not like '%r.kind = ''sort''%' then
    if position('if r.kind = ''trim'' and prod not in (''standards'',''smalls'',''trim'') then raise exception ''Trimming makes standards, smalls and trim''; end if;' in d) = 0 then
      raise exception 'proc_finish_run: patch point not found'; end if;
    d := replace(d, 'if r.kind = ''trim'' and prod not in (''standards'',''smalls'',''trim'') then raise exception ''Trimming makes standards, smalls and trim''; end if;',
      'if r.kind = ''trim'' and prod not in (''standards'',''smalls'',''trim'') then raise exception ''Trimming makes standards, smalls and trim''; end if;
    if r.kind = ''sort'' and prod not in (''bucked_standards'',''smalls'') then raise exception ''Sorting makes bucked standards and smalls''; end if;
    if r.kind = ''machine'' and prod not in (''standards'',''trim'') then raise exception ''The trim machine makes standards and trim''; end if;');
    -- machine outputs are flagged inside the app only
    d := replace(d, 'perform _proc_event(''proc_output'', p.id, v,', 'if r.kind = ''machine'' then update pallets set machine_trimmed = true where id = p.id; end if;
    perform _proc_event(''proc_output'', p.id, v,');
    execute d;
  end if;
end $$;

-- =====================================================================================================
-- 9. trailers: a package can take several spots (unbucked comes in odd packaging)
-- =====================================================================================================
create or replace function set_pallet_span(p_pallet bigint, p_to_slot int) returns void
language plpgsql security definer set search_path = public as $$
declare p pallets; a slots; b slots; f freezers; busy text;
begin
  perform require_staff();
  select * into p from pallets where id = p_pallet for update;
  if p.id is null or p.slot_id is null then raise exception 'Put it in a spot first'; end if;
  if p_to_slot is null or p_to_slot = p.slot_id then
    update pallets set span_to_slot = null, updated_at = now() where id = p.id;
    return;
  end if;
  select * into a from slots where id = p.slot_id;
  select * into b from slots where id = p_to_slot;
  select * into f from freezers where id = a.freezer_id;
  if b.id is null or b.freezer_id <> a.freezer_id then raise exception 'Stretch it across spots in the same trailer'; end if;
  if f.kind <> 'trailer' then raise exception 'Only trailer spots can be shared'; end if;
  if b.col <> a.col then raise exception 'Stretch it along one side of the trailer'; end if;
  select string_agg(distinct x.code, ', ') into busy from slots x join pallets q on q.slot_id = x.id and q.id <> p.id and q.container_id is null and q.status = 'in_freezer'
   where x.freezer_id = a.freezer_id and x.col = a.col and x.row between least(a.row, b.row) and greatest(a.row, b.row);
  if busy is not null then raise exception 'Spot % already has something in it', busy; end if;
  select string_agg(distinct q.code, ', ') into busy from pallets q join slots y on y.id = q.slot_id join slots z on z.id = q.span_to_slot
   where q.id <> p.id and q.status = 'in_freezer' and y.freezer_id = a.freezer_id and y.col = a.col
     and least(y.row, z.row) <= greatest(a.row, b.row) and greatest(y.row, z.row) >= least(a.row, b.row);
  if busy is not null then raise exception '% already takes those spots', busy; end if;
  update pallets set span_to_slot = b.id, updated_at = now() where id = p.id;
  insert into events (user_email, type, pallet_id, to_slot_id, details) values (current_email(), 'span', p.id, b.id, jsonb_build_object('from', a.code, 'to', b.code));
end $$;
-- a span ends when the pallet moves
create or replace function pallet_span_clear() returns trigger language plpgsql as $$
begin
  if new.slot_id is distinct from old.slot_id then new.span_to_slot := null; end if;
  return new;
end $$;
drop trigger if exists pallet_span_clear on pallets;
create trigger pallet_span_clear before update of slot_id on pallets for each row execute function pallet_span_clear();

-- =====================================================================================================
-- 10. orders: shipped date can be the real date
-- =====================================================================================================
drop function if exists set_order_status(int, text, text, text);
create or replace function set_order_status(p_id int, p_status text, p_so text default null, p_note text default null, p_date date default null)
returns void
language plpgsql security definer set search_path = public as $$
declare o orders;
begin
  if not is_sales() then raise exception 'Only Sales or an Admin can change orders'; end if;
  if p_status not in ('pending','shipped','cancelled','submitted') then raise exception 'Unknown status %', p_status; end if;
  select * into o from orders where id = p_id for update;
  if o.id is null then raise exception 'Order not found'; end if;
  if nullif(trim(p_so), '') is not null and exists (select 1 from orders where so_number = trim(p_so) and id <> p_id) then
    raise exception 'SO % is already on another order', trim(p_so);
  end if;
  update orders set status = p_status, so_number = coalesce(nullif(trim(p_so), ''), so_number),
         confirmed_by = case when o.status = 'submitted' and p_status = 'pending' then current_email() else confirmed_by end,
         confirmed_at = case when o.status = 'submitted' and p_status = 'pending' then now() else confirmed_at end,
         shipped_date = case when p_status = 'shipped' then coalesce(p_date, shipped_date, current_date) else shipped_date end,
         updated_at = now()
   where id = p_id;
  insert into events (user_email, type, note, details)
  values (current_email(), 'order_status', p_note, jsonb_build_object('order_id', p_id, 'from', o.status, 'to', p_status, 'date', p_date,
          'so', coalesce(nullif(trim(p_so), ''), o.so_number), 'customer', (select name from customers where id = o.customer_id)));
end $$;

-- =====================================================================================================
-- 11. tags: OHR's available package tags (METRC export 10/24) and the old placeholder range off
-- =====================================================================================================
update tag_ranges set active = false where site = 'OHR' and length(prefix) <> 15;
delete from tag_ranges where license = 'CCL25-0000017' and notes like 'METRC export 2026-10-24%';
insert into tag_ranges (site, purpose, prefix, first_n, last_n, digits, active, notes, license) values
('OHR','harvest','1A406030007AD3D',10114,10115,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','harvest','1A406030007AD3D',10117,10121,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','harvest','1A406030007AD3D',10182,10183,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','harvest','1A406030007AD3D',10186,10186,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','harvest','1A406030007AD3D',10238,10238,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','harvest','1A406030007AD3D',10330,10330,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','harvest','1A406030007AD3D',10332,10336,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','harvest','1A406030007AD3D',10348,10352,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','harvest','1A406030007AD3D',10404,10404,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','harvest','1A406030007AD3D',10422,10453,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','harvest','1A406030007AD3D',10456,10486,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','harvest','1A406030007AD3D',10488,10505,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','harvest','1A406030007AD3D',10507,10518,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','harvest','1A406030007AD3D',10520,10528,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','harvest','1A406030007AD3D',10534,10566,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','harvest','1A406030007AD3D',10568,10657,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','harvest','1A406030007AD3D',10659,10679,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','harvest','1A406030007AD3D',10695,10696,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','harvest','1A406030007AD3D',10698,11000,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',176,176,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',250,250,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',291,291,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',403,404,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',422,422,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',424,424,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',427,427,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',446,455,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',457,486,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',488,799,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',804,1000,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',1005,1315,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',1317,1403,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',1405,2000,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',2321,2321,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',2464,2464,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',2516,2516,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',2530,2530,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',2532,2532,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',2536,2536,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',2540,2540,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',2545,2546,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',2556,2556,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',2564,2564,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',2614,3001,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',3003,3004,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',3006,3006,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',3012,3028,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',3033,3034,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',3036,3037,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',3040,3040,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',3043,3046,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',3055,3056,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',3059,3061,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',3071,3072,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',3074,3074,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',3087,3087,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',3094,3095,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',3110,3112,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',3114,3114,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',3116,3117,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',3121,3211,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',3214,3411,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',3413,3919,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',3921,4000,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',4022,4038,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',4040,4041,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',4043,4069,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',4071,4967,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',4974,4974,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',4977,5000,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',5009,8999,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017'),
('OHR','mixed','ABC06030007AD3D',9011,9996,9,true,'METRC export 2026-10-24 (package tags)','CCL25-0000017');

-- =====================================================================================================
-- 12. grants
-- =====================================================================================================
do $$
declare f text;
begin
  foreach f in array array['tag_for_code(text,text)','tag_available(text)','save_tag_rule(jsonb)','cult_next_pallet(bigint,int)','cult_pallet_letter(cult_harvests)',
    'cult_add_pallets(bigint,jsonb)','cult_edit_pallet(bigint,jsonb)','cult_remove_pallet(bigint)','cult_edit_weight(bigint,numeric)','cult_remove_weight(bigint)',
    'cult_set_plants(bigint,int)','cult_rename(bigint,text)','cult_batch_name(cult_harvests)','cult_push(bigint,bigint[],boolean)','cult_unpush(bigint)',
    'cult_finish(bigint,int,text)','cult_continue(bigint,int,date,text)','cult_metrc_status()','set_pallet_span(bigint,int)',
    'set_order_status(int,text,text,text,date)','_assert_pushed(bigint,text)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

select (select count(*) from tag_rules) as tag_rules,
       (select count(*) from tag_ranges where license = 'CCL25-0000017' and active) as ohr_tag_ranges,
       (select count(*) from pallets where not pushed) as not_pushed,
       (select count(*) from finishes where code = 'BS') as bucked_standards_item;
