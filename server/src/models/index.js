const User = require('./User');
const Community = require('./Community');
const CommunityMember = require('./CommunityMember');
const Channel = require('./Channel');
const ChannelMember = require('./ChannelMember');

// Community associations
Community.belongsTo(User, { as: 'owner', foreignKey: 'owner_id' });
Community.hasMany(CommunityMember, { foreignKey: 'community_id', as: 'members' });
Community.hasMany(Channel, { foreignKey: 'community_id', as: 'channels' });

// CommunityMember associations
CommunityMember.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
CommunityMember.belongsTo(Community, { foreignKey: 'community_id', as: 'community' });

// User associations
User.hasMany(CommunityMember, { foreignKey: 'user_id' });

// Channel associations
Channel.belongsTo(Community, { foreignKey: 'community_id', as: 'community' });
Channel.hasMany(ChannelMember, { foreignKey: 'channel_id', as: 'members' });

// ChannelMember associations
ChannelMember.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
ChannelMember.belongsTo(Channel, { foreignKey: 'channel_id', as: 'channel' });

module.exports = { User, Community, CommunityMember, Channel, ChannelMember };
