// SecureStore keeps small values (about 2 KB on some iOS versions) and a Supabase session is bigger, so a value is
// stored in numbered pieces. These helpers have no native dependency, so they are easy to test.

export const CHUNK_SIZE = 1800;

export function splitIntoChunks(value, size = CHUNK_SIZE) {
  const text = String(value ?? '');
  if (!text) return [];
  const chunks = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks;
}

export const chunkKey = (key, index) => `${key}.${index}`;
export const countKey = (key) => `${key}.count`;

// `store` is { getItemAsync, setItemAsync, deleteItemAsync } (expo-secure-store).
export function createChunkedStorage(store) {
  async function removeItem(key) {
    const count = Number(await store.getItemAsync(countKey(key))) || 0;
    for (let index = 0; index < count; index += 1) await store.deleteItemAsync(chunkKey(key, index));
    await store.deleteItemAsync(countKey(key));
  }

  return {
    async getItem(key) {
      const count = Number(await store.getItemAsync(countKey(key))) || 0;
      if (!count) return null;
      const parts = [];
      for (let index = 0; index < count; index += 1) {
        const part = await store.getItemAsync(chunkKey(key, index));
        if (part === null || part === undefined) return null;
        parts.push(part);
      }
      return parts.join('');
    },
    async setItem(key, value) {
      await removeItem(key);
      const chunks = splitIntoChunks(value);
      for (let index = 0; index < chunks.length; index += 1) await store.setItemAsync(chunkKey(key, index), chunks[index]);
      await store.setItemAsync(countKey(key), String(chunks.length));
    },
    removeItem,
  };
}