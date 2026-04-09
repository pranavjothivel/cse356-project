import { useState, useEffect, useContext, useRef, useCallback } from "react";
import { apiFetch, apiPost, apiPatch, apiDelete } from "../api";
import AuthContext from "../auth";

interface Author {
  id: string;
  username: string | null;
  display_name: string | null;
}

interface ChannelMessage {
  id: string;
  channelId: string;
  authorId: string;
  author: Author | null;
  content: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

interface Props {
  channelId: string;
  channelName: string;
  communityId: string;
}

function authorLabel(msg: ChannelMessage): string {
  if (msg.author) {
    return msg.author.display_name || msg.author.username || msg.authorId.slice(0, 8);
  }
  return msg.authorId.slice(0, 8);
}

export default function ChannelView({ channelId, channelName }: Props) {
  const { auth } = useContext(AuthContext);
  const myId: string | undefined = auth.user?.id;

  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [error, setError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const markReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markAsRead = useCallback((msgId: string) => {
    if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current);
    markReadTimerRef.current = setTimeout(async () => {
      try {
        await apiPost(`/channels/${channelId}/read`, { messageId: msgId });
      } catch { /* non-critical */ }
    }, 500);
  }, [channelId]);

  // Load messages on channel change
  useEffect(() => {
    setMessages([]);
    setEditingId(null);
    setDraft("");
    const load = async () => {
      const res = await apiFetch(`/channels/${channelId}/messages?limit=100`);
      if (res.ok) {
        const data = await res.json();
        // Server returns newest-first; reverse for chronological display
        const msgs = data.messages.slice().reverse();
        setMessages(msgs);
        if (msgs.length > 0) markAsRead(msgs[msgs.length - 1].id);
      }
    };
    load();
  }, [channelId, markAsRead]);

  // Scroll to bottom when messages load or new message arrives
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-mark as read when new messages arrive while viewing
  useEffect(() => {
    if (messages.length === 0) return;
    markAsRead(messages[messages.length - 1].id);
  }, [messages, markAsRead]);

  // WS real-time updates
  useEffect(() => {
    const handler = (e: Event) => {
      const ev = (e as CustomEvent).detail;
      if (!ev?.type || ev.channelId !== channelId) return;

      switch (ev.type) {
        case "channel.message.created":
          setMessages((prev) =>
            prev.some((m) => m.id === ev.message.id) ? prev : [...prev, ev.message]
          );
          break;
        case "channel.message.edited":
          setMessages((prev) => prev.map((m) => (m.id === ev.message.id ? ev.message : m)));
          break;
        case "channel.message.deleted":
          setMessages((prev) =>
            prev.map((m) =>
              m.id === ev.messageId
                ? { ...m, content: null, deletedAt: new Date().toISOString() }
                : m
            )
          );
          break;
      }
    };
    window.addEventListener("ws-event", handler);
    return () => window.removeEventListener("ws-event", handler);
  }, [channelId]);

  const sendMessage = async () => {
    if (!draft.trim()) return;
    setError("");
    const res = await apiPost(`/channels/${channelId}/messages`, { content: draft });
    if (res.ok) {
      setDraft("");
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error || "Failed to send");
    }
  };

  const startEdit = (m: ChannelMessage) => {
    setEditingId(m.id);
    setEditDraft(m.content || "");
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const res = await apiPatch(`/channels/${channelId}/messages/${editingId}`, { content: editDraft });
    if (res.ok) {
      setEditingId(null);
      setEditDraft("");
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error || "Failed to edit");
    }
  };

  const deleteMessage = async (m: ChannelMessage) => {
    const res = await apiDelete(`/channels/${channelId}/messages/${m.id}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error || "Failed to delete");
    }
  };

  return (
    <div className="channel-view" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="channel-view-header" style={{ padding: "8px 12px", borderBottom: "1px solid #333", flexShrink: 0 }}>
        <span style={{ fontWeight: 600 }}>#{channelName}</span>
      </div>

      {/* Message list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px" }}>
        {messages.length === 0 && (
          <p className="placeholder-text">No messages yet. Say something!</p>
        )}
        {messages.map((m) => (
          <div key={m.id} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 12, color: "#888", marginBottom: 2 }}>
              <span style={{ color: "#ccc", fontWeight: 500 }}>{authorLabel(m)}</span>
              {" · "}
              {new Date(m.createdAt).toLocaleTimeString()}
              {m.editedAt && <span style={{ marginLeft: 4, fontStyle: "italic" }}>(edited)</span>}
            </div>
            <div>
              {m.deletedAt ? (
                <em style={{ color: "#666" }}>[deleted]</em>
              ) : editingId === m.id ? (
                <span style={{ display: "flex", gap: 4 }}>
                  <input
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditingId(null); }}
                    style={{ flex: 1, background: "#222", color: "white", border: "1px solid #555", padding: "2px 6px" }}
                    autoFocus
                  />
                  <button className="btn-small" onClick={saveEdit}>save</button>
                  <button className="btn-small" style={{ background: "#444" }} onClick={() => setEditingId(null)}>cancel</button>
                </span>
              ) : (
                <span>
                  {m.content}
                  {!m.deletedAt && m.authorId === myId && (
                    <span style={{ marginLeft: 8 }}>
                      <button
                        className="btn-small"
                        style={{ fontSize: 10, padding: "1px 6px", marginRight: 4 }}
                        onClick={() => startEdit(m)}
                      >edit</button>
                      <button
                        className="btn-small btn-danger"
                        style={{ fontSize: 10, padding: "1px 6px" }}
                        onClick={() => deleteMessage(m)}
                      >delete</button>
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {error && (
        <div style={{ padding: "4px 12px", color: "#f04747", fontSize: "0.85em", background: "#2a2a2a" }}>
          {error} <button style={{ fontSize: 10, marginLeft: 4 }} onClick={() => setError("")}>×</button>
        </div>
      )}

      {/* Input bar */}
      <div style={{ padding: "8px 12px", borderTop: "1px solid #333", display: "flex", gap: 8, flexShrink: 0 }}>
        <input
          className="input-field"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
          placeholder={`Message #${channelName}`}
          style={{ flex: 1 }}
        />
        <button className="btn-small" onClick={sendMessage}>Send</button>
      </div>
    </div>
  );
}
