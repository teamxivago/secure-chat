import { io, type Socket } from "socket.io-client";
import { directChatId, type EventPayload } from "@veil/shared";
import { haptic } from "../lib/native";
import { bus } from "./bus";
import { ctx } from "./context";
import { encryptToDevice } from "./direct";
import { sendMessage } from "./messages";
import { handleEnvelope } from "./receive";
import { trace } from "../lib/trace";

/**
 * WebRTC calling. Media is peer-to-peer DTLS-SRTP (mandatory in WebRTC). Signaling (SDP, ICE)
 * is end-to-end encrypted: every blob is a sealed-sender Double Ratchet message to the specific
 * peer device, relayed by call-signaling. Group calls use a full mesh where existing participants
 * send offers to each newcomer.
 */

export type CallStatus = "idle" | "outgoing" | "incoming" | "connecting" | "connected" | "ended";

export interface RemotePeer {
  key: string;
  userId: string;
  deviceId: string;
  stream: MediaStream | null;
  muted: boolean;
  video: boolean;
  hold: boolean;
  screen: boolean;
  state: RTCPeerConnectionState | "new";
}

export interface CallState {
  status: CallStatus;
  callId: string | null;
  chatId: string | null;
  peerUserId: string | null;
  group: boolean;
  video: boolean;
  title: string;
  incomingFrom?: { userId: string; deviceId: string };
  startedAt: number | null;
  connectedAt: number | null;
  localStream: MediaStream | null;
  muted: boolean;
  cameraOn: boolean;
  facing: "user" | "environment";
  screenSharing: boolean;
  onHold: boolean;
  speaker: boolean;
  minimized: boolean;
  peers: RemotePeer[];
  endedReason?: string;
}

const initial: CallState = {
  status: "idle",
  callId: null,
  chatId: null,
  peerUserId: null,
  group: false,
  video: false,
  title: "",
  startedAt: null,
  connectedAt: null,
  localStream: null,
  muted: false,
  cameraOn: false,
  facing: "user",
  screenSharing: false,
  onHold: false,
  speaker: false,
  minimized: false,
  peers: [],
};

let state: CallState = { ...initial };
const listeners = new Set<() => void>();
const pcs = new Map<string, RTCPeerConnection>();
const pendingIce = new Map<string, RTCIceCandidateInit[]>();
let iceServers: RTCIceServer[] = [];
let socket: Socket | null = null;
let initiator = false;
let ringtone: { stop: () => void } | null = null;
let cameraTrack: MediaStreamTrack | null = null;
const loggedCalls = new Set<string>();

export const callStore = {
  get: () => state,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

function set(patch: Partial<CallState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function setPeer(key: string, patch: Partial<RemotePeer>) {
  const peers = state.peers.some((p) => p.key === key)
    ? state.peers.map((p) => (p.key === key ? { ...p, ...patch } : p))
    : [...state.peers, { key, userId: "", deviceId: "", stream: null, muted: false, video: false, hold: false, screen: false, state: "new" as const, ...patch }];
  set({ peers });
}

/* ------------------------------ socket ------------------------------ */

function ensureSocket(): Socket {
  if (socket) return socket;
  socket = io(ctx.config!.callWsUrl, { auth: (cb) => cb({ token: ctx.account?.token }), transports: ["websocket"] });
  socket.on("call:incoming", (d: { callId: string; fromUserId: string; fromDeviceId: string; video: boolean; group: boolean; chatId: string | null; title: string }) => {
    if (state.status !== "idle" && state.status !== "ended") {
      socket!.emit("call:decline", { callId: d.callId, busy: true });
      return;
    }
    initiator = false;
    set({
      ...initial,
      status: "incoming",
      callId: d.callId,
      chatId: d.chatId ?? directChatId(d.fromUserId),
      peerUserId: d.group ? null : d.fromUserId,
      group: d.group,
      video: d.video,
      title: d.title,
      incomingFrom: { userId: d.fromUserId, deviceId: d.fromDeviceId },
      startedAt: Date.now(),
    });
    socket!.emit("call:ringing", { callId: d.callId });
    ringtone = playTone("ring");
    void haptic("medium");
  });
  socket.on("call:ringing", () => {
    if (state.status === "outgoing") {
      ringtone?.stop();
      ringtone = playTone("ringback");
    }
  });
  socket.on("call:participant", async (d: { callId: string; userId: string; deviceId: string; state: "joined" | "left" }) => {
    trace("call:participant", d.state);
    if (d.callId !== state.callId) return;
    const key = `${d.userId}.${d.deviceId}`;
    if (d.state === "left") {
      closePeer(key);
      return;
    }
    if (d.userId === ctx.userId && d.deviceId === ctx.deviceId) return;
    // Existing participants offer to newcomers.
    ringtone?.stop();
    if (state.status === "outgoing") set({ status: "connecting" });
    await createOffer(d.userId, d.deviceId);
  });
  socket.on("call:signal", async (d: { callId: string; fromUserId: string; fromDeviceId: string; payload: string }) => {
    if (d.callId !== state.callId) return;
    await handleEnvelope({ id: `call-${Date.now()}`, type: 6, content: d.payload, ts: Date.now(), sealed: true, ephemeral: true });
  });
  socket.on("call:state", (d: { callId: string; userId: string; deviceId: string; muted?: boolean; video?: boolean; hold?: boolean; screen?: boolean }) => {
    if (d.callId !== state.callId) return;
    const patch: Partial<RemotePeer> = {};
    if (d.muted !== undefined) patch.muted = d.muted;
    if (d.video !== undefined) patch.video = d.video;
    if (d.hold !== undefined) patch.hold = d.hold;
    if (d.screen !== undefined) patch.screen = d.screen;
    setPeer(`${d.userId}.${d.deviceId}`, patch);
  });
  socket.on("call:answeredElsewhere", (d: { callId: string }) => {
    if (d.callId === state.callId && state.status === "incoming") cleanup("answered on another device");
  });
  socket.on("call:ended", (d: { callId: string; reason: string; duration: number }) => {
    if (d.callId !== state.callId) return;
    void logCall(d.reason, d.duration);
    cleanup(d.reason);
  });
  return socket;
}

export function initCalls() {
  if (ctx.active && ctx.config) ensureSocket();
  bus.on("call:event", (ev) => {
    if (ev.type === "signal") void onSignal(ev.data as Extract<EventPayload, { kind: "call" }> & { fromUserId: string; fromDeviceId: string });
  });
}

/* ------------------------------ media ------------------------------ */

async function getMedia(video: boolean, facing: "user" | "environment" = "user") {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: video ? { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } } : false,
  });
}

function emitState(patch: { muted?: boolean; video?: boolean; hold?: boolean; screen?: boolean }) {
  if (state.callId) socket?.emit("call:state", { callId: state.callId, ...patch });
}

/* ------------------------------ peer connections ------------------------------ */

async function signal(userId: string, deviceId: string, body: Omit<Extract<EventPayload, { kind: "call" }>, "kind" | "callId" | "chatId" | "ts">) {
  if (!state.callId) return;
  const payload: EventPayload = { kind: "call", callId: state.callId, chatId: state.chatId ?? "", ts: Date.now(), ...body };
  const sealed = await encryptToDevice(userId, deviceId, payload);
  socket?.emit("call:signal", { callId: state.callId, toUserId: userId, toDeviceId: deviceId, payload: sealed });
}

function peerConnection(userId: string, deviceId: string): RTCPeerConnection {
  const key = `${userId}.${deviceId}`;
  const existing = pcs.get(key);
  if (existing) return existing;
  const pc = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" });
  pcs.set(key, pc);
  setPeer(key, { userId, deviceId, video: state.video });
  for (const t of state.localStream?.getTracks() ?? []) pc.addTrack(t, state.localStream!);
  pc.onicecandidate = (e) => {
    if (e.candidate) void signal(userId, deviceId, { action: "ice", candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex });
  };
  pc.ontrack = (e) => setPeer(key, { stream: e.streams[0] ?? new MediaStream([e.track]) });
  pc.onconnectionstatechange = () => {
    trace("call:pc", pc.connectionState);
    setPeer(key, { state: pc.connectionState });
    if (pc.connectionState === "connected" && state.status !== "connected") {
      ringtone?.stop();
      set({ status: "connected", connectedAt: state.connectedAt ?? Date.now() });
      void haptic("heavy");
    }
    if (pc.connectionState === "failed") void pc.restartIce?.();
  };
  return pc;
}

async function createOffer(userId: string, deviceId: string) {
  trace("call:createOffer", deviceId);
  const pc = peerConnection(userId, deviceId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await signal(userId, deviceId, { action: "offer", sdp: offer.sdp, video: state.video });
}

async function flushIce(key: string, pc: RTCPeerConnection) {
  for (const c of pendingIce.get(key) ?? []) await pc.addIceCandidate(c).catch(() => {});
  pendingIce.delete(key);
}

async function onSignal(e: Extract<EventPayload, { kind: "call" }> & { fromUserId: string; fromDeviceId: string }) {
  if (e.callId !== state.callId) return;
  const key = `${e.fromUserId}.${e.fromDeviceId}`;
  trace(`call:signal:${e.action}`, state.status);
  if (e.action === "offer" && e.sdp) {
    if (state.status === "incoming") return; // we haven't accepted on this device
    const pc = peerConnection(e.fromUserId, e.fromDeviceId);
    await pc.setRemoteDescription({ type: "offer", sdp: e.sdp });
    await flushIce(key, pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await signal(e.fromUserId, e.fromDeviceId, { action: "answer", sdp: answer.sdp });
  } else if (e.action === "answer" && e.sdp) {
    const pc = pcs.get(key);
    if (pc && pc.signalingState === "have-local-offer") {
      await pc.setRemoteDescription({ type: "answer", sdp: e.sdp });
      await flushIce(key, pc);
    }
  } else if (e.action === "ice" && e.candidate) {
    const c: RTCIceCandidateInit = { candidate: e.candidate, sdpMid: e.sdpMid ?? undefined, sdpMLineIndex: e.sdpMLineIndex ?? undefined };
    const pc = pcs.get(key);
    if (pc?.remoteDescription) await pc.addIceCandidate(c).catch(() => {});
    else pendingIce.set(key, [...(pendingIce.get(key) ?? []), c]);
  }
}

function closePeer(key: string) {
  pcs.get(key)?.close();
  pcs.delete(key);
  set({ peers: state.peers.filter((p) => p.key !== key) });
  if (!state.group && state.status !== "idle") cleanup("completed");
}

/* ------------------------------ public API ------------------------------ */

export async function startCall(target: { userId: string } | { chatId: string }, video: boolean, title: string) {
  if (state.status !== "idle" && state.status !== "ended") throw new Error("Already in a call");
  const s = ensureSocket();
  const localStream = await getMedia(video);
  cameraTrack = localStream.getVideoTracks()[0] ?? null;
  const callId = crypto.randomUUID();
  initiator = true;
  const chatId = "userId" in target ? directChatId(target.userId) : target.chatId;
  set({
    ...initial,
    status: "outgoing",
    callId,
    chatId,
    peerUserId: "userId" in target ? target.userId : null,
    group: "chatId" in target,
    video,
    title,
    localStream,
    cameraOn: video,
    speaker: video,
    startedAt: Date.now(),
  });
  const r = await new Promise<{ ok: boolean; error?: string; iceServers?: RTCIceServer[] }>((res) =>
    s.emit("call:start", { callId, video, ...("userId" in target ? { peerUserId: target.userId } : { chatId: target.chatId }) }, res),
  );
  if (!r.ok) {
    cleanup(r.error ?? "failed");
    if (r.error === "busy" && "userId" in target) await logCall("busy", 0);
    throw new Error(r.error === "busy" ? "User is busy on another call" : (r.error ?? "Call failed"));
  }
  iceServers = r.iceServers ?? [];
  void haptic("medium");
}

export async function acceptCall() {
  if (state.status !== "incoming" || !state.callId) return;
  ringtone?.stop();
  const localStream = await getMedia(state.video);
  cameraTrack = localStream.getVideoTracks()[0] ?? null;
  set({ status: "connecting", localStream, cameraOn: state.video, speaker: state.video });
  const r = await new Promise<{ ok: boolean; error?: string; iceServers?: RTCIceServer[] }>((res) => socket!.emit("call:accept", { callId: state.callId }, res));
  if (!r.ok) {
    cleanup(r.error ?? "failed");
    return;
  }
  iceServers = r.iceServers ?? [];
  void haptic("heavy");
}

export function declineCall() {
  if (!state.callId) return;
  socket?.emit("call:decline", { callId: state.callId });
  cleanup("declined");
}

export function hangUp() {
  if (!state.callId) return;
  socket?.emit("call:hangup", { callId: state.callId });
  const duration = state.connectedAt ? (Date.now() - state.connectedAt) / 1000 : 0;
  if (initiator && !state.group) void logCall(state.connectedAt ? "completed" : "cancelled", duration);
  cleanup("completed");
}

export function toggleMute() {
  const muted = !state.muted;
  state.localStream?.getAudioTracks().forEach((t) => (t.enabled = !muted && !state.onHold));
  set({ muted });
  emitState({ muted });
  void haptic("light");
}

export async function toggleCamera() {
  let cameraOn = !state.cameraOn;
  if (cameraOn && !cameraTrack) {
    try {
      const s = await getMedia(true, state.facing);
      cameraTrack = s.getVideoTracks()[0];
      s.getAudioTracks().forEach((t) => t.stop());
      state.localStream?.addTrack(cameraTrack);
      for (const pc of pcs.values()) pc.addTrack(cameraTrack, state.localStream!);
      for (const [key, pc] of pcs) await renegotiate(key, pc);
    } catch {
      cameraOn = false;
    }
  }
  if (cameraTrack) cameraTrack.enabled = cameraOn;
  set({ cameraOn, video: state.video || cameraOn });
  emitState({ video: cameraOn });
  void haptic("light");
}

async function renegotiate(key: string, pc: RTCPeerConnection) {
  const [userId, deviceId] = [key.slice(0, key.lastIndexOf(".")), key.slice(key.lastIndexOf(".") + 1)];
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await signal(userId, deviceId, { action: "offer", sdp: offer.sdp, video: true });
}

async function replaceVideoTrack(track: MediaStreamTrack) {
  for (const pc of pcs.values()) {
    const sender = pc.getSenders().find((s) => s.track?.kind === "video");
    await sender?.replaceTrack(track);
  }
}

export async function switchCamera() {
  if (!cameraTrack) return;
  const facing = state.facing === "user" ? "environment" : "user";
  const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } });
  const track = s.getVideoTracks()[0];
  await replaceVideoTrack(track);
  cameraTrack.stop();
  state.localStream?.removeTrack(cameraTrack);
  state.localStream?.addTrack(track);
  cameraTrack = track;
  set({ facing, localStream: state.localStream });
  void haptic("light");
}

export async function toggleScreenShare() {
  if (state.screenSharing) {
    if (cameraTrack) await replaceVideoTrack(cameraTrack);
    set({ screenSharing: false });
    emitState({ screen: false });
    return;
  }
  const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  const track = display.getVideoTracks()[0];
  const hasVideoSender = [...pcs.values()].some((pc) => pc.getSenders().some((s) => s.track?.kind === "video"));
  if (!hasVideoSender) {
    for (const [key, pc] of pcs) {
      pc.addTrack(track, display);
      await renegotiate(key, pc);
    }
  } else await replaceVideoTrack(track);
  track.onended = () => void (state.screenSharing && toggleScreenShare());
  set({ screenSharing: true, video: true });
  emitState({ screen: true });
}

export function toggleHold() {
  const onHold = !state.onHold;
  state.localStream?.getTracks().forEach((t) => (t.enabled = !onHold && (t.kind === "audio" ? !state.muted : state.cameraOn)));
  set({ onHold });
  emitState({ hold: onHold });
  void haptic("medium");
}

export function toggleSpeaker() {
  set({ speaker: !state.speaker });
  void haptic("light");
}

export function setMinimized(minimized: boolean) {
  set({ minimized });
}

/* ------------------------------ teardown / history ------------------------------ */

async function logCall(reason: string, duration: number) {
  if (!initiator || state.group || !state.chatId || !state.callId) return;
  // Hang-up and the server's call:ended both report the outcome; log once.
  if (loggedCalls.has(state.callId)) return;
  loggedCalls.add(state.callId);
  const outcome = (["completed", "missed", "declined", "cancelled", "busy"].includes(reason) ? reason : "completed") as "completed";
  await sendMessage(state.chatId, { t: "call", callId: state.callId, video: state.video, outcome, duration: Math.round(duration) }).catch(() => {});
}

function cleanup(reason: string) {
  ringtone?.stop();
  ringtone = null;
  for (const pc of pcs.values()) pc.close();
  pcs.clear();
  pendingIce.clear();
  state.localStream?.getTracks().forEach((t) => t.stop());
  cameraTrack = null;
  const wasActive = state.status === "connected";
  set({ status: "ended", endedReason: reason, localStream: null, peers: [] });
  if (wasActive) void haptic("medium");
  setTimeout(() => {
    if (state.status === "ended") set({ ...initial });
  }, 1500);
}

/* ------------------------------ tones (WebAudio, no assets) ------------------------------ */

function playTone(kind: "ring" | "ringback"): { stop: () => void } {
  try {
    const ac = new AudioContext();
    let stopped = false;
    const beep = () => {
      if (stopped) return;
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.frequency.value = kind === "ring" ? 880 : 440;
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(kind === "ring" ? 0.25 : 0.12, ac.currentTime + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + (kind === "ring" ? 0.9 : 1.6));
      o.connect(g).connect(ac.destination);
      o.start();
      o.stop(ac.currentTime + 1.7);
    };
    beep();
    const t = setInterval(beep, kind === "ring" ? 1500 : 4000);
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        clearInterval(t);
        if (ac.state !== "closed") void ac.close().catch(() => {});
      },
    };
  } catch {
    return { stop: () => {} };
  }
}
