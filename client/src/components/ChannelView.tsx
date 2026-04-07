interface Props {
  channelId: string;
  channelName: string;
}

export default function ChannelView({ channelName }: Props) {
  return (
    <div className="channel-view">
      <h3 style={{ color: "#ccc" }}>#{channelName}</h3>
      <p className="placeholder-text">Messages coming soon</p>
    </div>
  );
}
