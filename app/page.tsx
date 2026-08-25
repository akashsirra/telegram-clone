
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "./lib/supabase";

type Profile = { id: string; username: string };
type ChatSummary = { chatId: string; otherUser: Profile; lastMessage: string; lastTime: string; unreadCount: number };
type Message = { id: string; sender_id: string; content: string; created_at: string; read?: boolean };

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

    // Mark incoming messages as read
    if (userId) {
      await supabase
        .from("messages")
        .update({ read: true })
        .eq("chat_id", chatId)
        .neq("sender_id", userId)
        .eq("read", false);
    }

    supabase.getChannels().forEach((ch) => supabase.removeChannel(ch));

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
          // Mark it read immediately since the chat is open
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

  if (loading) {
    return <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">Loading...</div>;
  }

  if (activeChat) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex flex-col">
        <header className="flex items-center gap-3 px-4 py-3 border-b border-gray-800">
          <button onClick={goBackToList} className="text-blue-400">← Back</button>
          <span className="font-semibold">{activeChat.otherUser.username}</span>
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
    );
  }

  if (showNewChat) {
    return (
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
    );
  }

  return (
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
  );
}
