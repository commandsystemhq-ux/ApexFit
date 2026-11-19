import { requireSupabase } from './supabaseClient.js';

const PRODUCT_FIELDS = 'id,program_template_id,title,description,price_cents,currency,cover_image_url,is_published,created_at';

export async function listProducts() {
  const { data, error } = await requireSupabase().from('store_products').select(PRODUCT_FIELDS).order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function saveProduct({ id = null, programId, title, description, priceCents, currency, cover, publish }) {
  const { data, error } = await requireSupabase().rpc('save_store_product', {
    p_product_id: id,
    p_program_id: programId,
    p_title: title,
    p_description: description,
    p_price_cents: priceCents,
    p_currency: currency,
    p_cover_image_url: cover,
    p_publish: publish,
  });
  if (error) throw error;
  return data;
}

export async function setProductPublished(productId, published) {
  const { error } = await requireSupabase().rpc('set_store_product_published', { p_product_id: productId, p_published: published });
  if (error) throw error;
}

export async function deleteProduct(productId) {
  const { error } = await requireSupabase().rpc('delete_store_product', { p_product_id: productId });
  if (error) throw error;
}

export async function getSales() {
  const { data, error } = await requireSupabase().rpc('get_store_sales');
  if (error) throw error;
  return data;
}

export async function getMyStore() {
  const { data, error } = await requireSupabase().rpc('get_my_store');
  if (error) throw error;
  return data;
}

// Free products are delivered at once. A paid product becomes an open order: the client pays the coach directly, says
// so (reportStorePayment) and the coach confirms (confirmStorePayment), which delivers the program.
export async function buyProduct(productId) {
  const { data, error } = await requireSupabase().rpc('begin_store_purchase', { p_product_id: productId });
  if (error) throw error;
  return { completed: Boolean(data.completed), alreadyOwned: Boolean(data.already_owned), orderId: data.order_id, reported: Boolean(data.payment_reported) };
}

async function rpc(name, args) {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) throw error;
  return data;
}

export const reportStorePayment = (orderId) => rpc('report_store_payment', { p_order_id: orderId });
export const cancelStoreOrder = (orderId) => rpc('cancel_store_order', { p_order_id: orderId });
export const confirmStorePayment = (orderId, method, reference) => rpc('confirm_store_payment', {
  p_order_id: orderId, p_method: method, p_reference: reference || null,
});

// The public storefront needs no account, only the project's anon key.
export async function getPublicStore(coachId) {
  const { data, error } = await requireSupabase().rpc('get_public_store', { p_coach_id: coachId });
  if (error) throw error;
  return data;
}