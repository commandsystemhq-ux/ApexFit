import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../services/supabaseClient.js';
import { createSupabaseSignaling } from '../services/roomSignaling.js';
import { MediaAccessError, VideoRoom, acquireLocalMedia, buildIceServers } from '../services/webrtcRoom.js';

const EMPTY = { status: 'joining', error: null, signalingLost: false, selfId: '', audioEnabled: true, videoEnabled: true, audioOnly: false, sharing: false, localStream: null, peers: [] };

// Runs one call: asks for the camera and microphone, joins the session's private signaling channel, and keeps
// the screen in sync with the room. Everything is released again when the component goes away.
export function useVideoRoom({ sessionId, userId, name, coachId }) {
  const [media, setMedia] = useState({ phase: 'asking', error: null });
  const [snapshot, setSnapshot] = useState(EMPTY);
  const [attempt, setAttempt] = useState(0);
  const roomRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let room = null;
    let stream = null;
    setMedia({ phase: 'asking', error: null });
    setSnapshot(EMPTY);

    (async () => {
      let access;
      try {
        access = await acquireLocalMedia(navigator.mediaDevices, { secureContext: window.isSecureContext });
      } catch (error) {
        if (!cancelled) setMedia({ phase: 'error', error: error instanceof MediaAccessError ? error.kind : 'failed' });
        return;
      }
      stream = access.stream;
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      room = new VideoRoom({
        signaling: createSupabaseSignaling(supabase, sessionId),
        createPeerConnection: (config) => new RTCPeerConnection(config),
        iceServers: buildIceServers(import.meta.env),
        userId,
        name,
        coachId,
        onChange: (next) => { if (!cancelled) setSnapshot(next); },
      });
      roomRef.current = room;
      setMedia({ phase: 'ready', error: null });
      try {
        await room.join(stream, { audioOnly: access.audioOnly });
      } catch {
        // The room reports its own error through onChange.
      }
    })();

    const leaveOnUnload = () => { room?.leave(); };
    window.addEventListener('pagehide', leaveOnUnload);
    return () => {
      cancelled = true;
      window.removeEventListener('pagehide', leaveOnUnload);
      if (room) room.leave();
      else stream?.getTracks().forEach((track) => track.stop());
      roomRef.current = null;
    };
  }, [sessionId, userId, name, coachId, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const toggleAudio = useCallback(() => {
    const room = roomRef.current;
    if (room) room.setAudioEnabled(!room.audioEnabled);
  }, []);
  const toggleVideo = useCallback(() => {
    const room = roomRef.current;
    if (room) room.setVideoEnabled(!room.videoEnabled);
  }, []);
  const canShare = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia);
  const toggleShare = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      if (room.screenStream) await room.stopScreenShare();
      else await room.startScreenShare((constraints) => navigator.mediaDevices.getDisplayMedia(constraints));
    } catch {
      // The person closed the browser's screen picker: nothing to do.
    }
  }, []);
  const leave = useCallback(async () => {
    await roomRef.current?.leave();
  }, []);

  return { media, snapshot, retry, toggleAudio, toggleVideo, toggleShare, canShare, leave };
}
