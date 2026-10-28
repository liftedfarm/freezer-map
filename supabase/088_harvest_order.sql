-- 088: harvest schedule order within a day (drag to reorder on the Schedule). Run after 087.
alter table cult_harvests add column if not exists sched_order numeric;
select 'ok' as harvest_order;
