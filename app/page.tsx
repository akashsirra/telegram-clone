"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "./lib/supabase";

type Profile = { id: string; username: string };
type ChatSummary = { chatId: string; otherUser: Profile; lastMessage: string; lastTime: string; unreadCount: number };
type Message = { id: string; sender_id: string; content: string; created_at: string; read?: boolean };
type CallState = "idle" | "calling" | "ringing" | "connected";

const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    // Free public TURN server (openrelay) — needed so calls work across
    // different networks / mobile data / restrictive NATs where STUN alone
    // can't establish a media path. Swap for your own TURN provider for
    // production use, since this one is rate-limited and not guaranteed uptime.
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
};

export default function Home() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [allUsers, setAllUsers] = useState<Profile[]>([]);
  const [showNewChat, setShowNewChat] = useState(false);
  const [activeChat, setActiveChat] = useState<{ chatId: string; otherUser: Profile } | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);

  // Calling state
  const [callState, setCallState] = useState<CallState>("idle");
  const [incomingCall, setIncomingCall] = useState<{ chatId: string; otherUser: Profile } | null>(null);
  const [muted, setMuted] = useState(false);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const signalChannelRef = useRef<any>(null);

  useEffect(() => {
    async function init() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }
      setUserId(user.id);
      await loadChats(user.id);
      setLoading(false);
      listenForIncomingCalls(user.id);
    }
    init();
  }, []);

  async function loadChats(uid: string) {
    const { data: participantRows } = await supabase
      .from("chat_participants")
      .select("chat_id")
      .eq("user_id", uid);

    if (!participantRows || participantRows.length === 0) {
      setChats([]);
      return;
    }

    const chatIds = participantRows.map((r) => r.chat_id);
    const results: ChatSummary[] = [];

    for (const chatId of chatIds) {
      const { data: others } = await supabase
        .from("chat_participants")
        .select("user_id, profiles(id, username)")
        .eq("chat_id", chatId)
        .neq("user_id", uid);

      const otherProfile = others?.[0]?.profiles as unknown as Profile;
      if (!otherProfile) continue;

      const { data: lastMsg } = await supabase
        .from("messages")
        .select("content, created_at")
        .eq("chat_id", chatId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const { count: unreadCount } = await supabase
        .from("messages")
        .select("*", { count: "exact", head: true })
        .eq("chat_id", chatId)
        .eq("read", false)
        .neq("sender_id", uid);

      results.push({
        chatId,
        otherUser: otherProfile,
        lastMessage: lastMsg?.content ?? "Say hi 👋",
        lastTime: lastMsg?.created_at
          ? new Date(lastMsg.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
          : "",
        unreadCount: unreadCount ?? 0,
      });
    }

    setChats(results);
  }

  async function openNewChat() {
    const { data } = await supabase.from("profiles").select("id, username");
    setAllUsers((data ?? []).filter((u) => u.id !== userId));
    setShowNewChat(true);
  }

  async function startChatWith(otherUser: Profile) {
    if (!userId) return;

    const { data: myChats } = await supabase
      .from("chat_participants")
      .select("chat_id")
      .eq("user_id", userId);

    if (myChats && myChats.length > 0) {
      const myChatIds = myChats.map((c) => c.chat_id);
      const { data: sharedChat } = await supabase
        .from("chat_participants")
        .select("chat_id")
        .eq("user_id", otherUser.id)
        .in("chat_id", myChatIds)
        .maybeSingle();

      if (sharedChat) {
        setShowNewChat(false);
        openChat(sharedChat.chat_id, otherUser);
        return;
      }
    }

    const { data: newChat, error } = await supabase
      .from("chats")
      .insert({})
      .select()
      .single();

    if (error || !newChat) {
      alert("Error creating chat: " + error?.message);
      return;
    }

    await supabase.from("chat_participants").insert([
      { chat_id: newChat.id, user_id: userId },
      { chat_id: newChat.id, user_id: otherUser.id },
    ]);

    setShowNewChat(false);
    await loadChats(userId);
    openChat(newChat.id, otherUser);
  }

  async function openChat(chatId: string, otherUser: Profile) {
    setActiveChat({ chatId, otherUser });
    const { data } = await supabase
      .from("messages")
      .select("id, sender_id, content, created_at, read")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: true });
    setMessages(data ?? []);

    if (userId) {
      await supabase
        .from("messages")
        .update({ read: true })
        .eq("chat_id", chatId)
        .neq("sender_id", userId)
        .eq("read", false);
    }

    supabase
      .channel(`messages:${chatId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `chat_id=eq.${chatId}` },
        (payload) => {
          setMessages((prev) => {
            if (prev.some((m) => m.id === payload.new.id)) return prev;
            return [...prev, payload.new as Message];
          });
          if (userId && payload.new.sender_id !== userId) {
            supabase.from("messages").update({ read: true }).eq("id", payload.new.id).then();
          }
        }
      )
      .subscribe();
  }

  async function handleSend() {
    if (!draft.trim() || !activeChat || !userId) return;

    const { error } = await supabase.from("messages").insert({
      chat_id: activeChat.chatId,
      sender_id: userId,
      content: draft.trim(),
      read: false,
    });

    if (!error) {
      setDraft("");
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  function goBackToList() {
    setActiveChat(null);
    if (userId) loadChats(userId);
  }

  // ---------- CALLING LOGIC ----------

  function listenForIncomingCalls(uid: string) {
    const existing = supabase.getChannels().find((ch) => ch.topic === "realtime:incoming-calls");
    if (existing) return;

    supabase
      .channel("incoming-calls")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "call_signals" },
        async (payload) => {
          const signal = payload.new as any;
          if (signal.sender_id === uid) return;
          if (signal.type !== "offer") return;

          const { data: participants } = await supabase
            .from("chat_participants")
            .select("user_id")
            .eq("chat_id", signal.chat_id);

          const isParticipant = participants?.some((p) => p.user_id === uid);
          if (!isParticipant) return;

          const { data: senderProfile } = await supabase
            .from("profiles")
            .select("id, username")
            .eq("id", signal.sender_id)
            .single();

          if (senderProfile) {
            setIncomingCall({ chatId: signal.chat_id, otherUser: senderProfile });
            setCallState("ringing");
            (window as any).__pendingOffer = signal.payload;
          }
        }
      )
      .subscribe();
  }

  async function startCall() {
    if (!activeChat || !userId) return;
    setCallState("calling");

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    localStreamRef.current = stream;
    console.log("[call] local mic tracks:", stream.getAudioTracks());

    const pc = new RTCPeerConnection(RTC_CONFIG);
    pcRef.current = pc;
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    pc.ontrack = (event) => {
      console.log("[call] ontrack fired, remote streams:", event.streams);
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = event.streams[0];
        remoteAudioRef.current.play().catch((err) => console.warn("[call] Audio play blocked:", err));
      } else {
        console.warn("[call] ontrack fired but remoteAudioRef is null!");
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log("[call] ICE connection state:", pc.iceConnectionState);
    };
    pc.onconnectionstatechange = () => {
      console.log("[call] Peer connection state:", pc.connectionState);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log("[call] local ICE candidate type:", event.candidate.type, event.candidate.candidate);
        supabase.from("call_signals").insert({
          chat_id: activeChat.chatId,
          sender_id: userId,
          type: "ice-candidate",
          payload: event.candidate.toJSON(),
        });
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await supabase.from("call_signals").insert({
      chat_id: activeChat.chatId,
      sender_id: userId,
      type: "offer",
      payload: offer,
    });

    listenForAnswer(activeChat.chatId);
  }

  function listenForAnswer(chatId: string) {
    const channel = supabase
      .channel(`call-answer:${chatId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "call_signals", filter: `chat_id=eq.${chatId}` },
        async (payload) => {
          const signal = payload.new as any;
          if (signal.sender_id === userId) return;

          if (signal.type === "answer" && pcRef.current) {
            await pcRef.current.setRemoteDescription(new RTCSessionDescription(signal.payload));
            setCallState("connected");
          }
          if (signal.type === "ice-candidate" && pcRef.current) {
            try {
              await pcRef.current.addIceCandidate(new RTCIceCandidate(signal.payload));
            } catch (e) {}
          }
          if (signal.type === "hangup") {
            endCall();
          }
        }
      )
      .subscribe();
    signalChannelRef.current = channel;
  }

  async function acceptCall() {
    if (!incomingCall || !userId) return;
    const { chatId, otherUser } = incomingCall;
    setActiveChat({ chatId, otherUser });
    setIncomingCall(null);

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    localStreamRef.current = stream;
    console.log("[call] local mic tracks:", stream.getAudioTracks());

    const pc = new RTCPeerConnection(RTC_CONFIG);
    pcRef.current = pc;
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    pc.ontrack = (event) => {
      console.log("[call] ontrack fired, remote streams:", event.streams);
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = event.streams[0];
        remoteAudioRef.current.play().catch((err) => console.warn("[call] Audio play blocked:", err));
      } else {
        console.warn("[call] ontrack fired but remoteAudioRef is null!");
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log("[call] ICE connection state:", pc.iceConnectionState);
    };
    pc.onconnectionstatechange = () => {
      console.log("[call] Peer connection state:", pc.connectionState);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log("[call] local ICE candidate type:", event.candidate.type, event.candidate.candidate);
        supabase.from("call_signals").insert({
          chat_id: chatId,
          sender_id: userId,
          type: "ice-candidate",
          payload: event.candidate.toJSON(),
        });
      }
    };

    const offer = (window as any).__pendingOffer;
    await pc.setRemoteDescription(new RTCSessionDescription(offer));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    await supabase.from("call_signals").insert({
      chat_id: chatId,
      sender_id: userId,
      type: "answer",
      payload: answer,
    });

    setCallState("connected");
    listenForAnswer(chatId);
  }

  function declineCall() {
    setIncomingCall(null);
    setCallState("idle");
  }

  function toggleMute() {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      audioTrack.enabled = !audioTrack.enabled;
      setMuted(!audioTrack.enabled);
    }
  }

  async function endCall() {
    if (activeChat && userId) {
      await supabase.from("call_signals").insert({
        chat_id: activeChat.chatId,
        sender_id: userId,
        type: "hangup",
        payload: {},
      });
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (signalChannelRef.current) {
      supabase.removeChannel(signalChannelRef.current);
      signalChannelRef.current = null;
    }
    setCallState("idle");
    setMuted(false);
  }

  // ---------- RENDER ----------

  // Always mounted so pc.ontrack has a ref to attach the incoming stream to,
  // even if the remote track arrives before callState flips to "connected".
  const remoteAudioEl = <audio ref={remoteAudioRef} autoPlay style={{ display: "none" }} />;

  if (loading) {
    return (
      <>
        {remoteAudioEl}
        <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">Loading...</div>
      </>
    );
  }

  // Incoming call popup (shows over everything)
  if (incomingCall && callState === "ringing") {
    return (
      <>
        {remoteAudioEl}
        <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center gap-6">
          <div className="w-24 h-24 rounded-full bg-blue-600 flex items-center justify-center text-3xl font-bold">
            {incomingCall.otherUser.username.charAt(0).toUpperCase()}
          </div>
          <p className="text-xl font-semibold">{incomingCall.otherUser.username}</p>
          <p className="text-gray-400">Incoming call...</p>
          <div className="flex gap-6 mt-4">
            <button onClick={declineCall} className="bg-red-600 rounded-full w-16 h-16 flex items-center justify-center text-2xl">
              ✕
            </button>
            <button onClick={acceptCall} className="bg-green-600 rounded-full w-16 h-16 flex items-center justify-center text-2xl">
              ✓
            </button>
          </div>
        </div>
      </>
    );
  }

  // Active/outgoing call screen
  if (callState === "calling" || callState === "connected") {
    return (
      <>
        {remoteAudioEl}
        <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center gap-6">
          <div className="w-24 h-24 rounded-full bg-blue-600 flex items-center justify-center text-3xl font-bold">
            {activeChat?.otherUser.username.charAt(0).toUpperCase()}
          </div>
          <p className="text-xl font-semibold">{activeChat?.otherUser.username}</p>
          <p className="text-gray-400">{callState === "calling" ? "Calling..." : "Connected"}</p>
          <div className="flex gap-6 mt-4">
            <button
              onClick={toggleMute}
              className={`rounded-full w-16 h-16 flex items-center justify-center text-xl ${muted ? "bg-gray-600" : "bg-gray-700"}`}
            >
              {muted ? "🔇" : "🎙️"}
            </button>
            <button onClick={endCall} className="bg-red-600 rounded-full w-16 h-16 flex items-center justify-center text-2xl">
              ✕
            </button>
          </div>
        </div>
      </>
    );
  }

  if (activeChat) {
    return (
      <>
        {remoteAudioEl}
        <div className="min-h-screen bg-gray-900 text-white flex flex-col">
          <header className="flex items-center gap-3 px-4 py-3 border-b border-gray-800">
            <button onClick={goBackToList} className="text-blue-400">← Back</button>
            <span className="font-semibold flex-1">{activeChat.otherUser.username}</span>
            <button onClick={startCall} className="bg-green-600 rounded-full w-9 h-9 flex items-center justify-center">
              📞
            </button>
          </header>

          <div className="flex-1 p-4 space-y-3 overflow-y-auto">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`max-w-[70%] px-3 py-2 rounded-lg ${
                  msg.sender_id === userId ? "bg-blue-600 ml-auto" : "bg-gray-800"
                }`}
              >
                <p className="text-sm">{msg.content}</p>
                <span className="text-xs text-gray-300">
                  {new Date(msg.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </span>
              </div>
            ))}
          </div>

          <div className="p-3 border-t border-gray-800 flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSend(); }}
              placeholder="Message"
              className="flex-1 bg-gray-800 rounded-full px-4 py-2 text-sm outline-none"
            />
            <button onClick={handleSend} className="bg-blue-600 rounded-full px-4 py-2 text-sm font-semibold">
              Send
            </button>
          </div>
        </div>
      </>
    );
  }

  if (showNewChat) {
    return (
      <>
        {remoteAudioEl}
        <div className="min-h-screen bg-gray-900 text-white">
          <header className="flex items-center gap-3 px-4 py-3 border-b border-gray-800">
            <button onClick={() => setShowNewChat(false)} className="text-blue-400">← Back</button>
            <span className="font-semibold">New Chat</span>
          </header>
          <ul>
            {allUsers.map((u) => (
              <li
                key={u.id}
                onClick={() => startChatWith(u)}
                className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 hover:bg-gray-800 cursor-pointer"
              >
                <div className="w-12 h-12 rounded-full bg-blue-600 flex items-center justify-center font-semibold">
                  {u.username.charAt(0).toUpperCase()}
                </div>
                <span className="font-semibold">{u.username}</span>
              </li>
            ))}
            {allUsers.length === 0 && (
              <p className="text-gray-400 p-4">No other users yet. Ask a friend to sign up!</p>
            )}
          </ul>
        </div>
      </>
    );
  }

  return (
    <>
      {remoteAudioEl}
      <div className="min-h-screen bg-gray-900 text-white">
        <header className="flex items-center justify-between px-4 py-4 border-b border-gray-800">
          <h1 className="text-2xl font-bold">Telegram Clone</h1>
          <div className="flex gap-3">
            <button onClick={openNewChat} className="bg-blue-600 rounded-full px-3 py-1 text-sm font-semibold">
              + New
            </button>
            <button onClick={handleLogout} className="text-gray-400 text-sm">
              Log out
            </button>
          </div>
        </header>

        <ul>
          {chats.map((chat) => (
            <li
              key={chat.chatId}
              onClick={() => openChat(chat.chatId, chat.otherUser)}
              className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 hover:bg-gray-800 cursor-pointer"
            >
              <div className="w-12 h-12 rounded-full bg-blue-600 flex items-center justify-center font-semibold shrink-0">
                {chat.otherUser.username.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-baseline">
                  <span className="font-semibold truncate">{chat.otherUser.username}</span>
                  <span className="text-xs text-gray-400 shrink-0">{chat.lastTime}</span>
                </div>
                <p className="text-sm text-gray-400 truncate">{chat.lastMessage}</p>
              </div>
              {chat.unreadCount > 0 && (
                <span className="bg-blue-500 text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center shrink-0">
                  {chat.unreadCount}
                </span>
              )}
            </li>
          ))}
          {chats.length === 0 && (
            <p className="text-gray-400 p-4">No chats yet. Tap "+ New" to start one!</p>
          )}
        </ul>
      </div>
    </>
  );
}