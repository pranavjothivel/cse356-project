import { useState, useEffect } from "react";
import { apiFetch, apiPost } from "../api";

interface CommunityInfo {
  id: string;
  name: string;
  owner: { id: string; display_name: string | null; username: string | null };
  created_at: string;
}

interface Props {
  onJoined: () => void;
  onClose: () => void;
}

export default function JoinCommunityModal({ onJoined, onClose }: Props) {
  const [communities, setCommunities] = useState<CommunityInfo[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [joiningId, setJoiningId] = useState<string | null>(null);

  const fetchDiscover = async (q?: string) => {
    setLoading(true);
    const url = q ? `/communities/discover?search=${encodeURIComponent(q)}` : "/communities/discover";
    const res = await apiFetch(url);
    if (res.ok) {
      const data = await res.json();
      setCommunities(data.communities);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchDiscover();
  }, []);

  // Remove deleted communities from list in real-time
  useEffect(() => {
    const handler = (e: Event) => {
      const ev = (e as CustomEvent).detail;
      if (ev?.type === "community.deleted") {
        setCommunities((prev) => prev.filter((c) => c.id !== ev.communityId));
      }
    };
    window.addEventListener("ws-event", handler);
    return () => window.removeEventListener("ws-event", handler);
  }, []);

  const handleSearch = (val: string) => {
    setSearch(val);
    fetchDiscover(val);
  };

  const handleJoin = async (community: CommunityInfo) => {
    setJoiningId(community.id);
    setError("");
    const res = await apiPost(`/communities/${community.id}/join`);
    setJoiningId(null);
    if (res.ok) {
      onJoined();
      onClose();
    } else {
      const body = await res.json();
      if (res.status === 404) {
        setError(`"${community.name}" no longer exists.`);
        setCommunities((prev) => prev.filter((c) => c.id !== community.id));
      } else {
        setError(body.error || "Failed to join community");
      }
    }
  };

  return (
    <div className="modal-container" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ minWidth: 360, maxHeight: "70vh", display: "flex", flexDirection: "column" }}>
        <h3 style={{ margin: "0 0 12px" }}>Join a Community</h3>
        <input
          className="input-field"
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="Search communities..."
          autoFocus
          style={{ marginBottom: 12 }}
        />
        {error && <div style={{ color: "#f04747", fontSize: "0.85em", marginBottom: 8 }}>{error}</div>}
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          {loading ? (
            <div style={{ color: "#888", padding: "8px 0", fontSize: "0.9em" }}>Loading...</div>
          ) : communities.length === 0 ? (
            <div style={{ color: "#888", padding: "8px 0", fontSize: "0.9em" }}>No communities found</div>
          ) : (
            communities.map((c) => (
              <div
                key={c.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 4px",
                  borderBottom: "1px solid #333",
                }}
              >
                <div>
                  <div style={{ fontWeight: 500 }}>{c.name}</div>
                  <div style={{ fontSize: "0.8em", color: "#888" }}>
                    by {c.owner?.display_name || c.owner?.username || "unknown"}
                  </div>
                </div>
                <button
                  className="btn-small"
                  onClick={() => handleJoin(c)}
                  disabled={joiningId === c.id}
                >
                  {joiningId === c.id ? "Joining..." : "Join"}
                </button>
              </div>
            ))
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <button className="btn-small" style={{ background: "#444" }} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
