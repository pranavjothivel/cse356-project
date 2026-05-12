# Pending Server Fixes (from autograder client analysis)

## Context
The autograder generates an API client specific to our server. We cannot change the client.
Current generated client has two endpoints that don't match our server.

## Fix 1 — GET /api/unread
Client calls `GET /api/unread` in `getUnreadCounts()`.
Server only has `GET /api/conversations/unread`.
**Fix:** Add `/api/unread` route that proxies/mirrors the conversations/unread logic.

## Fix 2 — POST /api/channels/:id/read handling conversation IDs
Client calls `POST /api/channels/${conversationId}/read` in `markRead()` for DMs.
Server's channels read endpoint uses `requireChannelMember` — a conversation UUID fails this.
**Fix:** In the channels `/:channelId/read` handler, if `requireChannelMember` fails to find
a channel, fall back to conversation read logic (same as `POST /api/conversations/:id/read`).

## Fix 3 — searchUsers (self-resolving)
Client's `searchUsers()` searches through `GET /api/conversations` participants.
We added `GET /api/users/search?q=...` — autograder should regenerate client to use it next run.
No server-side fix needed.

## Community find-or-create (deferred)
POST /communities with duplicate name currently returns 409 + community ID in body.
Outage monitor doesn't handle 409 — keeps firing "cannot be found on server".
Proposed fix: find-or-create (auto-join existing community on duplicate name, return 200).
Waiting to see if current 409+ID deploy stops outage monitor before implementing.
