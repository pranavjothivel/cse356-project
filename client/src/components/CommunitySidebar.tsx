import { useState, useEffect } from "react";
import { apiFetch } from "../api";
import CreateCommunityModal from "./CreateCommunityModal";
import JoinCommunityModal from "./JoinCommunityModal";

interface CommunityInfo {
  id: string;
  name: string;
  role: string;
}

interface Props {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export default function CommunitySidebar({ selectedId, onSelect }: Props) {
  const [communities, setCommunities] = useState<CommunityInfo[]>([]);
  const [modal, setModal] = useState<string>("");

  const fetchCommunities = async () => {
    const res = await apiFetch("/communities");
    if (res.ok) {
      const data = await res.json();
      setCommunities(data.communities);
    }
  };

  useEffect(() => {
    fetchCommunities();
  }, []);

  // Remove deleted/left communities in real-time
  useEffect(() => {
    const handler = (e: Event) => {
      const ev = (e as CustomEvent).detail;
      if (!ev?.type) return;
      if (ev.type === "community.deleted" || ev.type === "community.left") {
        setCommunities((prev) => prev.filter((c) => c.id !== ev.communityId));
        if (selectedId === ev.communityId) onSelect(null);
      }
    };
    window.addEventListener("ws-event", handler);
    return () => window.removeEventListener("ws-event", handler);
  }, [selectedId, onSelect]);

  return (
    <div className="sidebar-left">
      <div className="sidebar-left-header">
        <span>Communities</span>
        <div style={{ display: "flex", gap: 4 }}>
          <button className="btn-small" style={{ padding: "2px 8px" }} onClick={() => setModal("join")}>Join</button>
          <button className="btn-small" style={{ padding: "2px 8px" }} onClick={() => setModal("create")}>+</button>
        </div>
      </div>
      {communities.map((c) => (
        <div
          key={c.id}
          className={`community-item${selectedId === c.id ? " selected" : ""}`}
          onClick={() => onSelect(c.id)}
        >
          {c.name}
        </div>
      ))}
      {communities.length === 0 && (
        <div style={{ padding: 12, color: "#666", fontSize: "0.85em" }}>No communities yet</div>
      )}

      {modal === "create" && (
        <CreateCommunityModal onCreated={fetchCommunities} onClose={() => setModal("")} />
      )}
      {modal === "join" && (
        <JoinCommunityModal onJoined={fetchCommunities} onClose={() => setModal("")} />
      )}
    </div>
  );
}
