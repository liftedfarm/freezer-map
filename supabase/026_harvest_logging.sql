-- Migration 026: live harvest logging (Production > Harvest) and the handoff to Distribution.
-- Run once in Supabase after 025_fulfillment.sql: SQL Editor > New query > paste > Run. Safe to re-run.
--
--  * Weights are logged one at a time as they happen (cult_weights): raw bins, biomass totes, dry weights.
--    Raw weights also keep cult_harvests.raw_bins in step, so every existing total and yield keeps working.
--  * A harvest is "harvesting" from the first thing logged until someone finishes it. Stripper header harvests
--    sit in "drying" until the dry weight is entered.
--  * Fresh frozen pallets are saved as they're made and land in that site's Staging area on the freezer map
--    (empty spots first, then stacked), so Distribution can move them into freezers while the harvest goes on.
set client_min_messages = warning;

alter table cult_harvests add column if not exists stage text;
alter table cult_harvests drop constraint if exists cult_harvests_stage_check;
alter table cult_harvests add constraint cult_harvests_stage_check check (stage in ('harvesting','drying'));
alter table cult_harvests add column if not exists dry_lbs numeric;          -- biomass dry weight (combine totes, or strip after drying)

alter table pallets add column if not exists boxes int;
alter table pallets add column if not exists partial boolean not null default false;   -- last pallet of a harvest, with a partial box

create table if not exists cult_weights (
  id          bigserial primary key,
  harvest_id  bigint not null references cult_harvests(id) on delete cascade,
  kind        text not null check (kind in ('raw','tote','dry')),
  lbs         numeric not null check (lbs > 0),
  tag         text,
  note        text,
  created_by  text default current_email(),
  created_at  timestamptz not null default now()
);
create index if not exists cult_weights_harvest_idx on cult_weights (harvest_id);
alter table cult_weights enable row level security;
drop policy if exists cult_read on cult_weights;
create policy cult_read on cult_weights for select to authenticated using (has_module('cultivation'));
grant select on cult_weights to authenticated;

-- raw_bins and dry_lbs follow the logged weights
create or replace function cult_weights_sync(p_harvest bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  update cult_harvests h set
    raw_bins = coalesce((select array_agg(w.lbs order by w.id) from cult_weights w where w.harvest_id = h.id and w.kind = 'raw'), h.raw_bins),
    dry_lbs = coalesce((select sum(w.lbs) from cult_weights w where w.harvest_id = h.id and w.kind in ('tote','dry')), h.dry_lbs)
   where h.id = p_harvest;
end $$;

-- where a new harvest pallet goes: the site's Staging area, an empty spot first, then the least stacked one
create or replace function harvest_slot(p_site text) returns int
language sql stable security definer set search_path = public as $$
  select s.id from slots s join freezers f on f.id = s.freezer_id
   where f.site = p_site and f.kind = 'staging'
   order by (select count(*) from pallets p where p.slot_id = s.id and p.container_id is null), s.row, s.id
   limit 1
$$;

create or replace function cult_start(p_harvest bigint) returns cult_harvests
language plpgsql security definer set search_path = public as $$
declare h cult_harvests;
begin
  perform require_module('cultivation');
  select * into h from cult_harvests where id = p_harvest for update;
  if h.id is null then raise exception 'Harvest not found'; end if;
  if h.status = 'cancelled' then raise exception 'That harvest is cancelled'; end if;
  if h.status = 'planned' and h.stage is null then
    update cult_harvests set stage = 'harvesting', harvested_on = coalesce(harvested_on, least(coalesce(planned_on, current_date), current_date)), updated_by = current_email(), updated_at = now()
     where id = h.id returning * into h;
  end if;
  return h;
end $$;

create or replace function cult_log_weight(p_harvest bigint, p_kind text, p_lbs numeric, p_tag text default null, p_note text default null) returns cult_weights
language plpgsql security definer set search_path = public as $$
declare h cult_harvests; w cult_weights; v_tag text := upper(nullif(trim(p_tag), ''));
begin
  perform no_view_as();
  h := cult_start(p_harvest);
  if p_kind = 'raw' and h.kind in ('combine','strip') then raise exception 'Biomass is logged as totes or dry weight'; end if;
  if p_kind = 'tote' and h.kind <> 'combine' then raise exception 'Totes are for combine harvests'; end if;
  if p_kind = 'dry' and h.kind <> 'strip' then raise exception 'Dry weight after drying is for stripper header harvests'; end if;
  if v_tag is not null and exists (select 1 from cult_weights where tag = v_tag) then raise exception 'Tag % is already used', v_tag; end if;
  insert into cult_weights (harvest_id, kind, lbs, tag, note) values (h.id, p_kind, p_lbs, v_tag, nullif(trim(p_note), '')) returning * into w;
  perform cult_weights_sync(h.id);
  return w;
end $$;

create or replace function cult_remove_weight(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare w cult_weights;
begin
  perform require_module('cultivation');
  delete from cult_weights where id = p_id returning * into w;
  if w.id is not null then
    -- removing the last raw weight leaves raw_bins empty rather than the old value
    update cult_harvests set raw_bins = coalesce((select array_agg(lbs order by id) from cult_weights where harvest_id = w.harvest_id and kind = 'raw'), '{}'),
           dry_lbs = (select sum(lbs) from cult_weights where harvest_id = w.harvest_id and kind in ('tote','dry'))
     where id = w.harvest_id;
  end if;
end $$;

-- stripper header: the cut is logged, then it dries; the dry weight comes later
create or replace function cult_start_drying(p_harvest bigint, p_date date default null, p_acres numeric default null) returns void
language plpgsql security definer set search_path = public as $$
declare h cult_harvests;
begin
  perform require_module('cultivation'); perform no_view_as();
  select * into h from cult_harvests where id = p_harvest for update;
  if h.kind <> 'strip' then raise exception 'Only stripper header harvests go to drying'; end if;
  update cult_harvests set stage = 'drying', harvested_on = coalesce(p_date, harvested_on, current_date), acres = coalesce(p_acres, acres),
         updated_by = current_email(), updated_at = now() where id = h.id;
end $$;

create or replace function cult_finish(p_harvest bigint, p_plants int default null, p_notes text default null) returns void
language plpgsql security definer set search_path = public as $$
declare h cult_harvests; last_p bigint;
begin
  perform require_module('cultivation'); perform no_view_as();
  select * into h from cult_harvests where id = p_harvest for update;
  if h.id is null then raise exception 'Harvest not found'; end if;
  update cult_harvests set status = 'done', stage = null, harvested_on = coalesce(harvested_on, current_date),
         plants_harvested = coalesce(p_plants, plants_harvested, plants),
         notes = case when nullif(trim(p_notes), '') is null then notes else concat_ws(E'\n', notes, trim(p_notes)) end,
         updated_by = current_email(), updated_at = now()
   where id = h.id;
end $$;

-- fresh frozen pallets: saved one at a time, into Staging
create or replace function cult_add_pallets(p_harvest bigint, p_rows jsonb) returns text[]
language plpgsql security definer set search_path = public as $$
declare h cult_harvests; f fields; s sites; r jsonb; v_code text; v_tag text; v_lbs numeric; used text;
        pre text; nxt int; p pallets; out text[] := '{}'; pd date; dest int;
begin
  perform require_module('cultivation');
  perform require_staff();
  select * into h from cult_harvests where id = p_harvest for update;
  if not found then raise exception 'Harvest not found'; end if;
  if h.kind not in ('ff') then raise exception 'Pallets are for fresh frozen harvests'; end if;
  if h.status = 'planned' and h.stage is null then h := cult_start(h.id); end if;
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
    dest := harvest_slot(h.site);
    insert into pallets (code, strain, zone, harvest_date, planting_date, og_weight, current_weight, package_tag, tag_pending,
                         status, slot_id, harvest_id, received_site, notes, boxes, partial)
    values (v_code, h.strain, coalesce(f.name, ''), coalesce(h.harvested_on, current_date), pd, v_lbs, v_lbs, v_tag, v_tag is null,
            case when dest is null then 'unslotted' else 'in_freezer' end, dest, h.id, case when h.site = 'GVR' and dest is null then 'GVR' end,
            nullif(trim(r ->> 'note'), ''), nullif(r ->> 'boxes', '')::int, coalesce((r ->> 'partial')::boolean, false))
    returning * into p;
    insert into events (user_email, type, pallet_id, to_slot_id, lbs, note, details)
    values (current_email(), 'harvested', p.id, dest, v_lbs, null,
            jsonb_build_object('strain', h.strain, 'field', f.name, 'site', h.site, 'harvest_id', h.id, 'tag', v_tag, 'boxes', p.boxes, 'partial', p.partial));
    out := out || v_code;
  end loop;
  return out;
end $$;

-- a pallet logged by mistake (still in Staging, nothing else done to it): take it back out
create or replace function cult_remove_pallet(p_pallet bigint) returns void
language plpgsql security definer set search_path = public as $$
declare p pallets;
begin
  perform require_module('cultivation'); perform no_view_as();
  select * into p from pallets where id = p_pallet for update;
  if p.id is null or p.harvest_id is null then raise exception 'Not a harvest pallet'; end if;
  if exists (select 1 from events where pallet_id = p.id and type <> 'harvested') then
    raise exception '% has already been moved or changed. Remove it from the freezer map instead.', p.code;
  end if;
  update pallets set status = 'archived', slot_id = null, notes = concat_ws(' ', notes, '(logged by mistake)'), updated_at = now() where id = p.id;
  insert into events (user_email, type, pallet_id, lbs, details)
  values (current_email(), 'harvest_undone', p.id, p.current_weight, jsonb_build_object('harvest_id', p.harvest_id));
end $$;

revoke execute on function cult_weights_sync(bigint), harvest_slot(text), cult_start(bigint), cult_log_weight(bigint, text, numeric, text, text),
  cult_remove_weight(bigint), cult_start_drying(bigint, date, numeric), cult_finish(bigint, int, text), cult_remove_pallet(bigint) from public, anon;
grant execute on function cult_start(bigint), cult_log_weight(bigint, text, numeric, text, text), cult_remove_weight(bigint),
  cult_start_drying(bigint, date, numeric), cult_finish(bigint, int, text), cult_remove_pallet(bigint) to authenticated;

select 'ok' as harvest_logging;
