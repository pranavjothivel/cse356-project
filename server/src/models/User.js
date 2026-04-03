const { DataTypes, Model } = require('sequelize');
const bcrypt = require('bcrypt');
const sequelize = require('../db');

class User extends Model {
  async verifyPassword(password) {
    if (!this.password_hash) return false;
    return bcrypt.compare(password, this.password_hash);
  }

  async setPassword(password) {
    this.password_hash = await bcrypt.hash(password, 12);
  }

  hasProvider(provider, providerId) {
    return (this.providers || []).some(
      p => p.provider === provider && p.provider_id === providerId
    );
  }

  linkProvider(provider, providerId, profile) {
    if (!this.hasProvider(provider, providerId)) {
      this.providers = [
        ...(this.providers || []),
        { provider, provider_id: providerId, display_name: profile.displayName, email: profile.email },
      ];
    }
  }

  unlinkProvider(provider, providerId) {
    this.providers = (this.providers || []).filter(
      p => !(p.provider === provider && p.provider_id === providerId)
    );
  }

  canUnlink(provider, providerId) {
    const remaining = (this.providers || []).filter(
      p => !(p.provider === provider && p.provider_id === providerId)
    );
    return !!this.password_hash || remaining.length > 0;
  }
}

User.init({
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  username: { type: DataTypes.STRING, unique: true, allowNull: true },
  password_hash: { type: DataTypes.STRING, allowNull: true },
  email: { type: DataTypes.STRING, unique: true, allowNull: true },
  display_name: { type: DataTypes.STRING, allowNull: true },
  // providers is a JSONB array: [{ provider, provider_id, display_name, email }]
  providers: { type: DataTypes.JSONB, defaultValue: [] },
  away: { type: DataTypes.BOOLEAN, defaultValue: false }
}, {
  sequelize,
  tableName: 'users',
  underscored: true,
});

module.exports = User;
