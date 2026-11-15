import { callApi } from './apiClient.js';
import { getCurrentUserId } from './clientIdentity.js';
import { normalizeInvoiceForm, normalizePackageForm } from './coachingUtils.js';
import { notifyClients } from './pushService.js';
import { requireSupabase } from './supabaseClient.js';

const PACKAGE_FIELDS = 'id,coach_id,name,description,session_count,price_cents,currency,is_active,created_at';
const INVOICE_FIELDS = 'id,invoice_number,coach_id,client_id,description,sessions_included,amount_cents,currency,status,due_date,paid_at,created_at';

export async function listPackages() {
  const { data, error } = await requireSupabase()
    .from('coach_packages')
    .select(PACKAGE_FIELDS)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createPackage(form) {
  const client = requireSupabase();
  const { error } = await client
    .from('coach_packages')
    .insert({ coach_id: await getCurrentUserId(client), ...normalizePackageForm(form) });
  if (error) throw error;
}

export async function setPackageActive(packageId, isActive) {
  const { error } = await requireSupabase().from('coach_packages').update({ is_active: isActive }).eq('id', packageId);
  if (error) throw error;
}

export async function listInvoices() {
  const { data, error } = await requireSupabase()
    .from('invoices')
    .select(INVOICE_FIELDS)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return data || [];
}

export async function listCredits() {
  const { data, error } = await requireSupabase()
    .from('client_package_credits')
    .select('id,client_id,package_name,sessions_total,sessions_remaining,created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createInvoice({ clientId, ...form }) {
  const normalized = normalizeInvoiceForm(form);
  const { data, error } = await requireSupabase().rpc('create_invoice', {
    p_client_id: clientId,
    p_description: normalized.description,
    p_amount_cents: normalized.amountCents,
    p_currency: normalized.currency,
    p_due_date: normalized.dueDate,
  });
  if (error) throw error;
  notifyClients('invoice', data);
  return data;
}

export async function createPackageInvoice(clientId, packageId, { notify = false } = {}) {
  const { data, error } = await requireSupabase().rpc('create_package_invoice', {
    p_client_id: clientId,
    p_package_id: packageId,
  });
  if (error) throw error;
  if (notify) notifyClients('invoice', data);
  return data;
}

export async function voidInvoice(invoiceId) {
  const { error } = await requireSupabase().rpc('void_invoice', { p_invoice_id: invoiceId });
  if (error) throw error;
}

export const getStripeConnectStatus = () => callApi('stripe', { body: { action: 'connect-status' } });
export const startStripeOnboarding = () => callApi('stripe', { body: { action: 'connect-onboard' } });
export const startInvoiceCheckout = (invoiceId) => callApi('stripe', { body: { action: 'checkout', invoiceId } });
