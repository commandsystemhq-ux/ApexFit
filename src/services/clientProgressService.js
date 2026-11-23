import { requireSupabase } from './supabaseClient.js';
import { normalizeBodyMetric, validateProgressPhoto } from './clientTrackingUtils.js';

const PHOTO_BUCKET = 'apexfit-progress-photos';

async function getCurrentClientId(client) {
  const { data, error } = await client.auth.getUser();
  if (error) throw error;
  if (!data.user?.id) throw new Error('Authentication is required.');
  return data.user.id;
}

export async function listClientBodyMetrics(limit = 365) {
  const { data, error } = await requireSupabase()
    .from('client_body_metrics')
    .select('id,measured_on,weight_kg,body_fat_percentage,notes')
    .order('measured_on', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).reverse();
}

export async function saveClientBodyMetric({ measuredOn, weight_kg, body_fat_percentage, notes }) {
  const client = requireSupabase();
  const normalized = normalizeBodyMetric({ weight_kg, body_fat_percentage, notes });
  const { error } = await client
    .from('client_body_metrics')
    .upsert({
      client_id: await getCurrentClientId(client),
      measured_on: measuredOn,
      ...normalized,
    }, { onConflict: 'client_id,measured_on' });
  if (error) throw error;
}

export async function uploadClientProgressPhoto(clientId, file) {
  validateProgressPhoto(file);
  if (!clientId) throw new TypeError('Client identity is required to upload a progress photo.');

  const client = requireSupabase();
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.type];
  const objectPath = `${clientId}/${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const { error } = await client.storage.from(PHOTO_BUCKET).upload(objectPath, file, {
    contentType: file.type,
    cacheControl: '3600',
    upsert: false,
  });
  if (error) throw error;
}

export async function listClientProgressPhotos(clientId) {
  if (!clientId) throw new TypeError('Client identity is required to list progress photos.');
  const storage = requireSupabase().storage.from(PHOTO_BUCKET);
  const { data, error } = await storage.list(clientId, {
    limit: 50,
    sortBy: { column: 'created_at', order: 'desc' },
  });
  if (error) throw error;

  const files = (data || []).filter((item) => item.id);
  const photos = await Promise.all(files.map(async (file) => {
    const path = `${clientId}/${file.name}`;
    const { data: signed, error: signedUrlError } = await storage.createSignedUrl(path, 3600);
    if (signedUrlError) throw signedUrlError;
    return { path, name: file.name, created_at: file.created_at, signedUrl: signed.signedUrl };
  }));
  return photos;
}

export async function deleteClientProgressPhoto(objectPath) {
  const { error } = await requireSupabase().storage.from(PHOTO_BUCKET).remove([objectPath]);
  if (error) throw error;
}
