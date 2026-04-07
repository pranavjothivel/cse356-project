import { useState } from "react";
import { apiPost } from "../api";
import CreateChannelModal from "./CreateChannelModal";

interface ChannelInfo {
  id: string;
  name: string;
  is_private: boolean;
  is_joined: boolean;
}

interface Props {
  communityId: string;
  channels: ChannelInfo[];
  userRole: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}

export default function ChannelList({ communityId, channels, userRole, selectedId, onSelect, onRefresh }: Props) {
  const [showCreate, setShowCreate] = useState(false);
  const isAdmin = userRole === "owner" || userRole === "admin";

  const handleJoin = async (channelId: string) => {
    const res = await apiPost(`/channels/${channelId}/join`);
    if (res.ok) onRefresh();
  };

  return (
    <div className="channel-panel">
      <div className="channel-panel-header">
        <span>Channels</span>
        {isAdmin && (
          <button className="btn-small" style={{ padding: "1px 6px", fontSize: "0.8em" }} onClick={() => setShowCreate(true)}>+</button>
        )}
      </div>
      {channels.map((c) => (
        <div
          key={c.id}
          className={`channel-item${selectedId === c.id ? " selected" : ""}`}
          onClick={() => c.is_joined && onSelect(c.id)}
        >
          {c.is_private && <span className="lock-icon">&#128274;</span>}
          <span style={{ opacity: c.is_joined ? 1 : 0.5 }}>{c.name}</span>
          {!c.is_joined && (
            <button className="join-btn" onClick={(e) => { e.stopPropagation(); handleJoin(c.id); }}>Join</button>
          )}
        </div>
      ))}
      {channels.length === 0 && (
        <div style={{ padding: 12, color: "#666", fontSize: "0.8em" }}>No channels yet</div>
      )}

      {showCreate && (
        <CreateChannelModal communityId={communityId} onCreated={onRefresh} onClose={() => setShowCreate(false)} />
      )}
    </div>
  );
}
