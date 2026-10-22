-- Migration 038: the Admin dashboard catches up: Nursery (moms, rooting, owed, deliveries, breeding), billing (open, overdue, paid),
-- spray / feed / labor logs this month, licenses expiring, open orders. Run after 037. Safe to re-run.
set client_min_messages = warning;

CREATE OR REPLACE FUNCTION public.admin_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare yr int := crop_year(); mo date := date_trunc('month', current_date)::date; r jsonb;
begin
  if not is_admin() then raise exception 'Only someone with the Admin module can see the company overview'; end if;
  select jsonb_build_object(
    'crop_year', yr,
    'freezers', (select jsonb_build_object(
        'lbs', coalesce(sum(p.current_weight), 0), 'pallets', count(*))
      from pallets p where p.status = 'in_freezer' and p.container_id is null),
    'open_spaces', (select count(*) from slots s join freezers f on f.id = s.freezer_id
      where f.kind is distinct from 'staging' and f.status <> 'Not Working'
        and not exists (select 1 from pallets p where p.slot_id = s.id and p.status = 'in_freezer' and p.container_id is null)),
    'needs_spot', (select count(*) from pallets where status = 'unslotted' and container_id is null),
    'loads', (select jsonb_build_object('active', count(*) filter (where status in ('planning','loading','in_transit')),
                                        'in_transit', count(*) filter (where status = 'in_transit')) from loads),
    'season', (select jsonb_build_object(
        'harvests', count(*), 'done', count(*) filter (where h.status = 'done'),
        'est', coalesce(sum(h.plants * h.est_lbs_per_plant), 0),
        'done_est', coalesce(sum(h.plants * h.est_lbs_per_plant) filter (where h.status = 'done'), 0),
        'actual', coalesce(sum(coalesce(h.ff_lbs, (select sum(p.og_weight) from pallets p where p.harvest_id = h.id and p.parent_id is null))) filter (where h.status = 'done'), 0),
        'unlogged', count(*) filter (where h.status = 'planned' and h.planned_on < current_date))
      from cult_harvests h where h.crop_year = yr and h.kind = 'ff' and h.status <> 'cancelled'),
    'reserves', (select jsonb_build_object('reserved', coalesce(sum(reserved), 0), 'shipped', coalesce(sum(shipped), 0),
        'pending', coalesce(sum(pending), 0), 'remaining', coalesce(sum(remaining), 0), 'customers', count(distinct customer_id))
      from reserve_balances where crop_year = yr),
    'next', (select jsonb_build_object('year', yr + 1, 'deadline', reserve_deadline(yr + 1),
        'reserved', coalesce((select sum(lbs) from reserves where crop_year = yr + 1), 0),
        'customers', (select count(distinct customer_id) from reserves where crop_year = yr + 1 and lbs > 0),
        'requested', coalesce((select sum(requested_lbs) from reserve_requests where crop_year = yr + 1 and status = 'pending'), 0))),
    'sales', jsonb_build_object(
        'requests', (select count(*) from reserve_requests where status = 'pending'),
        'to_confirm', (select count(*) from orders where status = 'submitted'),
        'orders_month', (select count(*) from orders where status not in ('draft','cancelled') and coalesce(order_date, created_at::date) >= mo),
        'lbs_ordered_month', coalesce((select sum(l.lbs) from order_lines l join orders o on o.id = l.order_id
            where o.status not in ('draft','cancelled') and coalesce(o.order_date, o.created_at::date) >= mo), 0),
        'lbs_shipped_month', coalesce((select sum(l.lbs) from order_lines l join orders o on o.id = l.order_id
            where o.status = 'shipped' and o.shipped_date >= mo), 0),
        'value_month', coalesce((select sum(l.lbs * l.price_per_lb) from order_lines l join orders o on o.id = l.order_id
            where o.status not in ('draft','cancelled') and coalesce(o.order_date, o.created_at::date) >= mo), 0)),
    'open_orders', (select count(*) from orders where status = 'pending'),
    'nursery', (select jsonb_build_object(
        'moms', coalesce((select sum(greatest(0, qty - lost)) from nursery_mothers where status = 'active'), 0),
        'mom_lots', (select count(*) from nursery_mothers where status = 'active'),
        'rooting_batches', (select count(*) from nursery_batches where stage = 'rooting'),
        'rooting', coalesce((select sum(greatest(0, cuttings - lost)) from nursery_batches where stage = 'rooting'), 0),
        'ready', coalesce((select sum(greatest(0, cuttings - lost)) from nursery_batches where stage = 'ready'), 0),
        'open_orders', (select count(*) from cult_nursery_orders o where o.nursery_site is not null and o.status not in ('cancelled','received')
                          and o.plants > coalesce((select sum(plants) from nursery_deliveries x where x.order_id = o.id), 0)),
        'owed', coalesce((select sum(o.plants - coalesce((select sum(plants) from nursery_deliveries x where x.order_id = o.id), 0)) from cult_nursery_orders o
                          where o.nursery_site is not null and o.status not in ('cancelled','received')), 0),
        'late', (select count(*) from cult_nursery_orders o where o.nursery_site is not null and o.status not in ('cancelled','received') and o.deliver_on < current_date
                   and o.plants > coalesce((select sum(plants) from nursery_deliveries x where x.order_id = o.id), 0)),
        'delivered_month', coalesce((select sum(plants) from nursery_deliveries where delivered_on >= mo), 0),
        'delivered_year', coalesce((select sum(plants) from nursery_deliveries where delivered_on >= date_trunc('year', current_date)), 0),
        'positive_tests', (select count(*) from nursery_tests where result = 'positive' and coalesce(culled, 0) = 0),
        'no_tag', (select count(*) from nursery_batches where stage in ('rooting','ready') and coalesce(array_length(tags, 1), 0) = 0),
        'runs', (select count(*) from breed_runs where status not in ('done','cancelled')),
        'hunts', (select count(*) from pheno_hunts where status not in ('done','cancelled')),
        'phenos', (select count(*) from phenos p join pheno_hunts h on h.id = p.hunt_id where h.status not in ('done','cancelled')),
        'scored', (select count(distinct pheno_id) from pheno_scores),
        'keepers', (select count(*) from phenos where status = 'keeper'))),
    'billing', (select jsonb_build_object(
        'open', count(*) filter (where status = 'open'), 'open_amt', coalesce(sum(total) filter (where status = 'open'), 0),
        'overdue', count(*) filter (where status = 'open' and due_date < current_date), 'overdue_amt', coalesce(sum(total) filter (where status = 'open' and due_date < current_date), 0),
        'billed_month', coalesce(sum(total) filter (where status <> 'void' and invoice_date >= mo), 0),
        'paid_month', coalesce(sum(total) filter (where status = 'paid' and paid_at >= mo), 0),
        'not_sent', count(*) filter (where status = 'open' and sent_at is null),
        'nursery_open_amt', coalesce(sum(total) filter (where status = 'open' and nursery_order_id is not null), 0))
      from invoices),
    'logs', (select jsonb_build_object(
        'month', count(*) filter (where log_on >= mo),
        'by', coalesce((select jsonb_object_agg(k, n) from (select module || '.' || kind as k, count(*) n from ops_logs where log_on >= mo group by 1) z), '{}'),
        'pesticide_month', count(*) filter (where log_on >= mo and (kind = 'spray' and coalesce(spray_type, '') ~* 'pest|sulfur'
             or exists (select 1 from jsonb_array_elements(products) x join input_products p on p.module = ops_logs.module and lower(p.name) = lower(x ->> 'product') where p.pesticide))),
        'labor_hours_month', coalesce(sum(coalesce(crew, 1) * coalesce(hours, 0)) filter (where kind = 'labor' and log_on >= mo), 0),
        'last', max(log_on))
      from ops_logs),
    'licenses', (select jsonb_build_object('active', count(*) filter (where active),
        'expiring', coalesce(jsonb_agg(jsonb_build_object('license', license_no, 'kind', kind, 'expires', expires) order by expires)
                             filter (where active and expires is not null and expires <= current_date + 90), '[]'))
      from licenses),
    'people', jsonb_build_object(
        'staff', (select count(*) from app_users where role in ('admin','sales','crew')),
        'staff_week', (select count(*) from app_users where role in ('admin','sales','crew') and last_seen > now() - interval '7 days'),
        'customers', (select count(*) from app_users where role = 'customer'),
        'customers_month', (select count(*) from app_users where role = 'customer' and last_seen > now() - interval '30 days'),
        'by_module', (select jsonb_object_agg(module, n) from (select module, count(*) n from module_access group by module) x),
        'view_only', (select count(distinct email) from module_access where level = 'view'),
        'owners', (select count(*) from app_users where owner))
  ) into r;
  return r;
end $function$;

select 'ok' as admin_overview;
