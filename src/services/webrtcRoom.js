// The native ApexFit Live room: peer-to-peer WebRTC audio and video, with Supabase Realtime Broadcast used only
// to pass the setup messages (join, offer, answer, ICE candidates). No third-party video service is involved.
//
// Everything here is plain JavaScript with injected dependencies (signaling channel, RTCPeerConnection factory,
// media devices), so the whole signaling flow is covered by tests that run without a browser.

export const STUN_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
export const MAX_PARTICIPANTS = 6; // a full mesh: every person sends video to every other person
export const SIGNAL_EVENTS = ['join', 'hello', 'offer', 'answer', 'ice-candidate', 'media', 'leave', 'full'];
export const FAILED_DROP_MS = 20_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SDP_LENGTH = 60_000;
const MAX_CANDIDATE_LENGTH = 2_000;
const MAX_NAME_LENGTH = 60;

export function channelTopic(sessionId) {
  return `video-room-${String(sessionId).toLowerCase()}`;
}

// STUN is free and always on. A TURN relay (optional) helps people behind strict firewalls or mobile networks.
export function buildIceServers(env = {}) {
  const servers = [...STUN_SERVERS];
  const urls = String(env.VITE_TURN_URLS || '').split(',').map((url) => url.trim()).filter((url) => /^turns?:[^\s]+$/i.test(url));
  const username = String(env.VITE_TURN_USERNAME || '').trim();
  const credential = String(env.VITE_TURN_CREDENTIAL || '').trim();
  if (urls.length > 0 && username && credential) servers.push({ urls, username, credential });
  return servers;
}

export function newPeerId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
}

// ---------------------------------------------------------------- messages

function cleanName(value) {
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

const isUuid = (value) => typeof value === 'string' && UUID.test(value);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function validDescription(value, expectedType) {
  return isPlainObject(value) && value.type === expectedType && typeof value.sdp === 'string'
    && value.sdp.length > 0 && value.sdp.length <= MAX_SDP_LENGTH;
}

// Anything that arrives from the network is checked here before it can touch a peer connection.
// Returns a clean message, or null when the message is malformed or not meant for this peer.
export function parseSignal(type, payload, selfId) {
  if (!SIGNAL_EVENTS.includes(type) || !isPlainObject(payload)) return null;
  const { from, to } = payload;
  if (!isUuid(from) || from === selfId) return null;
  if (to !== undefined && to !== null && (!isUuid(to) || to !== selfId)) return null;
  const message = { type, from, to: to ?? null };

  switch (type) {
    case 'join':
    case 'hello':
      if (!isUuid(payload.userId)) return null;
      return {
        ...message,
        userId: payload.userId.toLowerCase(),
        name: cleanName(payload.name),
        audio: payload.audio !== false,
        video: payload.video !== false,
        screen: payload.screen === true,
      };
    case 'offer':
    case 'answer':
      if (!message.to || !validDescription(payload.description, type)) return null;
      return { ...message, description: { type, sdp: payload.description.sdp } };
    case 'ice-candidate': {
      if (!message.to) return null;
      if (payload.candidate === null) return { ...message, candidate: null };
      const candidate = payload.candidate;
      if (!isPlainObject(candidate) || typeof candidate.candidate !== 'string' || candidate.candidate.length > MAX_CANDIDATE_LENGTH) return null;
      const { sdpMid, sdpMLineIndex } = candidate;
      if (sdpMid !== null && sdpMid !== undefined && typeof sdpMid !== 'string') return null;
      if (sdpMLineIndex !== null && sdpMLineIndex !== undefined && !Number.isInteger(sdpMLineIndex)) return null;
      return { ...message, candidate: { candidate: candidate.candidate, sdpMid: sdpMid ?? null, sdpMLineIndex: sdpMLineIndex ?? null } };
    }
    case 'media':
      return { ...message, audio: payload.audio !== false, video: payload.video !== false, screen: payload.screen === true };
    case 'full':
      return message.to ? message : null;
    default:
      return message; // leave
  }
}

// ----------------------------------------------------------- media access

export class MediaAccessError extends Error {
  constructor(kind, cause) {
    super(`Media access failed: ${kind}`);
    this.name = 'MediaAccessError';
    this.kind = kind; // 'denied' | 'notFound' | 'inUse' | 'insecure' | 'unsupported' | 'failed'
    this.cause = cause;
  }
}

export const MEDIA_CONSTRAINTS = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: 'user' },
};

export function classifyMediaError(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'notFound';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'inUse';
    default:
      return 'failed';
  }
}

// Asks for camera and microphone. With no camera at all it falls back to audio only, so the call still works.
export async function acquireLocalMedia(mediaDevices, { secureContext = true } = {}) {
  if (!mediaDevices?.getUserMedia) throw new MediaAccessError(secureContext === false ? 'insecure' : 'unsupported');
  try {
    return { stream: await mediaDevices.getUserMedia(MEDIA_CONSTRAINTS), audioOnly: false };
  } catch (error) {
    if (classifyMediaError(error) !== 'notFound') throw new MediaAccessError(classifyMediaError(error), error);
    try {
      return { stream: await mediaDevices.getUserMedia({ audio: MEDIA_CONSTRAINTS.audio }), audioOnly: true };
    } catch (audioError) {
      throw new MediaAccessError(classifyMediaError(audioError), audioError);
    }
  }
}

// ------------------------------------------------------------------- room

export class VideoRoom {
  constructor({
    signaling,
    createPeerConnection,
    iceServers = STUN_SERVERS,
    userId,
    name,
    coachId = null,
    peerId = newPeerId(),
    maxParticipants = MAX_PARTICIPANTS,
    failedDropMs = FAILED_DROP_MS,
    onChange = () => {},
  }) {
    this.signaling = signaling;
    this.createPeerConnection = createPeerConnection;
    this.iceServers = iceServers;
    this.userId = String(userId).toLowerCase();
    this.name = cleanName(name) || 'ApexFit';
    this.coachId = coachId ? String(coachId).toLowerCase() : null;
    this.peerId = peerId;
    this.maxParticipants = maxParticipants;
    this.failedDropMs = failedDropMs;
    this.onChange = onChange;

    this.peers = new Map();
    this.localStream = null;
    this.audioOnly = false;
    this.audioEnabled = true;
    this.videoEnabled = true;
    this.screenStream = null;
    this.phase = 'idle'; // idle → joining → joined → left | error
    this.error = null;
    this.signalingLost = false;
    this.wasSubscribed = false;
  }

  // ---- lifecycle

  async join(localStream, { audioOnly = false } = {}) {
    this.localStream = localStream;
    this.audioOnly = audioOnly;
    if (audioOnly) this.videoEnabled = false;
    this.phase = 'joining';
    this.emit();

    this.signaling.onMessage((type, payload) => this.handleMessage(type, payload));
    this.signaling.onStatus?.((status) => this.handleStatus(status));
    try {
      await this.signaling.connect();
    } catch (error) {
      this.fail(error?.authorization ? 'unauthorized' : 'signaling', error);
      throw error;
    }
    if (this.phase === 'left') return;
    this.phase = 'joined';
    this.wasSubscribed = true;
    this.signaling.send('join', this.selfInfo());
    this.emit();
  }

  async leave() {
    if (this.phase === 'left') return;
    const wasJoined = this.phase === 'joined';
    this.phase = 'left';
    if (wasJoined) {
      try { this.signaling.send('leave', { from: this.peerId }); } catch { /* the channel may already be closed */ }
    }
    for (const id of [...this.peers.keys()]) this.dropPeer(id, { silent: true });
    this.stopScreenTracks();
    this.localStream?.getTracks().forEach((track) => track.stop());
    try { await this.signaling.disconnect(); } catch { /* nothing left to clean up */ }
    this.emit();
  }

  // ---- what the screen shows

  get status() {
    if (this.phase === 'error') return 'error';
    if (this.phase === 'left') return 'left';
    if (this.phase !== 'joined') return 'joining';
    const peers = [...this.peers.values()];
    if (peers.length === 0) return 'waiting';
    return peers.some((peer) => peer.connected) ? 'connected' : 'connecting';
  }

  snapshot() {
    return {
      status: this.status,
      error: this.error,
      signalingLost: this.signalingLost,
      selfId: this.peerId,
      audioEnabled: this.audioEnabled,
      videoEnabled: this.videoEnabled,
      audioOnly: this.audioOnly,
      sharing: Boolean(this.screenStream),
      localStream: this.screenStream || this.localStream,
      peers: [...this.peers.values()].map((peer) => ({
        id: peer.id,
        userId: peer.userId,
        name: peer.name,
        role: peer.role,
        stream: peer.stream,
        connected: peer.connected,
        connectionState: peer.connectionState,
        audio: peer.audio,
        video: peer.video,
        screen: peer.screen,
      })),
    };
  }

  emit() {
    this.onChange(this.snapshot());
  }

  roleOf(userId) {
    return this.coachId && userId === this.coachId ? 'coach' : 'client';
  }

  selfInfo() {
    return {
      from: this.peerId,
      userId: this.userId,
      name: this.name,
      audio: this.audioEnabled,
      video: this.videoEnabled,
      screen: Boolean(this.screenStream),
    };
  }

  fail(kind, cause) {
    this.phase = 'error';
    this.error = { kind, message: String(cause?.message || kind).slice(0, 300) };
    this.emit();
  }

  // ---- controls

  setAudioEnabled(enabled) {
    this.audioEnabled = Boolean(enabled);
    this.localStream?.getAudioTracks().forEach((track) => { track.enabled = this.audioEnabled; });
    this.broadcastMedia();
    this.emit();
  }

  setVideoEnabled(enabled) {
    if (this.audioOnly) return;
    this.videoEnabled = Boolean(enabled);
    this.localStream?.getVideoTracks().forEach((track) => { track.enabled = this.videoEnabled; });
    this.broadcastMedia();
    this.emit();
  }

  // Shows the screen (for example the workout plan or a meal plan) in place of the camera for everyone.
  async startScreenShare(getDisplayMedia) {
    if (this.screenStream) return;
    const stream = await getDisplayMedia({ video: true, audio: false });
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stream.getTracks().forEach((item) => item.stop());
      throw new Error('No screen was shared.');
    }
    this.screenStream = stream;
    track.onended = () => { this.stopScreenShare(); };
    await Promise.all([...this.peers.values()].map((peer) => peer.videoSender?.replaceTrack(track)));
    this.broadcastMedia();
    this.emit();
  }

  async stopScreenShare() {
    if (!this.screenStream) return;
    this.stopScreenTracks();
    const camera = this.localStream?.getVideoTracks()[0] || null;
    await Promise.all([...this.peers.values()].map((peer) => peer.videoSender?.replaceTrack(camera)));
    this.broadcastMedia();
    this.emit();
  }

  stopScreenTracks() {
    if (!this.screenStream) return;
    const stream = this.screenStream;
    this.screenStream = null;
    stream.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
  }

  broadcastMedia() {
    if (this.phase !== 'joined') return;
    this.signaling.send('media', { from: this.peerId, audio: this.audioEnabled, video: this.videoEnabled, screen: Boolean(this.screenStream) });
  }

  // ---- signaling

  handleStatus(status) {
    if (this.phase === 'left') return;
    if (status === 'lost') {
      this.signalingLost = true;
      this.emit();
    } else if (status === 'subscribed' && this.wasSubscribed) {
      // The channel came back: announce ourselves again so people who joined meanwhile find us.
      this.signalingLost = false;
      if (this.phase === 'joined') this.signaling.send('join', this.selfInfo());
      this.emit();
    }
  }

  handleMessage(type, payload) {
    if (this.phase !== 'joined') return;
    const message = parseSignal(type, payload, this.peerId);
    if (!message) return;
    const run = (work) => work.catch((error) => this.handleError(message.from, error));

    switch (message.type) {
      case 'join':
        this.onIntroduction(message, true);
        break;
      case 'hello':
        this.onIntroduction(message, false);
        break;
      case 'offer':
        run(this.onOffer(message));
        break;
      case 'answer':
        run(this.onAnswer(message));
        break;
      case 'ice-candidate':
        run(this.onCandidate(message));
        break;
      case 'media': {
        const peer = this.peers.get(message.from);
        if (peer) {
          Object.assign(peer, { audio: message.audio, video: message.video, screen: message.screen });
          this.emit();
        }
        break;
      }
      case 'leave':
        this.dropPeer(message.from);
        break;
      case 'full':
        this.fail('full', new Error('The room is full.'));
        break;
      default:
    }
  }

  handleError(peerId, error) {
    // One broken peer must not take the call down for everyone else.
    if (typeof console !== 'undefined') console.warn('ApexFit Live: peer error', peerId, error?.message || error);
    this.dropPeer(peerId);
  }

  // Both "join" (a newcomer) and "hello" (an answer to our own join) introduce a person.
  onIntroduction(message, isNewcomer) {
    // A person who reloads comes back with a new id: forget the old, dead connection.
    for (const peer of [...this.peers.values()]) {
      if (peer.userId === message.userId && peer.id !== message.from) this.dropPeer(peer.id);
    }
    const existing = this.peers.get(message.from);
    if (!existing && this.peers.size + 1 >= this.maxParticipants) {
      if (isNewcomer) this.signaling.send('full', { from: this.peerId, to: message.from });
      return;
    }
    const peer = existing || this.createPeer(message.from);
    Object.assign(peer, { userId: message.userId, name: message.name, role: this.roleOf(message.userId), audio: message.audio, video: message.video, screen: message.screen });
    if (isNewcomer) this.signaling.send('hello', { ...this.selfInfo(), to: message.from });
    this.emit();
  }

  // The person with the smaller id starts the negotiation, so two people never send offers at each other at once.
  isInitiator(remoteId) {
    return this.peerId < remoteId;
  }

  createPeer(remoteId) {
    const connection = this.createPeerConnection({ iceServers: this.iceServers });
    const peer = {
      id: remoteId, userId: null, name: '', role: 'client', connection, stream: null, videoSender: null,
      connected: false, connectionState: 'new', audio: true, video: true, screen: false,
      pendingCandidates: [], makingOffer: false, dropTimer: null,
    };
    this.peers.set(remoteId, peer);

    connection.onicecandidate = (event) => {
      const candidate = event.candidate;
      this.signaling.send('ice-candidate', {
        from: this.peerId,
        to: remoteId,
        candidate: candidate
          ? { candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? null, sdpMLineIndex: candidate.sdpMLineIndex ?? null }
          : null,
      });
    };
    connection.ontrack = (event) => {
      const stream = event.streams?.[0];
      if (stream && peer.stream !== stream) peer.stream = stream;
      this.emit();
    };
    connection.onconnectionstatechange = () => this.onConnectionState(peer);
    connection.onnegotiationneeded = () => {
      if (this.isInitiator(remoteId)) this.makeOffer(peer).catch((error) => this.handleError(remoteId, error));
    };

    // The tracks are added after the handlers, so the initiator's "negotiation needed" event starts the offer.
    const screenTrack = this.screenStream?.getVideoTracks()[0] || null;
    for (const track of this.localStream?.getTracks() || []) {
      const sender = connection.addTrack(track, this.localStream);
      if (track.kind === 'video') {
        peer.videoSender = sender;
        if (screenTrack) sender.replaceTrack(screenTrack).catch(() => {});
      }
    }
    return peer;
  }

  async makeOffer(peer) {
    if (peer.makingOffer || peer.connection.signalingState !== 'stable') return;
    peer.makingOffer = true;
    try {
      const offer = await peer.connection.createOffer();
      await peer.connection.setLocalDescription(offer);
      const description = peer.connection.localDescription || offer;
      this.signaling.send('offer', { from: this.peerId, to: peer.id, description: { type: 'offer', sdp: description.sdp } });
    } finally {
      peer.makingOffer = false;
    }
  }

  async onOffer(message) {
    // The offer can overtake the introduction; the peer is then completed when "join" or "hello" arrives.
    let peer = this.peers.get(message.from);
    if (!peer) {
      if (this.peers.size + 1 >= this.maxParticipants) return;
      peer = this.createPeer(message.from);
    }
    const { connection } = peer;
    await connection.setRemoteDescription(message.description);
    await this.flushCandidates(peer);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    const description = connection.localDescription || answer;
    this.signaling.send('answer', { from: this.peerId, to: message.from, description: { type: 'answer', sdp: description.sdp } });
    this.emit();
  }

  async onAnswer(message) {
    const peer = this.peers.get(message.from);
    if (!peer || peer.connection.signalingState !== 'have-local-offer') return;
    await peer.connection.setRemoteDescription(message.description);
    await this.flushCandidates(peer);
  }

  async onCandidate(message) {
    const peer = this.peers.get(message.from);
    if (!peer) return;
    if (!peer.connection.remoteDescription) {
      peer.pendingCandidates.push(message.candidate); // arrived before the offer or answer: keep it for later
      return;
    }
    if (message.candidate) await peer.connection.addIceCandidate(message.candidate);
  }

  async flushCandidates(peer) {
    const queued = peer.pendingCandidates.splice(0);
    for (const candidate of queued) {
      if (candidate) await peer.connection.addIceCandidate(candidate);
    }
  }

  onConnectionState(peer) {
    const state = peer.connection.connectionState || peer.connection.iceConnectionState;
    peer.connectionState = state;
    peer.connected = state === 'connected' || state === 'completed';
    clearTimeout(peer.dropTimer);
    peer.dropTimer = null;

    if (state === 'failed') {
      // The person that started the call tries once to find a new network path; if that fails the tile goes away.
      if (this.isInitiator(peer.id)) peer.connection.restartIce?.();
      peer.dropTimer = setTimeout(() => this.dropPeer(peer.id), this.failedDropMs);
    } else if (state === 'closed') {
      this.dropPeer(peer.id);
      return;
    }
    this.emit();
  }

  dropPeer(peerId, { silent = false } = {}) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    clearTimeout(peer.dropTimer);
    this.peers.delete(peerId);
    peer.connection.onicecandidate = null;
    peer.connection.ontrack = null;
    peer.connection.onconnectionstatechange = null;
    peer.connection.onnegotiationneeded = null;
    try { peer.connection.close(); } catch { /* already closed */ }
    if (!silent) this.emit();
  }
}

// The text key for the connection chip shown in the room.
export function statusKey(snapshot) {
  if (snapshot.status === 'error') return `rmErr_${snapshot.error?.kind || 'failed'}`;
  if (snapshot.signalingLost) return 'rmReconnecting';
  switch (snapshot.status) {
    case 'waiting': return 'rmWaiting';
    case 'connecting': return 'rmConnecting';
    case 'connected': return 'rmConnected';
    default: return 'rmJoining';
  }
}
