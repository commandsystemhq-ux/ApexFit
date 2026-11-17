import { SIGNAL_EVENTS, channelTopic } from './webrtcRoom.js';

// Realtime answers "Unauthorized: You do not have permissions to read from this Channel topic" when the access
// policies (migration 20261115001300) are missing or refuse the user.
export function isAuthorizationFailure(error) {
  return /unauthori[sz]ed|not authori[sz]ed|permission|forbidden|row-level security|policy/i.test(String(error?.message ?? error ?? ''));
}

// Carries the WebRTC setup messages over a *private* Supabase Realtime Broadcast channel. Row-level security on
// realtime.messages (see migration 20261115001300) lets only the people a session is for listen or send.
export function createSupabaseSignaling(client, sessionId, { timeoutMs = 15_000 } = {}) {
  const topic = channelTopic(sessionId);
  let channel = null;
  let messageHandler = () => {};
  let statusHandler = () => {};
  let opened = false;

  return {
    topic,

    onMessage(handler) {
      messageHandler = handler;
    },

    onStatus(handler) {
      statusHandler = handler;
    },

    connect() {
      return new Promise((resolve, reject) => {
        channel = client.channel(topic, { config: { private: true, broadcast: { self: false, ack: false } } });
        for (const event of SIGNAL_EVENTS) {
          channel.on('broadcast', { event }, ({ payload }) => messageHandler(event, payload));
        }
        const timer = setTimeout(() => reject(new Error('Timed out while joining the room.')), timeoutMs);
        channel.subscribe((status, error) => {
          if (status === 'SUBSCRIBED') {
            clearTimeout(timer);
            statusHandler('subscribed');
            if (!opened) {
              opened = true;
              resolve();
            }
          } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
            clearTimeout(timer);
            if (!opened) {
              const reason = error instanceof Error ? error : new Error(typeof error === 'string' && error ? error : error?.message || `Could not join the room (${status}).`);
              reason.status = status;
              reason.authorization = isAuthorizationFailure(reason);
              reject(reason);
            }
            else statusHandler('lost');
          }
        });
      });
    },

    send(event, payload) {
      if (!channel) return Promise.resolve('error');
      return channel.send({ type: 'broadcast', event, payload });
    },

    async disconnect() {
      const current = channel;
      channel = null;
      messageHandler = () => {};
      statusHandler = () => {};
      if (current) await client.removeChannel(current);
    },
  };
}
