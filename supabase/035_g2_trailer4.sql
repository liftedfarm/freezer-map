-- Migration 035: the imported nursery batches rooted in Trailer 4: the FL26 Gen 2 cuts (10/11, rooting now) and the SU26 Gen 1 cuts (6/29).
-- (The import had put them in Trailer 1.) Run after 033. Safe to re-run.
update nursery_batches set room_id = (select id from nursery_rooms where site = '1PN' and name = 'Trailer 4')
 where notes like '[import Webb2027]%' and ((gen = 2 and cut_on = '2026-10-11') or (gen = 1 and cut_on = '2026-06-29'));
select gen, count(*) as batches_in_trailer_4 from nursery_batches b join nursery_rooms r on r.id = b.room_id
 where b.notes like '[import Webb2027]%' and r.name = 'Trailer 4' group by gen order by gen;
