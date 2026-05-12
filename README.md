# CSE 356 (Cloud Computing) - Course Project
## Cloud Hosted Real-time Messenging App (Discord-like)
### Authors: Pranav Jothivel, Christopher Brinker, Jacky Chen, and Zach Decena

## Description

A cloud-hosted, real-time text messaging service supporting both local accounts and OAuth sign-in (Google, GitHub, and a course-provided OpenID Connect provider), with multi-provider account linking and concurrent sessions across devices. Users organize into communities containing admin-managed public and private channels for persistent group chat, and can also hold direct conversations — one-to-one or as group DMs with their own join/leave semantics and ephemeral lifecycle — outside of any community. Each account carries a profile, avatar, and a presence status (online, idle, away, or offline) derived from connection activity, and can post Unicode messages with up to four image attachments that remain editable and deletable, with every change broadcasting to connected clients in real time. The platform also provides full-text search scoped to a community (honoring per-channel access) or to a direct conversation — filterable by author and time range — and tracks read state and read receipts server-side, so unread counts and receipts stay consistent across all of a user's devices.
