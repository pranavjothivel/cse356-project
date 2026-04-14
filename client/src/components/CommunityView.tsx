import { useState, useEffect, useCallback } from "react";
import { apiFetch, apiPost, apiDelete } from "../api";
import ChannelList from "./ChannelList";
import ChannelView from "./ChannelView";
import MemberList from "./MemberList";
import SearchModal from "./SearchModal";

interface ChannelInfo {
  id: string;
  name: string;
  is_private: boolean;
  is_joined: boolean;
  hasUnread?: boolean;
}

interface CommunityData {
  community: { id: string; name: string; owner_id: string; owner: any };
  role: string;
  channels: ChannelInfo[];
}

interface Props {
  communityId: string;
  onLeft: () => void;
}

export default function CommunityView({ communityId, onLeft }: Props) {
  const [data, setData] = useState<CommunityData | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [jumpToMessageId, setJumpToMessageId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    const res = await apiFetch(`/communities/${communityId}`);
    if (res.ok) {
      const d = await res.json();
      setData(d);
    }
  }, [communityId]);

  useEffect(() => {
    setData(null);
    setSelectedChannelId(null);
    fetchData();
  }, [communityId, fetchData]);

  // Handle real-time unread/read updates for channels
  useEffect(() => {
    const handler = (e: Event) => {
      const ev = (e as CustomEvent).detail;
      if (!ev?.type) return;
      if (ev.type === 'channel.unread') {
        setData(prev => prev ? {
          ...prev,
          channels: prev.channels.map(c => c.id === ev.channelId ? { ...c, hasUnread: true } : c),
        } : prev);
      } else if (ev.type === 'channel.read') {
        setData(prev => prev ? {
          ...prev,
          channels: prev.channels.map(c => c.id === ev.channelId ? { ...c, hasUnread: false } : c),
        } : prev);
      }
    };
    window.addEventListener('ws-event', handler);
    return () => window.removeEventListener('ws-event', handler);
  }, []);

  if (!data) return <div className="channel-view"><p className="placeholder-text">Loading...</p></div>;

  const handleLeave = async () => {
    const res = await apiPost(`/communities/${communityId}/leave`);
    if (res.ok) onLeft();
  };

  const handleDelete = async () => {
    if (!confirm("Delete this community? This cannot be undone.")) return;
    const res = await apiDelete(`/communities/${communityId}`);
    if (res.ok) onLeft();
  };

  const selectedChannel = data.channels.find((c) => c.id === selectedChannelId);

  return (
    <>
      <div className="main-content-header">
        <span style={{ fontWeight: "bold" }}>{data.community.name}</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn-small" style={{ fontSize: "0.8em" }} onClick={() => setShowSearch(true)}>Search</button>
          {data.role !== "owner" && (
            <button className="btn-small btn-danger" style={{ fontSize: "0.8em" }} onClick={handleLeave}>Leave</button>
          )}
          {data.role === "owner" && (
            <button className="btn-small btn-danger" style={{ fontSize: "0.8em" }} onClick={handleDelete}>Delete</button>
          )}
        </div>
      </div>
      <div className="community-body">
        <ChannelList
          communityId={communityId}
          channels={data.channels}
          userRole={data.role}
          selectedId={selectedChannelId}
          onSelect={setSelectedChannelId}
          onRefresh={fetchData}
        />
        {selectedChannel && selectedChannel.is_joined ? (
          <ChannelView channelId={selectedChannel.id} channelName={selectedChannel.name} channelPrivate={selectedChannel.is_private} communityId={communityId} userRole={data.role} onRefresh={fetchData} jumpToMessageId={jumpToMessageId} onJumpComplete={() => setJumpToMessageId(null)}/>
        ) : (
          <div className="channel-view">
            <p className="placeholder-text">Select a channel</p>
          </div>
        )}
        <MemberList communityId={communityId} userRole={data.role} />
      </div>
      {showSearch && (
        <SearchModal
          scope="community"
          scopeId={communityId}
          onClose={() => setShowSearch(false)}
          onJumpTo={(result) => {
            if (result.channelId) {
              setSelectedChannelId(result.channelId);
              setJumpToMessageId(result.id);
            }
            setShowSearch(false);
          }}
        />
      )}
    </>
  );
}
