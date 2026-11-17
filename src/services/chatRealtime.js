// Live chat updates through Supabase Realtime. Kept apart from the rest of the chat service so it can be tested
// without a Supabase project.

let channelCounter = 0;

// Live updates through Supabase Realtime. Row-level security decides which rows reach this person.
//  - onMessage(row): a message was added where I am the receiver (or the sender, from another device)
//  - onRead(row): a message I sent was marked as read
//  - onStatus('live' | 'offline'): whether the live connection is working
// Returns a function that stops listening.
export function subscribeToChat(client, userId, { onMessage, onRead, onStatus } = {}) {
  channelCounter += 1;
  const table = { schema: 'public', table: 'chat_messages' };
  const channel = client
    .channel(`chat-${userId}-${channelCounter}`)
    .on('postgres_changes', { event: 'INSERT', ...table, filter: `receiver_id=eq.${userId}` }, (payload) => onMessage?.(payload.new))
    .on('postgres_changes', { event: 'INSERT', ...table, filter: `sender_id=eq.${userId}` }, (payload) => onMessage?.(payload.new))
    .on('postgres_changes', { event: 'UPDATE', ...table, filter: `sender_id=eq.${userId}` }, (payload) => onRead?.(payload.new))
    .subscribe((status) => onStatus?.(status === 'SUBSCRIBED' ? 'live' : 'offline'));

  return () => {
    client.removeChannel(channel);
  };
}
