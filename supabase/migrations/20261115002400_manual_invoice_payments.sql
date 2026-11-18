-- Clients pay their coach directly: by bank transfer (IBAN or a local account) or by a method the coach and the client
-- agree on (a wallet, a payment link, cash...). ApexFit does not hold this money and needs no payment provider for it.
-- The coach states how to pay, the client says "I paid", and the coach confirms; confirming a package invoice gives the
-- client their sessions, exactly as an online payment used to.

-- ---------------------------------------------------------------------------
-- IBAN check (ISO 13616): shape and the mod-97 checksum. Kept identical to src/services/paymentMethodsUtils.js.
-- ---------------------------------------------------------------------------
create or replace function public.normalize_iban(p_iban text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(upper(regexp_replace(coalesce(p_iban, ''), '[[:space:]-]', '', 'g')), '');
$$;

create or replace function public.iban_is_valid(p_iban text)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_iban text := public.normalize_iban(p_iban);
  v_moved text;
  v_char text;
  v_rest integer := 0;
  v_index integer;
begin
  if v_iban is null or v_iban !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' then
    return false;
  end if;
  v_moved := substr(v_iban, 5) || substr(v_iban, 1, 4);
  for v_index in 1..char_length(v_moved) loop
    v_char := substr(v_moved, v_index, 1);
    if v_char ~ '[0-9]' then
      v_rest := (v_rest * 10 + v_char::integer) % 97;
    else
      v_rest := (v_rest * 100 + (ascii(v_char) - 55)) % 97;
    end if;
  end loop;
  return v_rest = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- How a coach gets paid
-- ---------------------------------------------------------------------------
create table if not exists public.coach_payment_methods (
  coach_id uuid primary key references public.profiles (id) on delete cascade,
  bank_enabled boolean not null default false,
  account_holder text check (account_holder is null or char_length(account_holder) between 2 and 120),
  bank_name text check (bank_name is null or char_length(bank_name) <= 120),
  iban text check (iban is null or public.iban_is_valid(iban)),
  swift_bic text check (swift_bic is null or swift_bic ~ '^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
  account_number text check (account_number is null or char_length(account_number) between 3 and 60),
  custom_enabled boolean not null default false,
  custom_label text check (custom_label is null or char_length(custom_label) between 2 and 60),
  custom_instructions text check (custom_instructions is null or char_length(custom_instructions) between 3 and 1000),
  payment_note text check (payment_note is null or char_length(payment_note) <= 500),
  updated_at timestamptz not null default now(),
  constraint bank_details_complete check (not bank_enabled or (account_holder is not null and (iban is not null or account_number is not null))),
  constraint custom_method_complete check (not custom_enabled or (custom_label is not null and custom_instructions is not null))
);

alter table public.coach_payment_methods enable row level security;

drop policy if exists "Coaches read their payment methods" on public.coach_payment_methods;
create policy "Coaches read their payment methods"
  on public.coach_payment_methods for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

revoke all on public.coach_payment_methods from public, anon, authenticated;
grant select on public.coach_payment_methods to authenticated;
grant all on public.coach_payment_methods to service_role;

-- What the coach sees and what a client of that coach sees: the same object.
create or replace function public.payment_methods_json(p_row public.coach_payment_methods)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'bank', case when p_row.bank_enabled then jsonb_build_object(
      'account_holder', p_row.account_holder,
      'bank_name', p_row.bank_name,
      'iban', p_row.iban,
      'swift_bic', p_row.swift_bic,
      'account_number', p_row.account_number
    ) else null end,
    'custom', case when p_row.custom_enabled then jsonb_build_object(
      'label', p_row.custom_label,
      'instructions', p_row.custom_instructions
    ) else null end,
    'note', p_row.payment_note
  );
$$;

revoke all on function public.payment_methods_json(public.coach_payment_methods) from public, anon, authenticated;

create or replace function public.save_payment_methods(
  p_bank_enabled boolean,
  p_account_holder text,
  p_bank_name text,
  p_iban text,
  p_swift_bic text,
  p_account_number text,
  p_custom_enabled boolean,
  p_custom_label text,
  p_custom_instructions text,
  p_payment_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_iban text := public.normalize_iban(p_iban);
  v_swift text := nullif(upper(regexp_replace(coalesce(p_swift_bic, ''), '[[:space:]]', '', 'g')), '');
  v_row public.coach_payment_methods;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required' using errcode = '42501';
  end if;
  if v_iban is not null and not public.iban_is_valid(v_iban) then
    raise exception 'That IBAN is not valid. Check the digits and letters.' using errcode = '22023';
  end if;
  if v_swift is not null and v_swift !~ '^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$' then
    raise exception 'That SWIFT/BIC code is not valid.' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_account_holder, ''))) > 120 or char_length(btrim(coalesce(p_bank_name, ''))) > 120
    or (nullif(btrim(p_account_holder), '') is not null and char_length(btrim(p_account_holder)) < 2) then
    raise exception 'The account holder and bank name must be 2 to 120 characters.' using errcode = '22023';
  end if;
  if nullif(btrim(p_account_number), '') is not null and char_length(btrim(p_account_number)) not between 3 and 60 then
    raise exception 'The account number must be 3 to 60 characters.' using errcode = '22023';
  end if;
  if nullif(btrim(p_custom_label), '') is not null and char_length(btrim(p_custom_label)) not between 2 and 60 then
    raise exception 'The method name must be 2 to 60 characters.' using errcode = '22023';
  end if;
  if nullif(btrim(p_custom_instructions), '') is not null and char_length(btrim(p_custom_instructions)) not between 3 and 1000 then
    raise exception 'The payment instructions must be 3 to 1000 characters.' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_payment_note, ''))) > 500 then
    raise exception 'The note can be up to 500 characters.' using errcode = '22023';
  end if;
  if coalesce(p_bank_enabled, false)
    and (nullif(btrim(p_account_holder), '') is null or (v_iban is null and nullif(btrim(p_account_number), '') is null)) then
    raise exception 'Bank transfer needs the account holder and an IBAN or an account number.' using errcode = '22023';
  end if;
  if coalesce(p_custom_enabled, false)
    and (nullif(btrim(p_custom_label), '') is null or nullif(btrim(p_custom_instructions), '') is null) then
    raise exception 'A custom payment method needs a name and instructions.' using errcode = '22023';
  end if;

  insert into public.coach_payment_methods (
    coach_id, bank_enabled, account_holder, bank_name, iban, swift_bic, account_number,
    custom_enabled, custom_label, custom_instructions, payment_note, updated_at
  )
  values (
    auth.uid(), coalesce(p_bank_enabled, false), nullif(btrim(p_account_holder), ''), nullif(btrim(p_bank_name), ''), v_iban, v_swift,
    nullif(btrim(p_account_number), ''), coalesce(p_custom_enabled, false), nullif(btrim(p_custom_label), ''),
    nullif(btrim(p_custom_instructions), ''), nullif(btrim(p_payment_note), ''), now()
  )
  on conflict (coach_id) do update set
    bank_enabled = excluded.bank_enabled,
    account_holder = excluded.account_holder,
    bank_name = excluded.bank_name,
    iban = excluded.iban,
    swift_bic = excluded.swift_bic,
    account_number = excluded.account_number,
    custom_enabled = excluded.custom_enabled,
    custom_label = excluded.custom_label,
    custom_instructions = excluded.custom_instructions,
    payment_note = excluded.payment_note,
    updated_at = now()
  returning * into v_row;

  return public.payment_methods_json(v_row);
end;
$$;

create or replace function public.get_my_payment_methods()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.coach_payment_methods;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required' using errcode = '42501';
  end if;
  select * into v_row from public.coach_payment_methods where coach_id = auth.uid();
  if not found then
    return null;
  end if;
  return public.payment_methods_json(v_row) || jsonb_build_object('form', jsonb_build_object(
    'bank_enabled', v_row.bank_enabled, 'custom_enabled', v_row.custom_enabled
  ));
end;
$$;

-- A client reads how to pay their own coach (nobody else's), and only while they are that coach's active client.
create or replace function public.get_coach_payment_info(p_coach_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.coach_payment_methods;
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.coach_clients cc
    where cc.coach_id = p_coach_id and cc.client_id = auth.uid() and cc.status = 'active'
  ) then
    raise exception 'This coach is not available' using errcode = '42501';
  end if;
  select * into v_row from public.coach_payment_methods where coach_id = p_coach_id;
  if not found or not (v_row.bank_enabled or v_row.custom_enabled) then
    return jsonb_build_object('bank', null, 'custom', null, 'note', null);
  end if;
  return public.payment_methods_json(v_row);
end;
$$;

-- ---------------------------------------------------------------------------
-- Invoices paid outside the app
-- ---------------------------------------------------------------------------
alter table public.invoices add column if not exists payment_reported_at timestamptz;
alter table public.invoices add column if not exists paid_method text;
alter table public.invoices add column if not exists payment_reference text;

alter table public.invoices drop constraint if exists invoices_paid_method_check;
alter table public.invoices add constraint invoices_paid_method_check
  check (paid_method is null or paid_method in ('bank_transfer', 'custom', 'cash', 'other', 'card'));
alter table public.invoices drop constraint if exists invoices_payment_reference_check;
alter table public.invoices add constraint invoices_payment_reference_check
  check (payment_reference is null or char_length(payment_reference) <= 120);

-- The client tells the coach they have paid. The invoice stays open until the coach confirms.
create or replace function public.report_invoice_payment(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required' using errcode = '42501';
  end if;
  update public.invoices
  set payment_reported_at = coalesce(payment_reported_at, now())
  where id = p_invoice_id and client_id = auth.uid() and status = 'open';
  if not found then
    raise exception 'Only your own open invoices can be reported as paid' using errcode = '42501';
  end if;
end;
$$;

-- The coach confirms that the money arrived. A package invoice then gives the client their sessions.
create or replace function public.confirm_invoice_payment(p_invoice_id uuid, p_method text, p_reference text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice public.invoices%rowtype;
  v_reference text := nullif(btrim(p_reference), '');
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required' using errcode = '42501';
  end if;
  if p_method not in ('bank_transfer', 'custom', 'cash', 'other') then
    raise exception 'Choose how the invoice was paid' using errcode = '22023';
  end if;
  if v_reference is not null and char_length(v_reference) > 120 then
    raise exception 'The payment reference is too long' using errcode = '22023';
  end if;

  select * into v_invoice from public.invoices where id = p_invoice_id and coach_id = auth.uid() for update;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  if v_invoice.status <> 'open' then
    raise exception 'Only open invoices can be confirmed as paid' using errcode = '22023';
  end if;

  update public.invoices
  set status = 'paid', paid_at = statement_timestamp(), paid_method = p_method, payment_reference = v_reference
  where id = v_invoice.id;

  if v_invoice.sessions_included is not null then
    insert into public.client_package_credits (invoice_id, coach_id, client_id, package_name, sessions_total, sessions_remaining)
    values (v_invoice.id, v_invoice.coach_id, v_invoice.client_id, v_invoice.description, v_invoice.sessions_included, v_invoice.sessions_included)
    on conflict (invoice_id) do nothing;
  end if;
  return jsonb_build_object('status', 'paid', 'credits_added', v_invoice.sessions_included);
end;
$$;

revoke all on function public.normalize_iban(text) from public, anon;
revoke all on function public.iban_is_valid(text) from public, anon;
grant execute on function public.normalize_iban(text) to authenticated, service_role;
grant execute on function public.iban_is_valid(text) to authenticated, service_role;
revoke all on function public.save_payment_methods(boolean, text, text, text, text, text, boolean, text, text, text) from public, anon;
revoke all on function public.get_my_payment_methods() from public, anon;
revoke all on function public.get_coach_payment_info(uuid) from public, anon;
revoke all on function public.report_invoice_payment(uuid) from public, anon;
revoke all on function public.confirm_invoice_payment(uuid, text, text) from public, anon;
grant execute on function public.save_payment_methods(boolean, text, text, text, text, text, boolean, text, text, text) to authenticated;
grant execute on function public.get_my_payment_methods() to authenticated;
grant execute on function public.get_coach_payment_info(uuid) to authenticated;
grant execute on function public.report_invoice_payment(uuid) to authenticated;
grant execute on function public.confirm_invoice_payment(uuid, text, text) to authenticated;
