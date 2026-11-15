export async function getCurrentUserId(client) {
  const { data, error } = await client.auth.getUser();
  if (error) throw error;
  if (!data.user?.id) throw new Error('Authentication is required.');
  return data.user.id;
}
