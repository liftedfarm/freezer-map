-- 137: Staging that grows (Aziz 10/30, staging-and-review-plan.md).
--   * Staging keeps its numbered spots and adds new ones as it fills: always at least 2 open spots at the end.
--   * Anything that ends up with no spot (received off a load, a split or merge with no spot picked, back from a
--     processor, restored) lands in its site's Staging at commit, in the next open spot, tagged with where it came from.
--     Pallets with no known site, and packages sitting on a mixed pallet, stay as they are.
--   * pallets.staged_reason: received / harvest / processor / split. Null = put there by hand (building an order).
--     pallets.staged_at: when it went into Staging (Review "Staging aging" uses it, 2 days).
--   * The 20 GVR pallets waiting for a spot go into GVR Staging now.
--   Safe to re-run.
begin;

-- staging rows can go past 30 now (freezers are still 1..9 by their layout)
alter table slots drop constraint if exists slots_row_check;
alter table slots add constraint slots_row_check check (row >= 1);

alter table pallets add column if not exists staged_reason text;
alter table pallets add column if not exists staged_at timestamptz;
alter table pallets drop constraint if exists pallets_staged_reason_check;
alter table pallets add constraint pallets_staged_reason_check check (staged_reason in ('received', 'harvest', 'processor', 'split'));

-- ---------- grow: at least 2 open spots in a staging area ----------
create or replace function staging_grow(p_freezer int) returns int
language plpgsql security definer set search_path = public as $$
declare open_ int; n int; added int := 0;
begin
  if not exists (select 1 from freezers where id = p_freezer and kind = 'staging') then return 0; end if;
  perform pg_advisory_xact_lock(913700 + p_freezer);
  select count(*) into open_ from slots s where s.freezer_id = p_freezer and not exists (select 1 from pallets p where p.slot_id = s.id);
  while open_ < 2 loop
    select coalesce(max(row), 0) + 1 into n from slots where freezer_id = p_freezer;
    insert into slots (freezer_id, code, col, row, front_rank) values (p_freezer, 'S' || n, 1, n, n);
    open_ := open_ + 1; added := added + 1;
  end loop;
  return added;
end $$;

-- next open staging spot at a site (grows first, so there always is one)
create or replace function staging_next_slot(p_site text) returns int
language plpgsql security definer set search_path = public as $$
declare fz int; sid int;
begin
  select id into fz from freezers where site = p_site and kind = 'staging' and active is not false order by id limit 1;
  if fz is null then return null; end if;
  perform staging_grow(fz);
  select s.id into sid from slots s where s.freezer_id = fz and not exists (select 1 from pallets p where p.slot_id = s.id)
   order by s.row, s.id limit 1;
  return sid;
end $$;

-- harvest pallets: next open staging spot instead of stacking when it's full
create or replace function harvest_slot(p_site text) returns int
language plpgsql volatile security definer set search_path = public as $$
begin
  return staging_next_slot(p_site);
end $$;

revoke all on function staging_grow(int), staging_next_slot(text), harvest_slot(text) from public, anon, authenticated;

-- ---------- staged_at / staged_reason follow the spot ----------
create or replace function pallet_staged_mark() returns trigger
language plpgsql set search_path = public as $$
declare to_stage boolean; from_stage boolean := false;
begin
  to_stage := new.slot_id is not null and exists (select 1 from slots s join freezers f on f.id = s.freezer_id where s.id = new.slot_id and f.kind = 'staging');
  if tg_op = 'UPDATE' and new.slot_id is not distinct from old.slot_id then return new; end if;
  if not to_stage then new.staged_reason := null; new.staged_at := null; return new; end if;
  if tg_op = 'UPDATE' and old.slot_id is not null then
    from_stage := exists (select 1 from slots s join freezers f on f.id = s.freezer_id where s.id = old.slot_id and f.kind = 'staging');
  end if;
  if not from_stage then new.staged_at := now(); end if;
  -- whoever placed it said why; otherwise: from no spot = it just landed, from a freezer = moved here by hand
  if tg_op = 'INSERT' or new.staged_reason is not distinct from old.staged_reason then
    if tg_op = 'INSERT' or old.slot_id is null then
      new.staged_reason := case when new.harvest_id is not null and new.returned_at is null then 'harvest'
                                when new.returned_at is not null or new.processor_id is not null then 'processor'
                                else coalesce(new.staged_reason, 'received') end;
    elsif not from_stage then
      new.staged_reason := null;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists pallet_staged_mark on pallets;
create trigger pallet_staged_mark before insert or update of slot_id, staged_reason on pallets
  for each row execute function pallet_staged_mark();

-- keep 2 open spots whenever something goes into staging
create or replace function pallet_staging_grow() returns trigger
language plpgsql security definer set search_path = public as $$
declare fz int;
begin
  select s.freezer_id into fz from slots s join freezers f on f.id = s.freezer_id where s.id = new.slot_id and f.kind = 'staging';
  if fz is not null then perform staging_grow(fz); end if;
  return null;
end $$;
drop trigger if exists pallet_staging_grow on pallets;
create trigger pallet_staging_grow after insert or update of slot_id on pallets
  for each row when (new.slot_id is not null) execute function pallet_staging_grow();

-- ---------- no spot = Staging (checked at commit, after the action that made it is done) ----------
create or replace function pallet_land_in_staging() returns trigger
language plpgsql security definer set search_path = public as $$
declare p pallets; site_ text; sid int; why text;
begin
  select * into p from pallets where id = new.id for update;
  if p.id is null or p.status <> 'unslotted' or p.slot_id is not null or p.container_id is not null then return null; end if;
  site_ := p.received_site;
  if site_ is null then return null; end if;            -- no site known: stays in Review
  sid := staging_next_slot(site_);
  if sid is null then return null; end if;
  why := case when p.returned_at is not null or p.processor_id is not null or coalesce(p.their_tag, false) then 'processor'
              when p.parent_id is not null and p.created_at > now() - interval '1 day' then 'split'
              when p.harvest_id is not null and p.created_at > now() - interval '1 day' then 'harvest'
              else 'received' end;
  update pallets set status = 'in_freezer', slot_id = sid, staged_reason = why, updated_at = now() where id = p.id;
  insert into events (user_email, type, pallet_id, to_slot_id, lbs, note, details)
  values (current_email(), 'staged', p.id, sid, p.current_weight, 'Into Staging (no spot yet)',
          jsonb_build_object('site', site_, 'why', why));
  return null;
end $$;
drop trigger if exists pallet_land_in_staging on pallets;
create constraint trigger pallet_land_in_staging after insert or update on pallets
  deferrable initially deferred
  for each row when (new.status = 'unslotted' and new.slot_id is null and new.container_id is null)
  execute function pallet_land_in_staging();

-- ---------- one time ----------
-- what's already in staging: when it got there (last move into its spot), and harvest ones keep their tag
update pallets p set staged_at = coalesce((select max(e.at) from events e where e.pallet_id = p.id and e.to_slot_id = p.slot_id), p.updated_at)
 where p.staged_at is null and p.slot_id in (select s.id from slots s join freezers f on f.id = s.freezer_id where f.kind = 'staging');
update pallets p set staged_reason = 'harvest'
 where p.staged_reason is null and p.harvest_id is not null and p.returned_at is null
   and p.slot_id in (select s.id from slots s join freezers f on f.id = s.freezer_id where f.kind = 'staging')
   and not exists (select 1 from events e where e.pallet_id = p.id and e.type = 'move');

-- the ones waiting for a spot now (constraint trigger only fires on change, so place them here)
do $$
declare r record; sid int;
begin
  for r in select id, received_site, current_weight, parent_id, harvest_id, returned_at, processor_id, their_tag from pallets
            where status = 'unslotted' and slot_id is null and container_id is null and received_site is not null order by received_site, id loop
    sid := staging_next_slot(r.received_site);
    if sid is null then continue; end if;
    update pallets set status = 'in_freezer', slot_id = sid, updated_at = now(),
           staged_reason = case when r.returned_at is not null or r.processor_id is not null or coalesce(r.their_tag, false) then 'processor' else 'received' end
     where id = r.id;
    insert into events (user_email, type, pallet_id, to_slot_id, lbs, note, details)
    values ('aziz@lifted-organics.com', 'staged', r.id, sid, r.current_weight, 'Into Staging (was waiting for a spot)',
            jsonb_build_object('site', r.received_site, 'one_time', true));
  end loop;
end $$;
select staging_grow(id) from freezers where kind = 'staging';

-- check
select f.site, count(s.id) spots, count(p.id) filled, count(*) filter (where p.staged_reason is not null) landed
  from freezers f join slots s on s.freezer_id = f.id left join pallets p on p.slot_id = s.id and p.container_id is null
 where f.kind = 'staging' group by f.site order by 1;
select count(*) still_unslotted, count(*) filter (where received_site is null) no_site from pallets where status = 'unslotted' and container_id is null;
commit;
