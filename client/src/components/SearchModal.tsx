import { useState } from "react";
import { apiFetch } from "../api";

interface SearchResult {
    id: string;
    content: string;
    author: { id: string; username: string | null; displayName: string | null };
    createdAt: string;
    editedAt: string | null;
    channelId: string | null;
    conversationId: string | null;
}

interface Props {
    scope: "community" | "conversation";
    scopeId: string;
    onClose: () => void;
    // Called when user clicks a result so the parent can navigate to it
    onJumpTo?: (result: SearchResult) => void;
}

export default function SearchModal({ scope, scopeId, onClose, onJumpTo }: Props) {
    const [q, setQ] = useState("");
    const [authorFilter, setAuthorFilter] = useState("");
    const [after, setAfter] = useState("");
    const [before, setBefore] = useState("");
    const [results, setResults] = useState<SearchResult[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const search = async () => {
        if (!q.trim()) return;
        setLoading(true);
        setError("");
        try {
            const params = new URLSearchParams({ q: q.trim(), scope });
            if (scope === "community") params.set("communityId", scopeId);
            else params.set("conversationId", scopeId);
            if (authorFilter.trim()) params.set("authorId", authorFilter.trim());
            if (after) params.set("after", new Date(after).toISOString());
            if (before) params.set("before", new Date(before).toISOString());

            const res = await apiFetch(`/search?${params.toString()}`);
            if (!res.ok) {
                const body = await res.json();
                setError(body.error || "Search failed");
            } else {
                const body = await res.json();
                setResults(body.results);
            }
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const authorLabel = (r: SearchResult) =>
        r.author.username || r.author.displayName || r.author.id.slice(0, 8);

    return (
        <div className="modal-container" onClick={onClose}>
            <div
                className="modal"
                onClick={e => e.stopPropagation()}
                style={{ minWidth: 520, maxWidth: 700, maxHeight: "80vh", display: "flex", flexDirection: "column", padding: 16, borderRadius: 6, border: "1px solid #444" }}
            >
                <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
                    <strong style={{ flex: 1 }}>Search {scope === "community" ? "Community" : "Conversation"}</strong>
                    <button onClick={onClose}>×</button>
                </div>

                {/* Search input */}
                <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                    <input
                        autoFocus
                        placeholder="Search messages…"
                        value={q}
                        onChange={e => setQ(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") search(); }}
                        style={{ flex: 1, background: "#222", color: "white", border: "1px solid #555", padding: "4px 8px" }}
                    />
                    <button onClick={search} disabled={loading}>
                        {loading ? "…" : "Search"}
                    </button>
                </div>

                {/* Filters */}
                <div style={{ display: "flex", gap: 8, marginBottom: 12, fontSize: 12 }}>
                    <div style={{ flex: 1 }}>
                        <div style={{ color: "#aaa", marginBottom: 2 }}>Author ID (optional)</div>
                        <input
                            placeholder="user UUID"
                            value={authorFilter}
                            onChange={e => setAuthorFilter(e.target.value)}
                            style={{ width: "100%", background: "#222", color: "white", border: "1px solid #555", padding: "3px 6px", boxSizing: "border-box" }}
                        />
                    </div>
                    <div style={{ flex: 1 }}>
                        <div style={{ color: "#aaa", marginBottom: 2 }}>After</div>
                        <input
                            type="date"
                            value={after}
                            onChange={e => setAfter(e.target.value)}
                            style={{ width: "100%", background: "#222", color: "white", border: "1px solid #555", padding: "3px 6px", boxSizing: "border-box" }}
                        />
                    </div>
                    <div style={{ flex: 1 }}>
                        <div style={{ color: "#aaa", marginBottom: 2 }}>Before</div>
                        <input
                            type="date"
                            value={before}
                            onChange={e => setBefore(e.target.value)}
                            style={{ width: "100%", background: "#222", color: "white", border: "1px solid #555", padding: "3px 6px", boxSizing: "border-box" }}
                        />
                    </div>
                </div>

                {error && <div style={{ color: "#e74c3c", fontSize: 12, marginBottom: 8 }}>{error}</div>}

                {/* Results */}
                <div style={{ flex: 1, overflowY: "auto" }}>
                    {results === null ? null : results.length === 0 ? (
                        <div style={{ color: "#888", fontSize: 13 }}>No results found.</div>
                    ) : (
                        results.map(r => (
                            <div
                                key={r.id}
                                onClick={() => onJumpTo?.(r)}
                                style={{
                                    padding: "8px 10px",
                                    marginBottom: 6,
                                    background: "#2a2a2a",
                                    borderRadius: 4,
                                    cursor: onJumpTo ? "pointer" : "default",
                                    border: "1px solid #3a3a3a",
                                }}
                            >
                                <div style={{ fontSize: 11, color: "#aaa", marginBottom: 3 }}>
                                    <span style={{ color: "white" }}>{authorLabel(r)}</span>
                                    {" · "}
                                    {new Date(r.createdAt).toLocaleString()}
                                    {r.editedAt && <span style={{ color: "#888" }}> (edited)</span>}
                                    {r.channelId && <span style={{ color: "#888" }}> · channel</span>}
                                    {r.conversationId && <span style={{ color: "#888" }}> · DM</span>}
                                </div>
                                <div style={{ fontSize: 13, color: "#ddd", wordBreak: "break-word" }}>
                                    {r.content}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {results !== null && results.length > 0 && (
                    <div style={{ fontSize: 11, color: "#666", marginTop: 8 }}>
                        {results.length} result{results.length !== 1 ? "s" : ""} (newest first)
                    </div>
                )}
            </div>
        </div>
    );
}
