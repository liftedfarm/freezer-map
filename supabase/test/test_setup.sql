-- Creates GVR Freezer 99 (TEST) with 4 fake pallets for trying split / merge / move.
-- Run test_cleanup.sql afterwards to remove all of it, including its history.
begin;
insert into freezers (site, number, status, notes) values ('GVR', 99, 'On', 'TEST FREEZER - delete with test_cleanup.sql')
  on conflict (site, number) do nothing;
insert into slots (freezer_id, code, col, row, front_rank)
select f.id, '99' || substr('ABCDEFGHIJKLMNOPQR', (c - 1) * 9 + r, 1), c, r, 10 - r
  from freezers f, generate_series(1, 2) c, generate_series(1, 9) r
 where f.site = 'GVR' and f.number = 99
on conflict do nothing;
insert into pallets (code, strain, zone, harvest_date, og_weight, current_weight, package_tag, status, slot_id)
select v.code, v.strain, 'Test', current_date, v.w, v.w, v.tag, 'in_freezer', s.id
  from (values ('TEST1','Test Strain',500,'TESTTAG0000000000000001','99A'),
               ('TEST2','Test Strain',300,'TESTTAG0000000000000002','99B'),
               ('TEST3','Test Strain',250,'TESTTAG0000000000000003','99J'),
               ('TEST4','Other Test Strain',400,'TESTTAG0000000000000004','99K')) v(code, strain, w, tag, slot)
  join slots s on s.code = v.slot
  join freezers f on f.id = s.freezer_id and f.site = 'GVR' and f.number = 99
on conflict (code) do nothing;
commit;
select code, strain, current_weight from pallets where code like 'TEST%' order by code;
