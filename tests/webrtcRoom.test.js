import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseSignaling } from '../src/services/roomSignaling.js';
import {
  MEDIA_CONSTRAINTS, MediaAccessError, SIGNAL_EVENTS, STUN_SERVERS, VideoRoom, acquireLocalMedia, buildIceServers, channelTopic,
  classifyMediaError, parseSignal, statusKey,
} from '../src/services/webrtcRoom.js';
import { supportedLocales, translations } from '../src/i18n/translations.js';

// The signaling flow, the controls and the failure handling of the native room, run against in-memory fakes
// of RTCPeerConnection, the media devices and the signaling channel (no browser needed).

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const wait = (ms = 15) => new Promise((resolve) => { setTimeout(resolve, ms); });
async function until(condition, label = 'condition', timeout = 2000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeout) assert.fail(`Timed out waiting for ${label}`);
    await wait(5);
  }
}

// ----------------------------------------------------------------- fakes

let trackCounter = 0;
class FakeTrack {
  constructor(kind) {
    this.kind = kind;
    this.id = `${kind}-${(trackCounter += 1)}`;
    this.enabled = true;
    this.readyState = 'live';
    this.onended = null;
  }

  stop() {
    this.readyState = 'ended';
  }
}
class FakeStream {
  constructor(tracks) { this.tracks = tracks; }
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
}
const cameraStream = ({ video = true } = {}) => new FakeStream([new FakeTrack('audio'), ...(video ? [new FakeTrack('video')] : [])]);
const screenStream = () => new FakeStream([new FakeTrack('video')]);

class FakeSender {
  constructor(track) { this.track = track; this.history = [track]; }
  async replaceTrack(track) { this.track = track; this.history.push(track); }
}

class FakePeerConnection {
  static all = [];

  constructor(config) {
    this.config = config;
    this.signalingState = 'stable';
    this.connectionState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this.senders = [];
    this.candidatesAdded = [];
    this.restarts = 0;
    this.closed = false;
    this.remoteStream = null;
    this.negotiationQueued = false;
    FakePeerConnection.all.push(this);
  }

  queueNegotiation() {
    if (this.negotiationQueued) return;
    this.negotiationQueued = true;
    setTimeout(() => { this.negotiationQueued = false; this.onnegotiationneeded?.(); }, 0);
  }

  addTrack(track) {
    const sender = new FakeSender(track);
    this.senders.push(sender);
    this.queueNegotiation();
    return sender;
  }

  describe(type) {
    return { type, sdp: JSON.stringify({ restart: this.restarts, tracks: this.senders.map((sender) => ({ kind: sender.track?.kind, id: sender.track?.id })) }) };
  }

  async createOffer() { return this.describe('offer'); }
  async createAnswer() { return this.describe('answer'); }

  async setLocalDescription(description) {
    this.localDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
    setTimeout(() => {
      this.onicecandidate?.({ candidate: { candidate: `candidate:1 1 udp 1 127.0.0.1 5000 typ host ${this.senders.length}`, sdpMid: '0', sdpMLineIndex: 0 } });
      this.onicecandidate?.({ candidate: null });
    }, 0);
    this.maybeConnect();
  }

  async setRemoteDescription(description) {
    if (description.type === 'offer') {
      if (this.signalingState !== 'stable') throw new Error('InvalidStateError: offer while not stable');
      this.signalingState = 'have-remote-offer';
    } else {
      if (this.signalingState !== 'have-local-offer') throw new Error('InvalidStateError: unexpected answer');
      this.signalingState = 'stable';
    }
    this.remoteDescription = description;
    const { tracks } = JSON.parse(description.sdp);
    if (!this.remoteStream && tracks.length > 0) {
      this.remoteStream = new FakeStream(tracks.map((item) => Object.assign(new FakeTrack(item.kind), { id: item.id })));
      for (const track of this.remoteStream.getTracks()) this.ontrack?.({ track, streams: [this.remoteStream] });
    }
    this.maybeConnect();
  }

  async addIceCandidate(candidate) {
    if (!this.remoteDescription) throw new Error('InvalidStateError: no remote description yet');
    this.candidatesAdded.push(candidate);
    this.maybeConnect();
  }

  maybeConnect() {
    if (this.remoteDescription && this.localDescription && this.signalingState === 'stable' && this.candidatesAdded.length > 0 && this.connectionState === 'new') {
      this.setState('connected');
    }
  }

  setState(state) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  restartIce() {
    this.restarts += 1;
    this.queueNegotiation();
  }

  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }
}

class FakeHub {
  constructor() { this.members = new Set(); this.log = []; }

  join(label) {
    const hub = this;
    const member = {
      label, handler: () => {}, statusHandler: () => {}, connected: false, disconnected: false,
      onMessage(fn) { member.handler = fn; },
      onStatus(fn) { member.statusHandler = fn; },
      async connect() { hub.members.add(member); member.connected = true; },
      send(type, payload) {
        hub.log.push({ from: label, type, payload });
        for (const other of hub.members) if (other !== member) setTimeout(() => other.handler(type, JSON.parse(JSON.stringify(payload))), 0);
      },
      async disconnect() { hub.members.delete(member); member.disconnected = true; },
    };
    return member;
  }

  count(type, from) { return this.log.filter((entry) => entry.type === type && (!from || entry.from === from)).length; }
}

function newRoom(hub, label, options = {}) {
  const signaling = options.signaling || hub.join(label);
  const snapshots = [];
  const room = new VideoRoom({
    signaling,
    createPeerConnection: (config) => new FakePeerConnection(config),
    userId: options.userId || id(900 + Number(options.peer)),
    name: options.name || label,
    coachId: options.coachId ?? id(901),
    peerId: id(options.peer),
    maxParticipants: options.max,
    failedDropMs: options.failedDropMs ?? 50,
    onChange: (snapshot) => snapshots.push(snapshot),
  });
  return { room, signaling, snapshots, get last() { return room.snapshot(); } };
}

const connected = (entry, count = 1) => entry.room.snapshot().peers.filter((peer) => peer.connected).length === count;

// --------------------------------------------------------------- messages

test('the signaling topic is the video-room channel of the session', () => {
  assert.equal(channelTopic('ABCDEF12-0000-4000-8000-000000000001'), 'video-room-abcdef12-0000-4000-8000-000000000001');
  assert.deepEqual(SIGNAL_EVENTS, ['join', 'hello', 'offer', 'answer', 'ice-candidate', 'media', 'leave', 'full']);
});

test('only well-formed messages meant for this peer are accepted', () => {
  const me = id(1);
  const them = id(2);
  const base = { from: them, to: me };
  const sdp = (type) => ({ type, sdp: 'v=0' });

  assert.deepEqual(parseSignal('join', { from: them, userId: id(50).toUpperCase(), name: '  <b>Sara</b>\n Ali ', audio: false }, me),
    { type: 'join', from: them, to: null, userId: id(50), name: 'b Sara /b Ali', audio: false, video: true, screen: false });
  assert.equal(parseSignal('offer', { ...base, description: sdp('offer') }, me).description.sdp, 'v=0');
  assert.equal(parseSignal('answer', { ...base, description: sdp('answer') }, me).type, 'answer');
  assert.deepEqual(parseSignal('ice-candidate', { ...base, candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0, extra: 'x' } }, me).candidate, { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 });
  assert.equal(parseSignal('ice-candidate', { ...base, candidate: null }, me).candidate, null);
  assert.equal(parseSignal('leave', { from: them }, me).type, 'leave');

  const rejected = [
    ['offer', { ...base, to: id(3), description: sdp('offer') }],
    ['offer', { from: them, description: sdp('offer') }],
    ['offer', { ...base, description: sdp('answer') }],
    ['offer', { ...base, description: { type: 'offer', sdp: 'x'.repeat(60_001) } }],
    ['offer', { ...base, description: { type: 'offer', sdp: '' } }],
    ['answer', { ...base, description: null }],
    ['ice-candidate', { ...base, candidate: { candidate: 'x'.repeat(2_001) } }],
    ['ice-candidate', { ...base, candidate: { candidate: 5 } }],
    ['ice-candidate', { ...base, candidate: { candidate: 'c', sdpMid: {}, sdpMLineIndex: 0 } }],
    ['ice-candidate', { ...base, candidate: { candidate: 'c', sdpMLineIndex: 1.5 } }],
    ['join', { from: me, userId: id(50), name: 'me' }],
    ['join', { from: 'not-a-uuid', userId: id(50) }],
    ['join', { from: them, userId: 'nope' }],
    ['hello', { from: them }],
    ['full', { from: them }],
    ['teleport', { from: them }],
    ['join', null],
    ['join', 'text'],
    ['join', [1, 2]],
  ];
  for (const [type, payload] of rejected) assert.equal(parseSignal(type, payload, me), null, `${type} ${JSON.stringify(payload).slice(0, 60)}`);
});

// ------------------------------------------------------------- the call

for (const [coachPeer, clientPeer] of [[1, 2], [2, 1]]) {
  test(`two people connect with one offer from the smaller id (coach id ${coachPeer}, client id ${clientPeer})`, async () => {
    const hub = new FakeHub();
    const coach = newRoom(hub, 'coach', { peer: coachPeer, userId: id(901), name: 'Coach Amal', coachId: id(901) });
    const client = newRoom(hub, 'client', { peer: clientPeer, userId: id(902), name: 'Sara Ali', coachId: id(901) });
    const coachStream = cameraStream();
    const clientStream = cameraStream();

    await coach.room.join(coachStream);
    assert.equal(coach.room.status, 'waiting');
    assert.equal(statusKey(coach.last), 'rmWaiting');

    await client.room.join(clientStream);
    await until(() => connected(coach) && connected(client), 'both sides to connect');

    const initiator = coachPeer < clientPeer ? 'coach' : 'client';
    assert.deepEqual([hub.count('offer'), hub.count('offer', initiator), hub.count('answer')], [1, 1, 1], 'exactly one offer, from the smaller id');
    assert.ok(hub.count('ice-candidate', 'coach') > 0 && hub.count('ice-candidate', 'client') > 0, 'both sides sent ICE candidates');
    assert.equal(hub.count('hello'), 1);

    const seenByClient = client.last.peers[0];
    const seenByCoach = coach.last.peers[0];
    assert.deepEqual([seenByClient.name, seenByClient.role, seenByCoach.name, seenByCoach.role], ['Coach Amal', 'coach', 'Sara Ali', 'client']);
    assert.deepEqual(seenByClient.stream.getTracks().map((track) => track.kind).sort(), ['audio', 'video']);
    assert.deepEqual(seenByClient.stream.getTracks().map((track) => track.id).sort(), coachStream.getTracks().map((track) => track.id).sort(), 'the other side receives our tracks');
    assert.equal(statusKey(client.last), 'rmConnected');
    assert.equal(client.last.localStream, clientStream);
    await coach.room.leave();
    await client.room.leave();
  });
}

test('the ICE servers are Google STUN, and a TURN relay only when fully configured', () => {
  assert.deepEqual(STUN_SERVERS, [{ urls: 'stun:stun.l.google.com:19302' }]);
  assert.deepEqual(buildIceServers({}), STUN_SERVERS);
  assert.deepEqual(buildIceServers({ VITE_TURN_URLS: 'turn:t.example.com:3478, turns:t.example.com:5349', VITE_TURN_USERNAME: 'u', VITE_TURN_CREDENTIAL: 'p' }).at(-1),
    { urls: ['turn:t.example.com:3478', 'turns:t.example.com:5349'], username: 'u', credential: 'p' });
  assert.deepEqual(buildIceServers({ VITE_TURN_URLS: 'turn:t.example.com', VITE_TURN_USERNAME: 'u' }), STUN_SERVERS, 'a TURN server needs credentials');
  assert.deepEqual(buildIceServers({ VITE_TURN_URLS: 'http://evil.example.com,javascript:alert(1)', VITE_TURN_USERNAME: 'u', VITE_TURN_CREDENTIAL: 'p' }), STUN_SERVERS);
  const room = newRoom(new FakeHub(), 'x', { peer: 1 }).room;
  assert.deepEqual(room.iceServers, STUN_SERVERS);
});

test('every pair in a group call connects, with one offer per pair', async () => {
  const hub = new FakeHub();
  const rooms = [1, 2, 3].map((peer) => newRoom(hub, `p${peer}`, { peer }));
  for (const entry of rooms) {
    await entry.room.join(cameraStream());
    await wait(10);
  }
  await until(() => rooms.every((entry) => connected(entry, 2)), 'all pairs to connect');
  assert.equal(hub.count('offer'), 3);
  assert.equal(hub.count('answer'), 3);
  assert.ok(rooms.every((entry) => entry.room.status === 'connected' && entry.room.peers.size === 2));
  assert.deepEqual(FakePeerConnection.all.filter((pc) => !pc.closed).length >= 6, true);
  await Promise.all(rooms.map((entry) => entry.room.leave()));
});

test('a room accepts at most the maximum number of people and tells the extra person', async () => {
  const hub = new FakeHub();
  const rooms = [1, 2, 3].map((peer) => newRoom(hub, `p${peer}`, { peer, max: 3 }));
  for (const entry of rooms) {
    await entry.room.join(cameraStream());
    await wait(10);
  }
  await until(() => rooms.every((entry) => connected(entry, 2)), 'the first three to connect');

  const extra = newRoom(hub, 'extra', { peer: 4, max: 3 });
  await extra.room.join(cameraStream());
  await until(() => extra.room.status === 'error', 'the extra person to be turned away');
  assert.equal(extra.room.error.kind, 'full');
  assert.equal(statusKey(extra.last), 'rmErr_full');
  assert.ok(rooms.every((entry) => entry.room.peers.size === 2), 'the people already in the room are unaffected');
  assert.equal(hub.count('offer'), 3, 'no offer was made for the extra person');
  await Promise.all([...rooms, extra].map((entry) => entry.room.leave()));
});

test('ICE candidates that arrive before the offer are kept and applied afterwards', async () => {
  const hub = new FakeHub();
  const client = newRoom(hub, 'client', { peer: 2 });
  await client.room.join(cameraStream());
  const caller = id(1);
  const candidate = { candidate: 'candidate:early', sdpMid: '0', sdpMLineIndex: 0 };

  client.room.handleMessage('hello', { from: caller, to: client.room.peerId, userId: id(901), name: 'Coach' });
  client.room.handleMessage('ice-candidate', { from: caller, to: client.room.peerId, candidate });
  await wait(10);
  const connection = client.room.peers.get(caller).connection;
  assert.deepEqual(connection.candidatesAdded, [], 'nothing is applied without a remote description');

  client.room.handleMessage('offer', { from: caller, to: client.room.peerId, description: { type: 'offer', sdp: JSON.stringify({ tracks: [{ kind: 'audio', id: 'a1' }] }) } });
  await until(() => connection.candidatesAdded.length === 1, 'the early candidate to be applied');
  assert.deepEqual(connection.candidatesAdded[0], candidate);
  assert.equal(hub.count('answer', 'client'), 1);
  await client.room.leave();
});

test('forged, misaddressed and oversized messages are ignored without breaking the call', async () => {
  const hub = new FakeHub();
  const coach = newRoom(hub, 'coach', { peer: 1 });
  const client = newRoom(hub, 'client', { peer: 2 });
  await coach.room.join(cameraStream());
  await client.room.join(cameraStream());
  await until(() => connected(coach) && connected(client), 'the call to start');

  const me = coach.room.peerId;
  const stranger = id(77);
  const before = FakePeerConnection.all.length;
  const attacks = [
    ['offer', { from: stranger, to: id(5), description: { type: 'offer', sdp: '{}' } }],
    ['offer', { from: stranger, to: me, description: { type: 'offer', sdp: 'x'.repeat(70_000) } }],
    ['offer', { from: stranger, to: me, description: { type: 'answer', sdp: '{}' } }],
    ['join', { from: 'zzz', userId: id(5) }],
    ['ice-candidate', { from: stranger, to: me, candidate: { candidate: 'x'.repeat(5_000) } }],
    ['leave', { from: me }],
    ['answer', { from: client.room.peerId, to: me, description: { type: 'answer', sdp: '{}' } }],
    ['nonsense', { from: stranger }],
  ];
  for (const [type, payload] of attacks) coach.room.handleMessage(type, payload);
  await wait(30);

  assert.equal(FakePeerConnection.all.length, before, 'no new peer connection was created');
  assert.equal(coach.room.peers.size, 1);
  assert.equal(coach.room.status, 'connected');
  await coach.room.leave();
  await client.room.leave();
});

// --------------------------------------------------------------- controls

test('mute and camera buttons change the real tracks and tell the other person', async () => {
  const hub = new FakeHub();
  const coach = newRoom(hub, 'coach', { peer: 1 });
  const client = newRoom(hub, 'client', { peer: 2 });
  const coachStream = cameraStream();
  await coach.room.join(coachStream);
  await client.room.join(cameraStream());
  await until(() => connected(coach) && connected(client), 'the call to start');

  coach.room.setAudioEnabled(false);
  assert.equal(coachStream.getAudioTracks()[0].enabled, false);
  assert.equal(coach.room.snapshot().audioEnabled, false);
  await until(() => client.last.peers[0].audio === false, 'the mute to reach the other person');
  assert.equal(client.last.peers[0].video, true);

  coach.room.setAudioEnabled(true);
  await until(() => client.last.peers[0].audio === true, 'the unmute to reach the other person');
  assert.equal(coachStream.getAudioTracks()[0].enabled, true);

  coach.room.setVideoEnabled(false);
  assert.equal(coachStream.getVideoTracks()[0].enabled, false);
  await until(() => client.last.peers[0].video === false, 'the camera-off to reach the other person');
  assert.equal(client.last.peers[0].audio, true);
  coach.room.setVideoEnabled(true);
  assert.equal(coachStream.getVideoTracks()[0].enabled, true);
  assert.equal(hub.count('media', 'coach'), 4);
  await coach.room.leave();
  await client.room.leave();
});

test('without a camera the call is audio only and the camera button does nothing', async () => {
  const hub = new FakeHub();
  const coach = newRoom(hub, 'coach', { peer: 1 });
  const client = newRoom(hub, 'client', { peer: 2 });
  await coach.room.join(cameraStream({ video: false }), { audioOnly: true });
  await client.room.join(cameraStream());
  await until(() => connected(coach) && connected(client), 'the call to start');
  assert.deepEqual([coach.last.audioOnly, coach.last.videoEnabled], [true, false]);
  coach.room.setVideoEnabled(true);
  assert.equal(coach.room.videoEnabled, false);
  assert.deepEqual(client.last.peers[0].stream.getTracks().map((track) => track.kind), ['audio']);
  assert.equal(client.last.peers[0].video, false, 'the other side is told there is no video');
  await coach.room.leave();
  await client.room.leave();
});

test('screen sharing replaces the camera for everyone, also for people who join later, and then restores it', async () => {
  const hub = new FakeHub();
  const coach = newRoom(hub, 'coach', { peer: 1 });
  const client = newRoom(hub, 'client', { peer: 2 });
  const coachStream = cameraStream();
  await coach.room.join(coachStream);
  await client.room.join(cameraStream());
  await until(() => connected(coach) && connected(client), 'the call to start');

  const camera = coachStream.getVideoTracks()[0];
  const display = screenStream();
  const screenTrack = display.getVideoTracks()[0];
  await coach.room.startScreenShare(async (constraints) => {
    assert.deepEqual(constraints, { video: true, audio: false });
    return display;
  });
  const sender = () => coach.room.peers.get(client.room.peerId).videoSender;
  assert.equal(sender().track, screenTrack, 'the other person now receives the screen');
  assert.equal(coach.last.sharing, true);
  assert.equal(coach.last.localStream, display, 'the small preview shows what is shared');
  await until(() => client.last.peers[0].screen === true, 'the share to be announced');

  const third = newRoom(hub, 'third', { peer: 3 });
  await third.room.join(cameraStream());
  await until(() => connected(coach, 2), 'the third person to connect');
  assert.equal(coach.room.peers.get(third.room.peerId).videoSender.track, screenTrack, 'a latecomer sees the screen right away');

  await coach.room.stopScreenShare();
  assert.equal(sender().track, camera);
  assert.equal(coach.room.peers.get(third.room.peerId).videoSender.track, camera);
  assert.equal(screenTrack.readyState, 'ended');
  assert.equal(coach.last.sharing, false);
  assert.equal(coach.last.localStream, coachStream);
  await until(() => client.last.peers[0].screen === false, 'the end of the share to be announced');

  // The browser's own "Stop sharing" bar ends the share too.
  const second = screenStream();
  await coach.room.startScreenShare(async () => second);
  second.getVideoTracks()[0].onended();
  await until(() => coach.last.sharing === false, 'the browser stop button to end the share');
  assert.equal(sender().track, camera);

  await assert.rejects(coach.room.startScreenShare(async () => new FakeStream([])), /No screen was shared/);
  await assert.rejects(coach.room.startScreenShare(async () => { throw new Error('NotAllowedError'); }), /NotAllowedError/);
  assert.equal(coach.last.sharing, false);
  await Promise.all([coach, client, third].map((entry) => entry.room.leave()));
});

// ---------------------------------------------------------- lifecycle

test('leaving tells the others, closes every connection and releases the camera', async () => {
  const hub = new FakeHub();
  const coach = newRoom(hub, 'coach', { peer: 1 });
  const client = newRoom(hub, 'client', { peer: 2 });
  const coachStream = cameraStream();
  await coach.room.join(coachStream);
  await client.room.join(cameraStream());
  await until(() => connected(coach) && connected(client), 'the call to start');
  const connection = client.room.peers.get(coach.room.peerId).connection;
  const display = screenStream();
  await client.room.startScreenShare(async () => display);

  await client.room.leave();
  assert.equal(client.room.status, 'left');
  assert.ok(connection.closed);
  assert.ok(client.signaling.disconnected);
  assert.ok(display.getVideoTracks()[0].readyState === 'ended', 'a shared screen is stopped too');
  assert.ok(client.room.localStream.getTracks().every((track) => track.readyState === 'ended'));
  await until(() => coach.room.peers.size === 0, 'the other side to notice');
  assert.equal(coach.room.status, 'waiting');
  assert.equal(coach.last.peers.length, 0);

  const sent = hub.log.length;
  await client.room.leave();
  assert.equal(hub.log.length, sent, 'leaving twice does nothing');
  await coach.room.leave();
});

test('a person who reloads replaces their old, dead connection instead of showing twice', async () => {
  const hub = new FakeHub();
  const coach = newRoom(hub, 'coach', { peer: 1 });
  const first = newRoom(hub, 'client-old', { peer: 2, userId: id(902) });
  await coach.room.join(cameraStream());
  await first.room.join(cameraStream());
  await until(() => connected(coach) && connected(first), 'the call to start');

  // The old tab vanishes without saying goodbye; the person comes back with a new id.
  hub.members.delete(first.signaling);
  const second = newRoom(hub, 'client-new', { peer: 3, userId: id(902) });
  await second.room.join(cameraStream());
  await until(() => coach.room.peers.size === 1 && coach.room.peers.has(second.room.peerId) && connected(coach), 'the new connection to replace the old');
  assert.equal([...coach.room.peers.keys()].includes(first.room.peerId), false);
  await Promise.all([coach, second].map((entry) => entry.room.leave()));
});

test('a failed network path is retried once by the caller, and the tile goes away only if it stays failed', async () => {
  const hub = new FakeHub();
  const coach = newRoom(hub, 'coach', { peer: 1, failedDropMs: 80 });
  const client = newRoom(hub, 'client', { peer: 2, failedDropMs: 80 });
  await coach.room.join(cameraStream());
  await client.room.join(cameraStream());
  await until(() => connected(coach) && connected(client), 'the call to start');
  const callerConnection = coach.room.peers.get(client.room.peerId).connection;
  const calleeConnection = client.room.peers.get(coach.room.peerId).connection;

  callerConnection.setState('failed');
  calleeConnection.setState('failed');
  assert.deepEqual([callerConnection.restarts, calleeConnection.restarts], [1, 0], 'only the person with the smaller id restarts ICE');
  await until(() => hub.count('offer') === 2, 'the restart offer');
  assert.equal(coach.room.status, 'connecting');

  callerConnection.setState('connected');
  calleeConnection.setState('connected');
  await wait(120);
  assert.equal(coach.room.peers.size, 1, 'a recovered connection is kept');
  assert.equal(statusKey(coach.last), 'rmConnected');

  callerConnection.setState('failed');
  await until(() => coach.room.peers.size === 0, 'the failed peer to be dropped');
  assert.equal(coach.room.status, 'waiting');
  assert.ok(callerConnection.closed);
  await Promise.all([coach.room.leave(), client.room.leave()]);
});

test('losing and regaining the signaling channel is shown and re-announces us', async () => {
  const hub = new FakeHub();
  const coach = newRoom(hub, 'coach', { peer: 1 });
  await coach.room.join(cameraStream());
  assert.equal(hub.count('join', 'coach'), 1);

  coach.signaling.statusHandler('lost');
  assert.equal(coach.last.signalingLost, true);
  assert.equal(statusKey(coach.last), 'rmReconnecting');

  coach.signaling.statusHandler('subscribed');
  assert.equal(coach.last.signalingLost, false);
  assert.equal(hub.count('join', 'coach'), 2, 'people who arrived meanwhile learn about us');
  await coach.room.leave();
  coach.signaling.statusHandler('lost');
  assert.equal(coach.last.status, 'left', 'a closed room ignores late channel news');
});

test('failing to join the signaling channel is reported', async () => {
  const hub = new FakeHub();
  const signaling = hub.join('coach');
  signaling.connect = async () => { throw new Error('channel unavailable'); };
  const entry = newRoom(hub, 'coach', { peer: 1, signaling });
  await assert.rejects(entry.room.join(cameraStream()), /channel unavailable/);
  assert.equal(entry.room.status, 'error');
  assert.equal(statusKey(entry.last), 'rmErr_signaling');
});

test('the status chip text follows the connection', () => {
  const base = { error: null, signalingLost: false };
  assert.equal(statusKey({ ...base, status: 'joining' }), 'rmJoining');
  assert.equal(statusKey({ ...base, status: 'waiting' }), 'rmWaiting');
  assert.equal(statusKey({ ...base, status: 'connecting' }), 'rmConnecting');
  assert.equal(statusKey({ ...base, status: 'connected' }), 'rmConnected');
  assert.equal(statusKey({ ...base, status: 'connected', signalingLost: true }), 'rmReconnecting');
  assert.equal(statusKey({ status: 'error', error: { kind: 'full' } }), 'rmErr_full');
  for (const locale of supportedLocales) {
    for (const key of ['rmJoining', 'rmWaiting', 'rmConnecting', 'rmConnected', 'rmReconnecting', 'rmErr_signaling', 'rmErr_full', 'rmErr_fullHelp', 'rmErr_signalingHelp']) {
      assert.ok(translations[locale][key], `${key} (${locale})`);
    }
  }
  assert.match(translations.ar.rmWaiting, /في انتظار انضمام الطرف الآخر/);
  assert.match(translations.ar.rmConnected, /متصل الآن/);
});

// ----------------------------------------------------------- camera & mic

function devices(behaviour) {
  const calls = [];
  return { calls, getUserMedia: async (constraints) => { calls.push(constraints); return behaviour(constraints, calls.length); } };
}
const domError = (name) => Object.assign(new Error(name), { name });

test('errors from the browser are turned into clear reasons', () => {
  const cases = { NotAllowedError: 'denied', PermissionDeniedError: 'denied', SecurityError: 'denied', NotFoundError: 'notFound', DevicesNotFoundError: 'notFound', NotReadableError: 'inUse', TrackStartError: 'inUse', AbortError: 'inUse', TypeError: 'failed' };
  for (const [name, kind] of Object.entries(cases)) assert.equal(classifyMediaError(domError(name)), kind, name);
  assert.equal(classifyMediaError(null), 'failed');
});

test('camera and microphone are requested together, with audio-only as a fallback', async () => {
  const both = devices(() => cameraStream());
  const ok = await acquireLocalMedia(both);
  assert.equal(ok.audioOnly, false);
  assert.deepEqual(both.calls, [MEDIA_CONSTRAINTS]);
  assert.ok(MEDIA_CONSTRAINTS.audio.echoCancellation && MEDIA_CONSTRAINTS.video.width.ideal === 1280);

  const noCamera = devices((constraints) => {
    if (constraints.video) throw domError('NotFoundError');
    return cameraStream({ video: false });
  });
  const audioOnly = await acquireLocalMedia(noCamera);
  assert.equal(audioOnly.audioOnly, true);
  assert.equal(audioOnly.stream.getVideoTracks().length, 0);
  assert.equal(noCamera.calls.length, 2);

  await assert.rejects(acquireLocalMedia(devices(() => { throw domError('NotFoundError'); })), (error) => error instanceof MediaAccessError && error.kind === 'notFound');
});

test('a refused permission can be retried and then succeeds', async () => {
  let allowed = false;
  const prompt = devices(() => { if (!allowed) throw domError('NotAllowedError'); return cameraStream(); });
  await assert.rejects(acquireLocalMedia(prompt), (error) => error.kind === 'denied');
  assert.equal(prompt.calls.length, 1, 'a refusal is not retried behind the scenes');
  allowed = true;
  assert.equal((await acquireLocalMedia(prompt)).audioOnly, false);

  await assert.rejects(acquireLocalMedia(devices(() => { throw domError('NotReadableError'); })), (error) => error.kind === 'inUse');
  await assert.rejects(acquireLocalMedia(devices(() => { throw new Error('boom'); })), (error) => error.kind === 'failed');
  await assert.rejects(acquireLocalMedia(undefined, { secureContext: false }), (error) => error.kind === 'insecure');
  await assert.rejects(acquireLocalMedia({}, { secureContext: true }), (error) => error.kind === 'unsupported');
  for (const kind of ['denied', 'notFound', 'inUse', 'insecure', 'unsupported', 'failed']) {
    for (const locale of supportedLocales) {
      assert.ok(translations[locale][`rmErr_${kind}`] && translations[locale][`rmErr_${kind}Help`], `${kind} (${locale})`);
    }
  }
  for (const key of ['rmRetry', 'rmMute', 'rmUnmute', 'rmCameraOn', 'rmCameraOff', 'rmShare', 'rmStopShare', 'rmYou', 'rmCoach', 'rmClient', 'lrEndCall']) {
    for (const locale of supportedLocales) assert.ok(translations[locale][key], `${key} (${locale})`);
  }
});

// -------------------------------------------------- Supabase Realtime

class FakeChannel {
  constructor(realtime, topic, options) {
    this.realtime = realtime;
    this.topic = topic;
    this.options = options;
    this.handlers = new Map();
    this.statusCallback = null;
  }

  on(kind, filter, handler) {
    assert.equal(kind, 'broadcast');
    this.handlers.set(filter.event, handler);
    return this;
  }

  subscribe(callback) {
    this.statusCallback = callback;
    if (!this.realtime.holdSubscription) setTimeout(() => callback('SUBSCRIBED'), 0);
    return this;
  }

  async send({ type, event, payload }) {
    assert.equal(type, 'broadcast');
    this.realtime.sent.push({ topic: this.topic, event, payload });
    for (const other of this.realtime.channels) {
      if (other !== this && other.topic === this.topic && other.handlers.has(event)) {
        setTimeout(() => other.handlers.get(event)({ event, payload: JSON.parse(JSON.stringify(payload)) }), 0);
      }
    }
    return 'ok';
  }
}
class FakeRealtime {
  constructor() { this.channels = []; this.removed = []; this.sent = []; this.holdSubscription = false; }
  channel(topic, options) {
    const channel = new FakeChannel(this, topic, options);
    this.channels.push(channel);
    return channel;
  }

  async removeChannel(channel) {
    this.removed.push(channel);
    this.channels = this.channels.filter((item) => item !== channel);
  }
}

test('signaling uses a private broadcast channel per session and relays every event', async () => {
  const realtime = new FakeRealtime();
  const sessionId = 'ABCDEF12-0000-4000-8000-000000000009';
  const signaling = createSupabaseSignaling(realtime, sessionId);
  const received = [];
  signaling.onMessage((type, payload) => received.push([type, payload]));
  await signaling.connect();

  const [channel] = realtime.channels;
  assert.equal(signaling.topic, 'video-room-abcdef12-0000-4000-8000-000000000009');
  assert.equal(channel.topic, signaling.topic);
  assert.equal(channel.options.config.private, true, 'the channel is private, so row-level security applies');
  assert.equal(channel.options.config.broadcast.self, false);
  assert.deepEqual([...channel.handlers.keys()].sort(), [...SIGNAL_EVENTS].sort());

  channel.handlers.get('offer')({ payload: { hello: 1 } });
  channel.handlers.get('ice-candidate')({ payload: { c: 2 } });
  assert.deepEqual(received, [['offer', { hello: 1 }], ['ice-candidate', { c: 2 }]]);

  assert.equal(await signaling.send('join', { a: 1 }), 'ok');
  assert.deepEqual(realtime.sent, [{ topic: signaling.topic, event: 'join', payload: { a: 1 } }]);

  await signaling.disconnect();
  assert.equal(realtime.removed.length, 1);
  channel.handlers.get('offer')({ payload: { late: true } });
  assert.equal(received.length, 2, 'messages after leaving are ignored');
  assert.equal(await signaling.send('join', {}), 'error', 'nothing is sent after leaving');
});

test('joining fails clearly on channel errors and timeouts, and later drops are reported as lost', async () => {
  const failing = new FakeRealtime();
  failing.channel = (topic, options) => {
    const channel = new FakeChannel(failing, topic, options);
    channel.subscribe = (callback) => { setTimeout(() => callback('CHANNEL_ERROR', new Error('not authorized')), 0); return channel; };
    failing.channels.push(channel);
    return channel;
  };
  await assert.rejects(createSupabaseSignaling(failing, id(1)).connect(), /not authorized/);

  const silent = new FakeRealtime();
  silent.holdSubscription = true;
  await assert.rejects(createSupabaseSignaling(silent, id(1), { timeoutMs: 20 }).connect(), /Timed out/);

  const realtime = new FakeRealtime();
  const signaling = createSupabaseSignaling(realtime, id(1));
  const statuses = [];
  signaling.onStatus((status) => statuses.push(status));
  await signaling.connect();
  const [channel] = realtime.channels;
  channel.statusCallback('CLOSED');
  channel.statusCallback('SUBSCRIBED');
  channel.statusCallback('TIMED_OUT');
  assert.deepEqual(statuses, ['subscribed', 'lost', 'subscribed', 'lost']);
});

test('two rooms connect end to end over the Supabase broadcast adapter', async () => {
  const realtime = new FakeRealtime();
  const sessionId = id(321);
  const make = (peer, label, userId) => newRoom(null, label, { peer, userId, name: label, coachId: id(901), signaling: createSupabaseSignaling(realtime, sessionId) });
  const coach = make(1, 'Coach', id(901));
  const client = make(2, 'Client', id(902));
  await coach.room.join(cameraStream());
  await client.room.join(cameraStream());
  await until(() => connected(coach) && connected(client), 'the call to start through the adapter');

  const events = realtime.sent.map((entry) => entry.event);
  for (const expected of ['join', 'hello', 'offer', 'answer', 'ice-candidate']) assert.ok(events.includes(expected), expected);
  assert.ok(realtime.sent.every((entry) => entry.topic === `video-room-${sessionId}`));
  assert.deepEqual([client.last.peers[0].role, coach.last.peers[0].role], ['coach', 'client']);

  // A different session never hears this room.
  const other = createSupabaseSignaling(realtime, id(322));
  const heard = [];
  other.onMessage((type) => heard.push(type));
  await other.connect();
  coach.room.setAudioEnabled(false);
  await wait(30);
  assert.deepEqual(heard, []);
  await coach.room.leave();
  await client.room.leave();
  assert.equal(realtime.channels.filter((channel) => channel.topic === `video-room-${sessionId}`).length, 0, 'both channels were removed');
});
