import { useState } from "react";
import { apiPost } from "../api";

interface Props {
  onJoined: () => void;
  onClose: () => void;
}

export default function JoinCommunityModal({ onJoined, onClose }: Props) {
  const [communityId, setCommunityId] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    if (!communityId.trim()) return;
    const res = await apiPost(`/communities/${communityId.trim()}/join`);
    if (res.ok) {
      onJoined();
      onClose();
    } else {
      const body = await res.json();
      setError(body.error || "Failed to join community");
    }
  };

  return (
    <div className="modal-container" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ minWidth: 300 }}>
        <h3 style={{ margin: "0 0 12px" }}>Join Community</h3>
        <div className="form-group">
          <label>Community ID</label>
          <input
            className="input-field"
            value={communityId}
            onChange={(e) => setCommunityId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            placeholder="Paste community ID"
            autoFocus
          />
        </div>
        {error && <div style={{ color: "#f04747", fontSize: "0.85em", marginBottom: 8 }}>{error}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn-small" style={{ background: "#444" }} onClick={onClose}>Cancel</button>
          <button className="btn-small" onClick={handleSubmit}>Join</button>
        </div>
      </div>
    </div>
  );
}
