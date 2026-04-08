import { useContext, useEffect, useState, useCallback } from "react";
import AuthContext from "../auth";

// Minimal direct-conversations UI. Sidebar lists conversations; main pane shows
// messages for the selected conversation. Real-time updates come in via the
// `ws-event` window CustomEvent dispatched by HomeScreen's WS handler.

type Participant = {
    id: string;
    username: string | null;
    displayName: string | null;
};

type Conversation = {
    id: string;
    kind: "dm" | "group";
    createdAt: string;
    participantIds: string[];
    participants: Participant[];
    hidden: boolean;
};

type Message = {
    id: string;
    conversationId: string;
    authorId: string;
    content: string | null;
    createdAt: string;
    editedAt: string | null;
    deletedAt: string | null;
};

const API = import.meta.env.VITE_BACKEND_URL;

async function api(path: string, opts: RequestInit = {}) {
    const res = await fetch(API + path, {
        credentials: "include",
        headers: { "content-type": "application/json", ...(opts.headers || {}) },
        ...opts,
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`${res.status} ${body}`);
    }
    return res.json();
}

export default function ConversationsPanel() {
    const { auth } = useContext(AuthContext);
    const myId: string | undefined = auth.user?.id;

    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [showHidden, setShowHidden] = useState(false);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [draft, setDraft] = useState("");
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editDraft, setEditDraft] = useState("");
    const [error, setError] = useState<string>("");

    // "New conversation" modal
    const [showNewModal, setShowNewModal] = useState(false);
    const [newParticipants, setNewParticipants] = useState("");

    const selected = conversations.find(c => c.id === selectedId) || null;

    // Build a global id -> display label map from every conversation we know about,
    // so message author labels can show usernames instead of UUID prefixes.
    const userLabel = useCallback((id: string): string => {
        for (const c of conversations) {
            const p = c.participants?.find(p => p.id === id);
            if (p) return p.username || p.displayName || id.slice(0, 8);
        }
        return id.slice(0, 8);
    }, [conversations]);

    // ---- Loaders ----------------------------------------------------------
    const loadConversations = useCallback(async () => {
        try {
            const body = await api("/conversations");
            setConversations(body.conversations);
        } catch (err: any) { setError(err.message); }
    }, []);

    const loadMessages = useCallback(async (convId: string) => {
        try {
            const body = await api(`/conversations/${convId}/messages?limit=100`);
            // Server returns newest-first; flip for display
            setMessages(body.messages.slice().reverse());
        } catch (err: any) { setError(err.message); }
    }, []);

    useEffect(() => {
        if (auth.loggedIn) loadConversations();
    }, [auth.loggedIn, loadConversations]);

    useEffect(() => {
        if (selectedId) loadMessages(selectedId);
        else setMessages([]);
    }, [selectedId, loadMessages]);

    // ---- WS event handling ------------------------------------------------
    useEffect(() => {
        const handler = (e: Event) => {
            const ev = (e as CustomEvent).detail;
            if (!ev || !ev.type) return;

            switch (ev.type) {
                case "conversation.created":
                    setConversations(prev => {
                        if (prev.some(c => c.id === ev.conversation.id)) return prev;
                        return [...prev, ev.conversation];
                    });
                    break;

                case "conversation.participants_changed":
                    setConversations(prev => prev.map(c =>
                        c.id === ev.conversationId
                            ? { ...c, participantIds: ev.participantIds }
                            : c
                    ));
                    break;

                case "conversation.left":
                    setConversations(prev => prev.filter(c => c.id !== ev.conversationId));
                    if (selectedId === ev.conversationId) setSelectedId(null);
                    break;

                case "message.created":
                    if (ev.conversationId === selectedId) {
                        setMessages(prev => prev.some(m => m.id === ev.message.id) ? prev : [...prev, ev.message]);
                    }
                    // Server un-hides for everyone on a new message — reflect that locally
                    setConversations(prev => prev.map(c =>
                        c.id === ev.conversationId ? { ...c, hidden: false } : c
                    ));
                    break;

                case "message.edited":
                    if (ev.conversationId === selectedId) {
                        setMessages(prev => prev.map(m => m.id === ev.message.id ? ev.message : m));
                    }
                    break;

                case "message.deleted":
                    if (ev.conversationId === selectedId) {
                        setMessages(prev => prev.map(m =>
                            m.id === ev.messageId
                                ? { ...m, content: null, deletedAt: new Date().toISOString() }
                                : m
                        ));
                    }
                    break;
            }
        };
        window.addEventListener("ws-event", handler);
        return () => window.removeEventListener("ws-event", handler);
    }, [selectedId]);

    // ---- Actions ----------------------------------------------------------
    const createConversation = async () => {
        const names = newParticipants.split(",").map(s => s.trim()).filter(Boolean);
        if (names.length === 0) return setError("Enter at least one username");
        const kind = names.length === 1 ? "dm" : "group";
        try {
            const conv = await api("/conversations", {
                method: "POST",
                body: JSON.stringify({ kind, usernames: names }),
            });
            setNewParticipants("");
            setShowNewModal(false);
            await loadConversations();
            setSelectedId(conv.id);
        } catch (err: any) { setError(err.message); }
    };

    const closeNewModal = () => {
        setShowNewModal(false);
        setNewParticipants("");
    };

    const sendMessage = async () => {
        if (!selected || !draft.trim()) return;
        try {
            await api(`/conversations/${selected.id}/messages`, {
                method: "POST",
                body: JSON.stringify({ content: draft }),
            });
            setDraft("");
        } catch (err: any) { setError(err.message); }
    };

    const startEdit = (m: Message) => {
        setEditingId(m.id);
        setEditDraft(m.content || "");
    };

    const saveEdit = async () => {
        if (!selected || !editingId) return;
        try {
            await api(`/conversations/${selected.id}/messages/${editingId}`, {
                method: "PATCH",
                body: JSON.stringify({ content: editDraft }),
            });
            setEditingId(null);
            setEditDraft("");
        } catch (err: any) { setError(err.message); }
    };

    const deleteMessage = async (m: Message) => {
        if (!selected) return;
        try {
            await api(`/conversations/${selected.id}/messages/${m.id}`, { method: "DELETE" });
        } catch (err: any) { setError(err.message); }
    };

    const inviteParticipant = async () => {
        if (!selected) return;
        const username = window.prompt("Username to invite:");
        if (!username) return;
        try {
            await api(`/conversations/${selected.id}/participants`, {
                method: "POST",
                body: JSON.stringify({ username: username.trim() }),
            });
        } catch (err: any) { setError(err.message); }
    };

    const leaveConversation = async () => {
        if (!selected) return;
        if (!window.confirm("Leave this conversation?")) return;
        try {
            await api(`/conversations/${selected.id}/participants/me`, { method: "DELETE" });
            setSelectedId(null);
            await loadConversations();
        } catch (err: any) { setError(err.message); }
    };

    const hideConversation = async () => {
        if (!selected) return;
        try {
            await api(`/conversations/${selected.id}/hide`, { method: "POST" });
            await loadConversations();
            setSelectedId(null);
        } catch (err: any) { setError(err.message); }
    };

    const unhideConversation = async (convId: string) => {
        try {
            await api(`/conversations/${convId}/unhide`, { method: "POST" });
            await loadConversations();
        } catch (err: any) { setError(err.message); }
    };

    // ---- Render -----------------------------------------------------------
    const visible = conversations.filter(c => showHidden || !c.hidden);

    return (
        <div style={{ display: "flex", border: "1px solid #ccc", marginTop: 16, height: 500 }}>
            {/* Sidebar */}
            <div style={{ width: 280, borderRight: "1px solid #ccc", display: "flex", flexDirection: "column" }}>
                <div style={{ padding: 8, borderBottom: "1px solid #eee", display: "flex", alignItems: "center", gap: 8 }}>
                    <strong style={{ flex: 1 }}>Conversations</strong>
                    <button
                        onClick={() => setShowNewModal(true)}
                        title="New conversation"
                        style={{ fontSize: 12 }}
                    >
                        + New
                    </button>
                    <label style={{ fontSize: 12 }}>
                        <input type="checkbox" checked={showHidden} onChange={e => setShowHidden(e.target.checked)} />
                        show hidden
                    </label>
                </div>
                <div style={{ flex: 1, overflowY: "auto" }}>
                    {visible.map(c => (
                        <div
                            key={c.id}
                            onClick={() => setSelectedId(c.id)}
                            style={{
                                padding: 8,
                                cursor: "pointer",
                                background: c.id === selectedId ? "#3a3a3a" : "transparent",
                                opacity: c.hidden ? 0.5 : 1,
                                borderBottom: "1px solid #f0f0f0",
                            }}
                        >
                            <div style={{ fontSize: 12, color: "#666" }}>{c.kind}{c.hidden ? " (hidden)" : ""}</div>
                            <div style={{ fontSize: 12 }}>
                                {c.participants
                                    .filter(p => p.id !== myId)
                                    .map(p => p.username || p.displayName || p.id.slice(0, 8))
                                    .join(", ") || "(self)"}
                            </div>
                            {c.hidden && (
                                <button
                                    style={{ fontSize: 11, marginTop: 4 }}
                                    onClick={(e) => { e.stopPropagation(); unhideConversation(c.id); }}
                                >
                                    unhide
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            </div>

            {/* Main pane */}
            <div style={{ flex: 1, display: "flex" }}>
                {selected ? (
                    <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                        {selected.kind === "dm" && (() => {
                            const other = selected.participants.find(p => p.id !== myId);
                            const label = other
                                ? (other.username || other.displayName || other.id.slice(0, 8))
                                : "(self)";
                            return (
                                <div style={{ padding: 8, borderBottom: "1px solid #444", display: "flex", alignItems: "center", gap: 8 }}>
                                    <div style={{ flex: 1, fontWeight: "bold" }}>{label}</div>
                                    <button onClick={hideConversation}>hide</button>
                                </div>
                            );
                        })()}
                        <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
                            {messages.map(m => (
                                <div key={m.id} style={{ marginBottom: 6, fontSize: 13 }}>
                                    <span style={{ color: "#888", fontSize: 11 }}>
                                        {userLabel(m.authorId)} · {new Date(m.createdAt).toLocaleTimeString()}
                                        {m.editedAt && " (edited)"}
                                    </span>
                                    <div>
                                        {m.deletedAt
                                            ? <em style={{ color: "#aaa" }}>[deleted]</em>
                                            : editingId === m.id
                                                ? (
                                                    <span>
                                                        <input value={editDraft} onChange={e => setEditDraft(e.target.value)} />
                                                        <button onClick={saveEdit}>save</button>
                                                        <button onClick={() => setEditingId(null)}>cancel</button>
                                                    </span>
                                                )
                                                : m.content
                                        }
                                        {!m.deletedAt && editingId !== m.id && m.authorId === myId && (
                                            <span style={{ marginLeft: 8 }}>
                                                <button style={{ fontSize: 10 }} onClick={() => startEdit(m)}>edit</button>
                                                <button style={{ fontSize: 10 }} onClick={() => deleteMessage(m)}>delete</button>
                                            </span>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                        <div style={{ padding: 8, borderTop: "1px solid #444", background: "#2a2a2a", display: "flex", gap: 4 }}>
                            <input
                                value={draft}
                                onChange={e => setDraft(e.target.value)}
                                onKeyDown={e => { if (e.key === "Enter") sendMessage(); }}
                                placeholder="Message…"
                                style={{
                                    flex: 1,
                                    background: "#222",
                                    color: "white",
                                    border: "1px solid #555",
                                    padding: "4px 6px",
                                }}
                            />
                            <button onClick={sendMessage}>send</button>
                        </div>
                    </div>
                ) : (
                    <div style={{ padding: 16, color: "#888" }}>Select a conversation</div>
                )}
                {selected && selected.kind === "group" && (
                    <div style={{ width: 200, borderLeft: "1px solid #444", display: "flex", flexDirection: "column" }}>
                        <div style={{ padding: 8, borderBottom: "1px solid #444", fontSize: 12, fontWeight: "bold" }}>
                            Members
                        </div>
                        <div style={{ flex: 1, overflowY: "auto", padding: 8, fontSize: 13 }}>
                            {selected.participants.map(p => {
                                const label = p.username || p.displayName || p.id.slice(0, 8);
                                return (
                                    <div key={p.id} style={{ marginBottom: 4 }}>
                                        {label}{p.id === myId && <span style={{ color: "#888" }}> (you)</span>}
                                    </div>
                                );
                            })}
                        </div>
                        <div style={{ padding: 8, borderTop: "1px solid #444", display: "flex", flexDirection: "column", gap: 4 }}>
                            <button onClick={inviteParticipant}>invite</button>
                            <button onClick={leaveConversation}>leave</button>
                        </div>
                    </div>
                )}
            </div>

            {error && (
                <div style={{ position: "absolute", bottom: 8, right: 8, background: "#fee", padding: 8, fontSize: 12 }}>
                    {error} <button onClick={() => setError("")}>×</button>
                </div>
            )}

            {showNewModal && (
                <div className="modal-container" onClick={closeNewModal}>
                    <div
                        className="modal"
                        onClick={e => e.stopPropagation()}
                        style={{
                            padding: 16,
                            borderRadius: 6,
                            minWidth: 320,
                            border: "1px solid #444",
                            boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
                        }}
                    >
                        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
                            <strong style={{ flex: 1 }}>New conversation</strong>
                            <button onClick={closeNewModal} aria-label="Close">×</button>
                        </div>
                        <div style={{ fontSize: 12, marginBottom: 12 }}>
                            <div style={{ fontSize: 16, marginTop: 4, color: "white", marginBottom: 8 }}>
                                New Message
                            </div>
                            <label style={{ display: "block", marginBottom: 4 }}>Participants</label>
                            <input
                                autoFocus
                                placeholder="usernames (comma separated)"
                                value={newParticipants}
                                onChange={e => setNewParticipants(e.target.value)}
                                onKeyDown={e => { if (e.key === "Enter") createConversation(); }}
                                style={{
                                    width: "100%",
                                    background: "#222",
                                    color: "white",
                                    border: "1px solid #555",
                                    padding: "4px 6px",
                                    boxSizing: "border-box",
                                }}
                            />
                            <div style={{ marginTop: 4, color: "#aaa" }}>
                                One username creates a direct message; two or more creates a group.
                            </div>
                        </div>
                        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                            <button onClick={closeNewModal}>Cancel</button>
                            <button onClick={createConversation}>Create</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}