-- 143_plan_a_mpxdb.sql  (Msg TAG-9, 2026-10-30) Plan A: the four Moroccan Peaches x Donny Burger trials go to METRC through the app.
-- METRC still has all their plants flowering in Field 2 (#54 123, #73 133, #74 123, #79 124) and no packages on 821/822/845/846.
-- After this, Push in the Harvest log queues: harvest plants (wet weight) from Field 2, then the package on each tag.
--   #74 (harvest 181, T021 / 821): 10/17, 123 plants, raw = pallet weight 80.27 (no raw was written down; Aziz).
--   #79 (harvest 182, T022 / 822): 10/17, 124 plants, raw bins 80 + 81 = 161. The package is made at 161, then Aziz adjusts
--        it to 269.58 on the freezer map (Adjust weight, reason Entry error, note "Clerical error").
--   #54 (new harvest, planting 139, T045 / 845): 10/19, 123 plants, raw bins 119.2 + 116.4 = 235.6, pallet 189.
--   #73 (new harvest, planting 140, T046 / 846): 10/19, 133 plants, raw bins 119 + 58.4 = 177.4, pallet 154.8.
-- App dates = the Farm Data sheet dates. Raw bins from Farm Data OHR Raw Weights. Nothing goes to METRC until Push.
begin;

-- 181 / 182 were imported as finished with 0 plants and nothing in METRC: back to Harvesting with the real counts
update cult_harvests set status = 'planned', stage = 'harvesting', harvested_on = date '2026-10-17', planned_on = coalesce(planned_on, date '2026-10-17'),
       plants = v.plants, plants_harvested = v.plants, metrc_plants = 0, metrc_wet_lbs = 0, metrc_name = null,
       raw_bins = v.bins, updated_by = 'aziz@lifted-organics.com', updated_at = now()
  from (values (181, 123, array[80.27]::numeric[]), (182, 124, array[80, 81]::numeric[])) v(hid, plants, bins)
 where id = v.hid and status = 'done' and metrc_plants = 0;

-- #54 and #73: new harvests from their plantings (Block 3)
insert into cult_harvests (crop_year, site, field_id, strain, planting_id, kind, status, stage, planned_on, harvested_on, plants, plants_harvested, raw_bins, created_by, updated_by)
select 2026, 'OHR', p.field_id, p.strain, p.id, 'ff', 'planned', 'harvesting', date '2026-10-19', date '2026-10-19', v.plants, v.plants, v.bins,
       'aziz@lifted-organics.com', 'aziz@lifted-organics.com'
  from (values (139, 123, array[119.2, 116.4]::numeric[]), (140, 133, array[119, 58.4]::numeric[])) v(pid, plants, bins)
  join cult_plantings p on p.id = v.pid
 where not exists (select 1 from cult_harvests h where h.planting_id = v.pid and h.status <> 'cancelled');

-- raw bins (Push sends the bins not pushed yet as the METRC wet weight)
insert into cult_weights (harvest_id, kind, lbs, note, created_by)
select h.id, 'raw', b.lbs, '143 from Farm Data Raw Weights', 'aziz@lifted-organics.com'
  from cult_harvests h cross join lateral unnest(h.raw_bins) b(lbs)
 where h.planting_id in (139, 140, 144, 145) and h.status = 'planned' and h.stage = 'harvesting'
   and not exists (select 1 from cult_weights w where w.harvest_id = h.id and w.kind = 'raw');

-- lots for the two new harvests
select harvest_lot(h.id) from cult_harvests h where h.planting_id in (139, 140) and h.lot_id is null;

-- pallets: link, not pushed yet; T022 at the raw weight for now
update pallets p set harvest_id = h.id, pushed = false, updated_at = now()
  from cult_harvests h
 where h.status = 'planned' and h.stage = 'harvesting'
   and ((p.id = 1912 and h.planting_id = 139) or (p.id = 1913 and h.planting_id = 140) or (p.id = 657 and h.id = 181) or (p.id = 667 and h.id = 182));
update pallets set og_weight = 161, current_weight = 161, updated_at = now() where id = 667 and og_weight = 269.58;

insert into events (user_email, type, pallet_id, lbs, note, details)
select 'aziz@lifted-organics.com', 'harvest_fix', p.id, p.og_weight, '143 Plan A: queued for Push',
       jsonb_build_object('harvest_id', p.harvest_id, 'code', p.code, 'tag', p.package_tag,
                          'note', case when p.id = 667 then 'Package at raw 161, then adjust to 269.58 (clerical error)' end)
  from pallets p where p.id in (657, 667, 1912, 1913);

commit;

select h.id, h.strain, h.harvested_on, h.plants_harvested, (select sum(lbs) from cult_weights w where w.harvest_id = h.id and w.kind = 'raw' and not w.pushed) as raw_to_send,
       p.code, p.og_weight, right(p.package_tag, 3) as tag, p.pushed, cult_batch_name(h) as metrc_name, harvest_app_name(h) as app_name
  from cult_harvests h join pallets p on p.harvest_id = h.id
 where h.planting_id in (139, 140, 144, 145) order by p.code;
