import { useState, useEffect, useContext } from "react";
import { apiFetch, apiPatch } from "../api";
import AuthContext from "../auth";

interface MemberInfo {
  user: { id: string; username: string; display_name: string; avatar: string };
  role: string;
  presence: string;
  joined_at: string;
}

interface Props {
  communityId: string;
  userRole: string;
}

export default function MemberList({ communityId, userRole }: Props) {
  const { auth } = useContext(AuthContext);
  const [members, setMembers] = useState<MemberInfo[]>([]);

  const fetchMembers = async () => {
    const res = await apiFetch(`/communities/${communityId}/members`);
    if (res.ok) {
      const data = await res.json();
      setMembers(data.members);
    }
  };

  useEffect(() => {
    fetchMembers();
    const interval = setInterval(fetchMembers, 30000);
    const wsHandler = (e: Event) => {
      const ev = (e as CustomEvent).detail;
      if (ev?.type === 'presence.changed') {
        setMembers(prev => prev.map(m =>
          m.user.id === ev.userId ? { ...m, presence: ev.presence } : m
        ));
      }
    };
    window.addEventListener('ws-event', wsHandler);
    return () => {
      clearInterval(interval);
      window.removeEventListener('ws-event', wsHandler);
    };
  }, [communityId]);

  const handleRoleChange = async (userId: string, newRole: string) => {
    const res = await apiPatch(`/communities/${communityId}/members/${userId}`, { role: newRole });
    if (res.ok) fetchMembers();
  };

  return (
    <div className="sidebar-right">
      <div className="sidebar-right-header">Members ({members.length})</div>
      {members.map((m) => (
        <div key={m.user.id} className="member-item">
          <span className={`presence-dot ${m.presence}`} />
          <span>{m.user.display_name || m.user.username || "User"}</span>
          <span className="role-badge">{m.role}</span>
          {userRole === "owner" && m.user.id !== auth.user?.id && m.role !== "owner" && (
            <button
              className="btn-small"
              style={{ padding: "1px 4px", fontSize: "0.65em", marginLeft: 4 }}
              onClick={() => handleRoleChange(m.user.id, m.role === "admin" ? "member" : "admin")}
            >
              {m.role === "admin" ? "Demote" : "Promote"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
