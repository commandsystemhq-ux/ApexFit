-- Program store: clients pay the coach directly (bank transfer or a method they agree on), say "I have paid", and the
-- coach confirms; confirming delivers the program. Same flow as invoices (migration 2400) and no payment provider.
-- This migration also removes everything that was left of Stripe.

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------
alter table public.store_orders add column if not exists payment_reported_at timestamptz;
alter table public.store_orders add column if not exists paid_method text;
alter table public.store_orders add column if not exists payment_reference text;

alter table public.store_orders drop constraint if exists store_orders_payment_mode_check;
alter table public.store_orders drop constraint if exists store_orders_paid_method_check;
alter table public.store_orders drop constraint if exists store_orders_payment_reference_check;

-- Orders that were paid online or in test mode stay paid and keep their access; they are now simply "manual" payments.
update public.store_orders
set paid_method = case when payment_mode = 'stripe' then 'card' else 'other' end,
    payment_mode = 'manual'
where payment_mode in ('stripe', 'demo');

alter table public.store_orders alter column payment_mode set default 'manual';
alter table public.store_orders add constraint store_orders_payment_mode_check check (payment_mode in ('manual', 'free'));
alter table public.store_orders add constraint store_orders_paid_method_check
  check (paid_method is null or paid_method in ('bank_transfer', 'custom', 'cash', 'other', 'card'));
alter table public.store_orders add constraint store_orders_payment_reference_check
  check (payment_reference is null or char_length(payment_reference) <= 120);

alter table public.store_orders drop column if exists stripe_session_id;
alter table public.store_orders drop column if exists stripe_payment_intent_id;

-- ---------------------------------------------------------------------------
-- Delivery (internal) and the purchase steps
-- ---------------------------------------------------------------------------
-- The old functions were written for the payment webhook; they go.
drop function if exists public.complete_store_order(uuid, text, integer, text, text, text);
drop function if exists public.finish_store_order(uuid, text, text, text);

-- Marks an order as paid and gives the buyer the program. Safe to call twice for the same order. Internal: called only
-- by the functions below.
create or replace function public.deliver_store_order(p_order_id uuid, p_mode text, p_method text, p_reference text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.store_orders%rowtype;
  v_assignment jsonb;
  v_note text;
begin
  select * into v_order from public.store_orders where id = p_order_id for update;
  if not found then
    raise exception 'Order was not found';
  end if;
  if v_order.status = 'paid' then
    return jsonb_build_object('order_id', v_order.id, 'status', 'paid', 'already_paid', true, 'assignment_id', v_order.assignment_id);
  end if;
  if v_order.status <> 'pending' then
    raise exception 'This order can no longer be completed';
  end if;

  begin
    v_assignment := public.assign_program_core(v_order.coach_id, v_order.buyer_client_id, v_order.program_template_id);
  exception when others then
    v_assignment := null;
    v_note := left('Program was not delivered: ' || sqlerrm, 300);
  end;

  update public.store_orders
  set status = 'paid',
      payment_mode = p_mode,
      paid_method = p_method,
      payment_reference = p_reference,
      assignment_id = (v_assignment ->> 'assignment_id')::uuid,
      note = v_note,
      purchased_at = statement_timestamp()
  where id = p_order_id;

  return jsonb_build_object(
    'order_id', p_order_id, 'status', 'paid', 'already_paid', false,
    'assignment_id', v_assignment ->> 'assignment_id', 'delivered', v_assignment is not null
  );
end;
$$;

-- Starts (or resumes) a purchase for the signed-in client. Free products are delivered on the spot; a paid product
-- becomes an open order that waits for the client to pay the coach and the coach to confirm.
create or replace function public.begin_store_purchase(p_product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product public.store_products%rowtype;
  v_order public.store_orders%rowtype;
  v_done jsonb;
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required to buy programs';
  end if;

  select * into v_product from public.store_products where id = p_product_id;
  if not found or not v_product.is_published or not exists (
    select 1 from public.coach_clients where coach_id = v_product.coach_id and client_id = auth.uid() and status = 'active'
  ) then
    raise exception 'This product is not available';
  end if;
  if not public.workflow_coach_is_active(v_product.coach_id) then
    raise exception 'This store is not accepting orders right now';
  end if;

  select * into v_order from public.store_orders
  where product_id = p_product_id and buyer_client_id = auth.uid() and status in ('pending', 'paid')
  for update;

  if found and v_order.status = 'paid' then
    return jsonb_build_object('order_id', v_order.id, 'already_owned', true, 'completed', true);
  end if;

  if not found then
    insert into public.store_orders (product_id, buyer_client_id, coach_id, product_title, program_template_id, amount_cents, currency, payment_mode)
    values (p_product_id, auth.uid(), v_product.coach_id, v_product.title, v_product.program_template_id,
            v_product.price_cents, v_product.currency, case when v_product.price_cents = 0 then 'free' else 'manual' end)
    returning * into v_order;
  else
    -- The coach may have changed the price since the order was opened; a payment reported at the old price no longer counts.
    update public.store_orders
    set product_title = v_product.title, program_template_id = v_product.program_template_id,
        payment_reported_at = case
          when amount_cents <> v_product.price_cents or currency <> v_product.currency then null
          else payment_reported_at end,
        amount_cents = v_product.price_cents, currency = v_product.currency,
        payment_mode = case when v_product.price_cents = 0 then 'free' else 'manual' end
    where id = v_order.id
    returning * into v_order;
  end if;

  if v_order.amount_cents = 0 then
    v_done := public.deliver_store_order(v_order.id, 'free', null, null);
    return jsonb_build_object('order_id', v_order.id, 'already_owned', false, 'completed', true, 'assignment_id', v_done ->> 'assignment_id');
  end if;

  return jsonb_build_object(
    'order_id', v_order.id, 'already_owned', false, 'completed', false,
    'amount_cents', v_order.amount_cents, 'currency', v_order.currency,
    'title', v_order.product_title, 'coach_id', v_order.coach_id,
    'payment_reported', v_order.payment_reported_at is not null
  );
end;
$$;

-- The client says they have paid. The order stays open until the coach confirms.
create or replace function public.report_store_payment(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required' using errcode = '42501';
  end if;
  update public.store_orders
  set payment_reported_at = coalesce(payment_reported_at, now())
  where id = p_order_id and buyer_client_id = auth.uid() and status = 'pending' and amount_cents > 0;
  if not found then
    raise exception 'Only your own open orders can be reported as paid' using errcode = '42501';
  end if;
end;
$$;

-- The coach confirms that the money arrived (or hands the program over by hand); the buyer gets the program.
create or replace function public.confirm_store_payment(p_order_id uuid, p_method text, p_reference text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reference text := nullif(btrim(p_reference), '');
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required' using errcode = '42501';
  end if;
  if p_method not in ('bank_transfer', 'custom', 'cash', 'other') then
    raise exception 'Choose how the order was paid' using errcode = '22023';
  end if;
  if v_reference is not null and char_length(v_reference) > 120 then
    raise exception 'The payment reference is too long' using errcode = '22023';
  end if;
  if not exists (select 1 from public.store_orders where id = p_order_id and coach_id = auth.uid()) then
    raise exception 'Order was not found' using errcode = 'P0002';
  end if;
  return public.deliver_store_order(p_order_id, 'manual', p_method, v_reference);
end;
$$;

-- Either side can close an open order: the coach declines it, the buyer withdraws it. The client can buy again later.
create or replace function public.cancel_store_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  update public.store_orders
  set status = 'canceled', payment_reported_at = null
  where id = p_order_id and status = 'pending' and (buyer_client_id = auth.uid() or coach_id = auth.uid());
  if not found then
    raise exception 'Only your own open orders can be canceled' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- What the coach and the client see
-- ---------------------------------------------------------------------------
create or replace function public.get_store_sales()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage the store';
  end if;
  return jsonb_build_object(
    'orders_paid', (select count(*) from public.store_orders where coach_id = auth.uid() and status = 'paid'),
    'orders_pending', (select count(*) from public.store_orders where coach_id = auth.uid() and status = 'pending'),
    'revenue', coalesce((
      select jsonb_agg(jsonb_build_object('currency', currency, 'cents', total) order by currency)
      from (
        select currency, sum(amount_cents)::bigint as total
        from public.store_orders where coach_id = auth.uid() and status = 'paid' group by currency
      ) r
    ), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('product_id', p.id, 'title', p.title, 'sales', s.sales, 'cents', s.cents, 'currency', p.currency) order by s.sales desc, p.title)
      from public.store_products p
      cross join lateral (
        select count(*) filter (where o.status = 'paid')::integer as sales,
               coalesce(sum(o.amount_cents) filter (where o.status = 'paid'), 0)::bigint as cents
        from public.store_orders o where o.product_id = p.id
      ) s
      where p.coach_id = auth.uid()
    ), '[]'::jsonb),
    'pending', coalesce((
      select jsonb_agg(jsonb_build_object(
        'order_id', o.id, 'title', o.product_title, 'amount_cents', o.amount_cents, 'currency', o.currency,
        'created_at', o.created_at, 'payment_reported_at', o.payment_reported_at,
        'buyer', coalesce(nullif(btrim(cc.client_name), ''), nullif(btrim(cc.client_email), ''), 'Client')
      ) order by (o.payment_reported_at is null), coalesce(o.payment_reported_at, o.created_at) desc)
      from (
        select * from public.store_orders where coach_id = auth.uid() and status = 'pending' and amount_cents > 0
        order by created_at desc limit 50
      ) o
      left join public.coach_clients cc on cc.coach_id = o.coach_id and cc.client_id = o.buyer_client_id
    ), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
        'order_id', o.id, 'title', o.product_title, 'amount_cents', o.amount_cents, 'currency', o.currency,
        'payment_mode', o.payment_mode, 'paid_method', o.paid_method, 'payment_reference', o.payment_reference,
        'purchased_at', o.purchased_at, 'delivered', o.assignment_id is not null,
        'buyer', coalesce(nullif(btrim(cc.client_name), ''), nullif(btrim(cc.client_email), ''), 'Client')
      ) order by o.purchased_at desc)
      from (
        select * from public.store_orders where coach_id = auth.uid() and status = 'paid' order by purchased_at desc limit 20
      ) o
      left join public.coach_clients cc on cc.coach_id = o.coach_id and cc.client_id = o.buyer_client_id
    ), '[]'::jsonb)
  );
end;
$$;

-- The client's store: their coach's published products, their open orders, what they own, and the purchased programs.
create or replace function public.get_my_store()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required';
  end if;
  return jsonb_build_object(
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'title', p.title, 'description', p.description, 'price_cents', p.price_cents, 'currency', p.currency,
        'cover_image_url', p.cover_image_url, 'coach_id', p.coach_id,
        'coach_name', coalesce(nullif(btrim(pr.brand_name), ''), nullif(btrim(pr.full_name), ''), nullif(btrim(cc.coach_name), '')),
        'owned', exists (select 1 from public.store_orders o where o.product_id = p.id and o.buyer_client_id = auth.uid() and o.status = 'paid'),
        'pending_order', (
          select jsonb_build_object('id', o.id, 'reported', o.payment_reported_at is not null)
          from public.store_orders o
          where o.product_id = p.id and o.buyer_client_id = auth.uid() and o.status = 'pending' and o.amount_cents > 0
          limit 1
        )
      ) order by p.created_at desc)
      from public.store_products p
      join public.coach_clients cc on cc.coach_id = p.coach_id and cc.client_id = auth.uid() and cc.status = 'active'
      left join public.profiles pr on pr.id = p.coach_id
      where p.is_published and public.workflow_coach_is_active(p.coach_id)
    ), '[]'::jsonb),
    'purchases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'order_id', o.id, 'title', o.product_title, 'amount_cents', o.amount_cents, 'currency', o.currency,
        'purchased_at', o.purchased_at,
        'program', case when o.program_template_id is null then null else public.program_summary(o.program_template_id) end
      ) order by o.purchased_at desc)
      from public.store_orders o
      where o.buyer_client_id = auth.uid() and o.status = 'paid'
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.deliver_store_order(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.begin_store_purchase(uuid) from public, anon;
revoke all on function public.report_store_payment(uuid) from public, anon;
revoke all on function public.confirm_store_payment(uuid, text, text) from public, anon;
revoke all on function public.cancel_store_order(uuid) from public, anon;
revoke all on function public.get_store_sales() from public, anon;
revoke all on function public.get_my_store() from public, anon;
grant execute on function public.begin_store_purchase(uuid) to authenticated;
grant execute on function public.report_store_payment(uuid) to authenticated;
grant execute on function public.confirm_store_payment(uuid, text, text) to authenticated;
grant execute on function public.cancel_store_order(uuid) to authenticated;
grant execute on function public.get_store_sales() to authenticated;
grant execute on function public.get_my_store() to authenticated;

-- ---------------------------------------------------------------------------
-- What was left of Stripe
-- ---------------------------------------------------------------------------
-- The connected-account table, the invoice webhook function and the payment ids on invoices. Invoices already paid
-- keep their status and dates; only the gateway identifiers go.
drop function if exists public.mark_invoice_paid(uuid, text, text, integer, text);
drop table if exists public.coach_payment_accounts cascade;
alter table public.invoices drop column if exists stripe_checkout_session_id;
alter table public.invoices drop column if exists stripe_payment_intent_id;
update public.invoices set paid_method = 'card' where status = 'paid' and paid_method is null;
