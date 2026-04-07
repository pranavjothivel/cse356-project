import { useState } from "react";
import { apiPost } from "../api";

interface Props {
  onCreated: () => void;
  onClose: () => void;
}

export default function CreateCommunityModal({ onCreated, onClose }: Props) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    if (!name.trim()) return;
    const res = await apiPost("/communities", { name: name.trim() });
    if (res.ok) {
      onCreated();
      onClose();
    } else {
      const body = await res.json();
      setError(body.error || "Failed to create community");
    }
  };

  return (
    <div className="modal-container" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ minWidth: 300 }}>
        <h3 style={{ margin: "0 0 12px" }}>Create Community</h3>
        <div className="form-group">
          <label>Name</label>
          <input
            className="input-field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            placeholder="Community name"
            autoFocus
          />
        </div>
        {error && <div style={{ color: "#f04747", fontSize: "0.85em", marginBottom: 8 }}>{error}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn-small" style={{ background: "#444" }} onClick={onClose}>Cancel</button>
          <button className="btn-small" onClick={handleSubmit}>Create</button>
        </div>
      </div>
    </div>
  );
}
