# Project Specification

Cloud-hosted, real-time text messaging app.

---

## 1. Authentication & Accounts

- Local accounts (username + password)
- OAuth: Google, GitHub, and course provider (realm: `oauth`)
  - OIDC discovery: `https://infra-auth.cse356.compas.cs.stonybrook.edu/realms/oauth/.well-known/openid-configuration`
  - Client ID: `web-service`, Client Secret: `web-service-secret`
- OAuth sign-in: create new account OR connect to existing account
- Users can link multiple OAuth providers and set/change password from account settings
- Multiple simultaneous sessions supported; signing out of one session does not affect others

---

## 2. Profile & Presence

- Profile: display name, avatar, presence status
- Presence statuses (exactly 4):
  - **offline** — no active connections
  - **online** — ≥1 connection AND browser activity within the last 1 minute
  - **idle** — ≥1 connection but no activity in the last 1 minute
  - **away** — user-set override (overrides online/idle); can include an away message

---

## 3. Communities

- Users can join any number of communities and create at most 100
- A community is a named space with a membership list and channels
- UI shows the member list with presence info

---

## 4. Channels (within communities)

- Public or private; all channels are visible to community members
- Only community admins can create channels or change the public/private setting
- Messages are stored permanently
- Users can only read history for channels they have joined
- Joining a private channel grants access to its full history

---

## 5. Direct Conversations

- One-to-one or group DMs (outside of communities)
- Group DMs: explicit participant list with shared history; any member can invite others
- Participants can leave voluntarily but cannot be kicked
- If all participants leave → conversation and history are permanently erased
- Starting a new group DM with the same participants creates a new conversation with empty history

---

## 6. Messages

- Real-time delivery for connected users with persistent storage
- Each message includes: author, timestamp, unique ID, Unicode text, and up to 4 image attachments
- Infinite scroll up for message history
- Unread message notifications for channels even when not actively viewing them
- Users can edit and delete their own messages; edits and deletions propagate in real time to all connected users

---

## 7. Search

- Full-text search scoped to a community OR a single DM/group conversation
- Community search includes public channels and any private channels the user has access to
- Results reflect edits and deletions (near real-time consistency)
- Filters: author, time range
- Results are returned newest-first and include content, author, timestamp, and location context for jumping to the message

---

## 8. Read State

- Tracked server-side, per-user per-channel/DM (not per-device)
- Reading on one device marks as read everywhere
- New messages received after the last recorded read state mark the channel/DM as unread
- DMs: show read receipts (which participants have read)
- Channels: only expose read/unread state for the requesting user — per-user read positions are not shared
