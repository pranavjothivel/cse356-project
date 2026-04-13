import React, { useContext, useEffect, useState, useCallback, useRef } from "react";
import SearchModal from "./SearchModal";
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
    content: string;
    createdAt: string;
    editedAt: string | null;
    attachments: string[]
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

interface Props {
    unreadConvIds: Set<string>;
    setUnreadConvIds: React.Dispatch<React.SetStateAction<Set<string>>>;
}

export default function ConversationsPanel({ unreadConvIds, setUnreadConvIds }: Props) {
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
    const [attachments, setAttachments] = useState<any[]>([]);
    const [editAttachments, setEditAttachments] = useState<any[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const editFileInputRef = useRef<HTMLInputElement>(null);

    // "New conversation" modal
    const [showNewModal, setShowNewModal] = useState(false);
    const [newParticipants, setNewParticipants] = useState("");

    const selected = conversations.find(c => c.id === selectedId) || null;
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const [showSearch, setShowSearch] = useState(false);
    // userId -> lastReadMessageId for the selected conversation
    const [readState, setReadState] = useState<Map<string, string | null>>(new Map());
    const markReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
            const body = await api(`/messages?conversationId=${convId}&limit=100`);
            // Server returns newest-first; flip for display
            setMessages(body.messages.slice().reverse());
        } catch (err: any) { setError(err.message); }
    }, []);

    const loadReadState = useCallback(async (convId: string) => {
        try {
            const body = await api(`/conversations/${convId}/read-state`);
            const map = new Map<string, string | null>();
            for (const entry of body.readState) {
                map.set(entry.userId, entry.lastReadMessageId);
            }
            setReadState(map);
        } catch { /* non-critical */ }
    }, []);

    const markAsRead = useCallback((convId: string, messageId: string) => {
        if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current);
        markReadTimerRef.current = setTimeout(async () => {
            try {
                await api(`/conversations/${convId}/read`, {
                    method: 'POST',
                    body: JSON.stringify({ messageId }),
                });
            } catch { /* non-critical */ }
        }, 500);
    }, []);

    useEffect(() => {
        if (auth.loggedIn) loadConversations();
    }, [auth.loggedIn, loadConversations]);

    useEffect(() => {
        if (selectedId) {
            loadMessages(selectedId);
            loadReadState(selectedId);
        } else {
            setMessages([]);
            setReadState(new Map());
        }
    }, [selectedId, loadMessages, loadReadState]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    // Auto-mark as read when viewing a conversation with messages
    useEffect(() => {
        if (!selectedId || messages.length === 0) return;
        const lastMsg = messages[messages.length - 1];
        markAsRead(selectedId, lastMsg.id);
    }, [selectedId, messages, markAsRead]);

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
                        setMessages(prev => prev.filter(m => m.id !== ev.messageId));
                    }
                    break;

                case "conversation.read":
                    if (ev.conversationId === selectedId) {
                        setReadState(prev => {
                            const next = new Map(prev);
                            next.set(ev.userId, ev.lastReadMessageId);
                            return next;
                        });
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

        let attachmentsToSend = [];
        for (let i = 0; i < attachments.length; i++) {
            const formData = new FormData();
            formData.append("image", attachments[i].file);
            let uploadRes = await fetch(import.meta.env.VITE_BACKEND_URL + "/upload", {
                method: "POST",
                credentials: "include",
                body: formData
            });
            if (!uploadRes.ok) {
                const body = await uploadRes.json().catch(() => ({}));
                setError(body.error || "Failed to upload images");
                return;
            }
            const { url } = await uploadRes.json();
            attachmentsToSend.push(url);
        }
        try {
            await api(`/messages`, {
                method: "POST",
                body: JSON.stringify({ conversationId: selected.id, content: draft, attachments: attachmentsToSend }),
            });
            setDraft("");
            setAttachments([]);
        } catch (err: any) { setError(err.message); }
    };

    const startEdit = (m: Message) => {
        setEditingId(m.id);
        setEditDraft(m.content || "");

        let newEditAttachments = [];
        for (let i = 0; i < m.attachments.length; i++) {
            newEditAttachments.push({
                src: import.meta.env.VITE_IMAGE_URL + "/" + m.attachments[i],
                url: m.attachments[i]
            });
        }
        setEditAttachments(newEditAttachments);
    };

    const saveEdit = async () => {
        if (!selected || !editingId) return;

        let attachmentsToSend = [];
        for (let i = 0; i < editAttachments.length; i++) {
            if (editAttachments[i].url) attachmentsToSend.push(editAttachments[i].url);
            else {
                const formData = new FormData();
                formData.append("image", editAttachments[i].file);
                let uploadRes = await fetch(import.meta.env.VITE_BACKEND_URL + "/upload", {
                    method: "POST",
                    credentials: "include",
                    body: formData
                });
                if (!uploadRes.ok) {
                const body = await uploadRes.json().catch(() => ({}));
                setError(body.error || "Failed to upload images");
                return;
                }
                const { url } = await uploadRes.json();
                attachmentsToSend.push(url);
            }
        }
        try {
            await api(`/messages/${editingId}`, {
                method: "PATCH",
                body: JSON.stringify({ content: editDraft, attachments: attachmentsToSend }),
            });
            setEditingId(null);
            setEditDraft("");
            setEditAttachments([]);
        } catch (err: any) { setError(err.message); }
    };

    const deleteMessage = async (m: Message) => {
        if (!selected) return;
        try {
            await api(`/messages/${m.id}`, { method: "DELETE" });
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


    const attach = async (event: any) => {
        if (event.target.files) {
        if (attachments.length + event.target.files.length > 4) {
            setError("Too many attachments. Limit is 4");
            return;
        }

        let newAttachments = [...attachments];
        let errMsg = "";
        for (let i = 0; i < event.target.files.length; i++) {
            let file = event.target.files[i];
            const url = URL.createObjectURL(file);
            newAttachments.push({src: url, file});
        }

        setAttachments(newAttachments);
        if (errMsg !== "") setError(errMsg);
        }
    }
    const unAttach = async (index: number) => {
        let newAttachments = [...attachments.slice(0, index), ...attachments.slice(index+1)];
        setAttachments(newAttachments);
    }

    const editAttach = async (event: any) => {
        if (event.target.files) {
        if (editAttachments.length + event.target.files.length > 4) {
            setError("Too many attachments. Limit is 4");
            return;
        }

        let newAttachments = [...editAttachments];
        let errMsg = "";
        for (let i = 0; i < event.target.files.length; i++) {
            let file = event.target.files[i];
            const url = URL.createObjectURL(file);
            newAttachments.push({src: url, file});
        }

        setEditAttachments(newAttachments);
        if (errMsg !== "") setError(errMsg);
        }
    }
    const editUnAttach = async (index: number) => {
        let newAttachments = [...editAttachments.slice(0, index), ...editAttachments.slice(index+1)];
        setEditAttachments(newAttachments);
    }


    // ---- Render -----------------------------------------------------------
    const visible = conversations.filter(c => showHidden || !c.hidden);

    return (
        <div style={{ display: "flex", border: "1px solid #444", marginTop: 16, height: 500, background: "#1a1a1a" }}>
            {/* Sidebar */}
            <div style={{ width: 280, borderRight: "1px solid #444", background: "#1a1a1a", display: "flex", flexDirection: "column" }}>
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
                            onClick={() => { setSelectedId(c.id); setUnreadConvIds(prev => { const s = new Set(prev); s.delete(c.id); return s; }); }}
                            style={{
                                padding: 8,
                                cursor: "pointer",
                                background: c.id === selectedId ? "#3a3a3a" : "#1e1e1e",
                                opacity: c.hidden ? 0.5 : 1,
                                borderBottom: "1px solid #333",
                            }}
                        >
                            <div style={{ fontSize: 12, color: "#aaa" }}>{c.kind}{c.hidden ? " (hidden)" : ""}</div>
                            <div style={{ fontSize: 12, color: "white", display: "flex", alignItems: "center", gap: 4 }}>
                                <span style={{ fontWeight: unreadConvIds.has(c.id) ? 700 : undefined }}>
                                    {c.participants
                                        .filter(p => p.id !== myId)
                                        .map(p => p.username || p.displayName || p.id.slice(0, 8))
                                        .join(", ") || "(self)"}
                                </span>
                                {unreadConvIds.has(c.id) && (
                                    <span style={{ fontSize: 10, fontWeight: 700, color: "#5865f2", textTransform: "uppercase", letterSpacing: 0.3 }}>
                                        Unread
                                    </span>
                                )}
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
                                    <button onClick={() => setShowSearch(true)}>search</button>
                                    <button onClick={hideConversation}>hide</button>
                                </div>
                            );
                        })()}
                        <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
                            {messages.map(m => {
                                // Collect readers (other users) whose lastReadMessageId === this message
                                const readers = selected
                                    ? selected.participants
                                        .filter(p => p.id !== myId && readState.get(p.id) === m.id)
                                        .map(p => p.username || p.displayName || p.id.slice(0, 8))
                                    : [];
                                return (
                                    <div key={m.id} style={{ marginBottom: 6, fontSize: 13 }}>
                                        <span style={{ color: "#888", fontSize: 11 }}>
                                            {userLabel(m.authorId)} · {new Date(m.createdAt).toLocaleTimeString()}
                                            {m.editedAt && " (edited)"}
                                        </span>
                                        <div>
                                            {editingId === m.id
                                                ? (
                                                    <span>
                                                        <input value={editDraft} onChange={e => setEditDraft(e.target.value)} />
                                                        <input type="file" accept="image/*" ref={editFileInputRef} style={{display: "none"}} multiple onChange={editAttach} />
                                                        <button onClick={() => {if (editFileInputRef.current) editFileInputRef.current.click()}}>Attach</button>
                                                        <button onClick={saveEdit}>save</button>
                                                        <button onClick={() => setEditingId(null)}>cancel</button>
                                                    </span>
                                                )
                                                : m.content
                                            }
                                            {editingId !== m.id && m.authorId === myId && (
                                                <span style={{ marginLeft: 8 }}>
                                                    <button style={{ fontSize: 10 }} onClick={() => startEdit(m)}>edit</button>
                                                    <button style={{ fontSize: 10 }} onClick={() => deleteMessage(m)}>delete</button>
                                                </span>
                                            )}
                                        </div>
                                        {editingId === m.id ? (
                                            <div style={{ padding: "8px 12px", display: "flex"}}> 
                                                {editAttachments.map((attachment, index) => (
                                                <div key={`attachment-container-${m.id}-${index}`} style={{position: "relative", margin: "0 8px"}}>
                                                    <img 
                                                    src={attachment.src}
                                                    width="128px"
                                                    height="128px"
                                                    />
                                                    <button style={{position: "absolute", top: "0", right: "0"}} onClick={() => {editUnAttach(index)}}>Remove</button>
                                                </div>
                                                ))}
                                            </div>
                                        ): (
                                            <div style={{ padding: "8px 12px", display: "flex"}}> 
                                                {m.attachments.map((attachment, index) => (
                                                <div key={`attachment-container-${m.id}-${index}`} style={{position: "relative", margin: "0 8px"}}>
                                                    <img 
                                                    src={import.meta.env.VITE_IMAGE_URL + "/" + attachment}
                                                    width="128px"
                                                    height="128px"
                                                    />
                                                </div>
                                                ))}
                                            </div>
                                        )}
                                        {readers.length > 0 && (
                                            <div style={{ fontSize: 10, color: "#6a9f6a", marginTop: 1 }}>
                                                Read by {readers.join(", ")}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                            <div ref={messagesEndRef} />
                        </div>
                        <div style={{ padding: "8px 12px", borderTop: "1px solid #333", display: "flex"}}> 
                            {attachments.map((attachment, index) => (
                            <div key={"attachment-container-" + index} style={{position: "relative", margin: "0 8px"}}>
                                <img 
                                src={attachment.src}
                                width="128px"
                                height="128px"
                                />
                                <button className="btn-small btn-danger" style={{position: "absolute", top: "0", right: "0"}} onClick={() => {unAttach(index)}}>Remove</button>
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
                            <input type="file" accept="image/*" ref={fileInputRef} style={{display: "none"}} multiple onChange={attach} />
                            <button onClick={() => {if (fileInputRef.current) fileInputRef.current.click()}}>Attach</button>
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

            {showSearch && selected && (
                <SearchModal
                    scope="conversation"
                    scopeId={selected.id}
                    onClose={() => setShowSearch(false)}
                />
            )}
            {error && (
                <div style={{ position: "absolute", bottom: 8, right: 8, background: "#c0392b", color: "white", padding: 8, fontSize: 12, borderRadius: 4 }}>
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