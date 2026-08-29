"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "./lib/supabase";

type Profile = { id: string; username: string; avatar_url?: string | null };
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
  const [currentProfile, setCurrentProfile] = useState<Profile | null>(null);
  const [showNewChat, setShowNewChat] = useState(false);
  const [activeChat, setActiveChat] = useState<{ chatId: string; otherUser: Profile } | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [reactionMessageId, setReactionMessageId] = useState<string | null>(null);
  const [messageReactions, setMessageReactions] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());
  const presenceChannelRef = useRef<any>(null);
  const typingChannelRef = useRef<any>(null);
  const messagesChannelRef = useRef<any>(null);
  const [isOtherUserTyping, setIsOtherUserTyping] = useState(false);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [chatTheme, setChatTheme] = useState<"ocean" | "aurora" | "sunset">("ocean");
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [showProfileDrawer, setShowProfileDrawer] = useState(false);

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

      const { data: profile } = await supabase
        .from("profiles")
        .select("id, username, avatar_url")
        .eq("id", user.id)
        .single();

      setCurrentProfile(profile ?? null);

      await loadChats(user.id);
      setLoading(false);
      listenForPresence(user.id);
      listenForIncomingCalls(user.id);
    }
    init();
  }, []);

  function listenForPresence(uid: string) {
    if (presenceChannelRef.current) return;

    const channel = supabase.channel("online-users", {
      config: { presence: { key: uid } },
    });

    const updatePresence = () => {
      const state = channel.presenceState();
      const ids = new Set<string>();

      Object.entries(state).forEach(([key, entries]) => {
        if (key !== uid && entries.length > 0) {
          ids.add(key);
        }
      });

      setOnlineUsers(ids);
    };

    channel
      .on("presence", { event: "sync" }, updatePresence)
      .on("presence", { event: "join" }, updatePresence)
      .on("presence", { event: "leave" }, updatePresence)
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({
            user_id: uid,
            online_at: new Date().toISOString(),
          });
        }
      });

    presenceChannelRef.current = channel;
  }

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
        .select("user_id, profiles(id, username, avatar_url)")
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
    const { data } = await supabase.from("profiles").select("id, username, avatar_url");
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
    setIsOtherUserTyping(false);

    const savedTheme = localStorage.getItem(`chat-theme:${chatId}`);
    if (savedTheme === "ocean" || savedTheme === "aurora" || savedTheme === "sunset") {
      setChatTheme(savedTheme);
    } else {
      setChatTheme("ocean");
    }

    if (typingChannelRef.current) {
      await supabase.removeChannel(typingChannelRef.current);
      typingChannelRef.current = null;
    }

    const typingChannel = supabase
      .channel(`typing:${chatId}`)
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        if (payload?.user_id === userId) return;

        setIsOtherUserTyping(Boolean(payload?.is_typing));

        if (typingTimeoutRef.current) {
          clearTimeout(typingTimeoutRef.current);
        }

        if (payload?.is_typing) {
          typingTimeoutRef.current = setTimeout(() => {
            setIsOtherUserTyping(false);
          }, 2000);
        }
      })
      .subscribe();

    typingChannelRef.current = typingChannel;
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

    if (messagesChannelRef.current) {
      await supabase.removeChannel(messagesChannelRef.current);
      messagesChannelRef.current = null;
    }

    const messagesChannel = supabase
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
      );

    messagesChannelRef.current = messagesChannel;
    await messagesChannel.subscribe();
  }

  function changeChatTheme(theme: "ocean" | "aurora" | "sunset") {
    setChatTheme(theme);

    if (activeChat) {
      localStorage.setItem(`chat-theme:${activeChat.chatId}`, theme);
    }
  }

  async function handleTyping(value: string) {
    setDraft(value);

    if (!activeChat || !userId || !typingChannelRef.current) return;

    await typingChannelRef.current.send({
      type: "broadcast",
      event: "typing",
      payload: {
        user_id: userId,
        is_typing: value.length > 0,
      },
    });

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    if (value.length > 0) {
      typingTimeoutRef.current = setTimeout(async () => {
        if (typingChannelRef.current) {
          await typingChannelRef.current.send({
            type: "broadcast",
            event: "typing",
            payload: {
              user_id: userId,
              is_typing: false,
            },
          });
        }
      }, 1500);
    }
  }

  function chooseReaction(messageId: string, emoji: string) {
    setMessageReactions((prev) => ({
      ...prev,
      [messageId]: prev[messageId] === emoji ? "" : emoji,
    }));
    setReactionMessageId(null);
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

  async function handleAvatarUpload(file: File) {
    if (!userId) return;

    if (!file.type.startsWith("image/")) {
      alert("Please choose an image file.");
      return;
    }

    const extension = file.name.split(".").pop() || "jpg";
    const filePath = `${userId}/avatar.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from("avatars")
      .upload(filePath, file, {
        upsert: true,
        contentType: file.type,
      });

    if (uploadError) {
      alert("Avatar upload failed: " + uploadError.message);
      return;
    }

    const { data } = supabase.storage
      .from("avatars")
      .getPublicUrl(filePath);

    const { error: profileError } = await supabase
      .from("profiles")
      .update({ avatar_url: data.publicUrl })
      .eq("id", userId);

    if (profileError) {
      alert("Profile update failed: " + profileError.message);
      return;
    }

    const { data: updatedProfile } = await supabase
      .from("profiles")
      .select("id, username, avatar_url")
      .eq("id", userId)
      .single();

    setCurrentProfile(updatedProfile ?? null);

    await loadChats(userId);
    alert("Avatar updated! 📸");
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
        <div className={`min-h-screen text-white flex flex-col chat-theme-${chatTheme}`} style={{ backgroundColor: "var(--chat-bg)" }}>
          <header
            className="flex items-center gap-3 px-4 py-3 border-b"
            style={{ backgroundColor: "var(--chat-header)", borderColor: "var(--chat-border)" }}
          >
            <button onClick={goBackToList} className="text-blue-400">← Back</button>

            <div className="flex-1 min-w-0">
              <div className="font-semibold truncate">{activeChat.otherUser.username}</div>
              <div className="flex items-center gap-2 text-xs">
                <span
                  className={`inline-block w-2 h-2 rounded-full ${
                    isOtherUserTyping
                      ? "bg-blue-400 presence-pulse"
                      : onlineUsers.has(activeChat.otherUser.id)
                        ? "bg-green-400 presence-pulse"
                        : "bg-gray-600"
                  }`}
                />
                <span className={
                  isOtherUserTyping
                    ? "text-blue-400"
                    : onlineUsers.has(activeChat.otherUser.id)
                      ? "text-green-400"
                      : "text-gray-500"
                }>
                  {isOtherUserTyping
                    ? "Typing..."
                    : onlineUsers.has(activeChat.otherUser.id)
                      ? "Online"
                      : "Offline"}
                </span>
              </div>
            </div>

            <div className="relative">
              <button
                onClick={() => setShowThemePicker(!showThemePicker)}
                className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-white/10"
              >
                🎨
              </button>

              {showThemePicker && (
                <div
                  className="absolute right-0 top-11 z-50 w-40 rounded-xl p-2 shadow-xl border"
                  style={{
                    backgroundColor: "var(--chat-header)",
                    borderColor: "var(--chat-border)",
                  }}
                >
                  <button
                    onClick={() => {
                      changeChatTheme("ocean");
                      setShowThemePicker(false);
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-white/10"
                  >
                    🌊 Ocean
                  </button>

                  <button
                    onClick={() => {
                      changeChatTheme("aurora");
                      setShowThemePicker(false);
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-white/10"
                  >
                    🌌 Aurora
                  </button>

                  <button
                    onClick={() => {
                      changeChatTheme("sunset");
                      setShowThemePicker(false);
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-white/10"
                  >
                    🌅 Sunset
                  </button>
                </div>
              )}
            </div>

            <button onClick={startCall} className="bg-green-600 rounded-full w-9 h-9 flex items-center justify-center">
              📞
            </button>
          </header>

          <div className="flex-1 p-4 space-y-3 overflow-y-auto" style={{ backgroundColor: "var(--chat-bg)" }}>
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`relative max-w-[70%] px-3 py-2 rounded-lg ${
                  msg.sender_id === userId ? "ml-auto" : ""
                }`}
                style={{
                  backgroundColor: msg.sender_id === userId
                    ? "var(--chat-accent)"
                    : "var(--chat-bubble-other)",
                }}
                onClick={() =>
                  setReactionMessageId(
                    reactionMessageId === msg.id ? null : msg.id
                  )
                }
              >
                {reactionMessageId === msg.id && (
                  <div
                    className={`absolute -top-11 ${
                      msg.sender_id === userId ? "right-0" : "left-0"
                    } z-40 flex items-center gap-1 px-2 py-1.5 rounded-full shadow-2xl border backdrop-blur-md`}
                    style={{
                      backgroundColor: "var(--chat-header)",
                      borderColor: "var(--chat-border)",
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {["❤️", "😂", "🔥", "👍", "😮"].map((emoji) => (
                      <button
                        key={emoji}
                        onClick={() => chooseReaction(msg.id, emoji)}
                        className="w-8 h-8 rounded-full hover:bg-white/10 hover:scale-125 transition-transform text-lg"
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                )}

                <p className="text-sm">{msg.content}</p>

                <div className="flex items-center justify-end gap-1 mt-1">
                  <span className="text-xs text-gray-300">
                    {new Date(msg.created_at).toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                </div>

                {messageReactions[msg.id] && (
                  <div
                    className="absolute -bottom-3 right-2 px-2 py-0.5 rounded-full text-sm border shadow-lg"
                    style={{
                      backgroundColor: "var(--chat-header)",
                      borderColor: "var(--chat-border)",
                    }}
                  >
                    {messageReactions[msg.id]}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="p-3 border-t flex gap-2" style={{ backgroundColor: "var(--chat-header)", borderColor: "var(--chat-border)" }}>
            <input
              value={draft}
              onChange={(e) => handleTyping(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSend(); }}
              placeholder="Message"
              className="flex-1 rounded-full px-4 py-2 text-sm outline-none" style={{ backgroundColor: "var(--chat-input)" }}
            />
            <button onClick={handleSend} className="rounded-full px-4 py-2 text-sm font-semibold" style={{ backgroundColor: "var(--chat-accent)" }}>
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

      {showProfileDrawer && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
          onClick={() => setShowProfileDrawer(false)}
        >
          <aside
            className="absolute left-0 top-0 h-full w-[85%] max-w-sm bg-gray-950 text-white shadow-2xl border-r border-gray-800"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative h-52 bg-gradient-to-br from-blue-700 via-indigo-700 to-purple-800">
              <button
                onClick={() => setShowProfileDrawer(false)}
                className="absolute top-4 right-4 w-9 h-9 rounded-full bg-black/30 hover:bg-black/50 text-xl"
              >
                ×
              </button>

              <div className="absolute -bottom-14 left-6">
                <label className="cursor-pointer block">
                  <div className="w-28 h-28 rounded-full bg-blue-600 border-4 border-gray-950 overflow-hidden flex items-center justify-center text-4xl font-bold shadow-xl">
                    {currentProfile?.avatar_url ? (
                      <img
                        src={`${currentProfile.avatar_url}?t=${Date.now()}`}
                        alt={currentProfile.username}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      currentProfile?.username?.charAt(0).toUpperCase() || "👤"
                    )}
                  </div>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleAvatarUpload(file);
                      e.currentTarget.value = "";
                    }}
                  />
                </label>
              </div>
            </div>

            <div className="pt-20 px-6">
              <h2 className="text-2xl font-bold">
                {currentProfile?.username || "Your Profile"}
              </h2>

              <p className="text-green-400 text-sm mt-1">
                ● Online
              </p>

              <p className="text-gray-500 text-xs mt-1">
                Tap your photo to change it
              </p>

              <div className="mt-8 space-y-3">
                <label className="flex items-center gap-4 p-4 rounded-2xl bg-gray-900 hover:bg-gray-800 cursor-pointer transition">
                  <span className="text-2xl">📸</span>
                  <div>
                    <div className="font-semibold">Change profile photo</div>
                    <div className="text-xs text-gray-500">Choose a new avatar</div>
                  </div>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleAvatarUpload(file);
                      e.currentTarget.value = "";
                    }}
                  />
                </label>

                <button
                  onClick={() => {
                    setShowProfileDrawer(false);
                    setShowThemePicker(true);
                  }}
                  className="w-full flex items-center gap-4 p-4 rounded-2xl bg-gray-900 hover:bg-gray-800 transition text-left"
                >
                  <span className="text-2xl">🎨</span>
                  <div>
                    <div className="font-semibold">Chat appearance</div>
                    <div className="text-xs text-gray-500">Customize your conversation</div>
                  </div>
                </button>

                <button
                  onClick={handleLogout}
                  className="w-full flex items-center gap-4 p-4 rounded-2xl bg-gray-900 hover:bg-red-950 text-left transition"
                >
                  <span className="text-2xl">🚪</span>
                  <div>
                    <div className="font-semibold text-red-400">Log out</div>
                    <div className="text-xs text-gray-500">Sign out of this account</div>
                  </div>
                </button>
              </div>

              <div className="mt-10 text-center text-xs text-gray-600">
                Telegram Clone • Your private space
              </div>
            </div>
          </aside>
        </div>
      )}

      <div className="min-h-screen bg-gray-900 text-white">
        <header className="flex items-center justify-between px-4 py-4 border-b border-gray-800">
          <button
            onClick={() => setShowProfileDrawer(true)}
            className="relative cursor-pointer group"
            aria-label="Open profile"
          >
            <div className="w-11 h-11 rounded-full bg-blue-600 flex items-center justify-center font-bold overflow-hidden ring-2 ring-gray-700 group-hover:ring-blue-400 transition">
              {currentProfile?.avatar_url ? (
                <img
                  src={`${currentProfile.avatar_url}?t=${Date.now()}`}
                  alt={currentProfile.username}
                  className="w-full h-full object-cover"
                />
              ) : (
                <span>
                  {currentProfile?.username?.charAt(0).toUpperCase() || "👤"}
                </span>
              )}
            </div>
            <span className="absolute -bottom-1 -right-1 w-4 h-4 bg-green-500 border-2 border-gray-900 rounded-full" />
          </button>
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
              <div className={`w-12 h-12 rounded-full bg-blue-600 flex items-center justify-center font-semibold shrink-0 overflow-hidden ${
                onlineUsers.has(chat.otherUser.id)
                  ? "online-avatar-ring"
                  : ""
              }`}>
                {chat.otherUser.avatar_url ? (
                  <img
                    src={chat.otherUser.avatar_url}
                    alt={chat.otherUser.username}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  chat.otherUser.username.charAt(0).toUpperCase()
                )}
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