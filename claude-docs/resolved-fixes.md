# Resolved Fixes

## PATCH /api/messages/:id with attachments: null — PR #57

**Symptom:** 12 grader search failures.

**Root cause:** Grader sends `PATCH` with `{ content: "...", attachments: null }`. Handler
had `if (attachments !== undefined) msg.attachments = attachments` — `null !== undefined`
is true, so `msg.attachments` was set to null, then `msg.save()` threw
`SequelizeValidationError: notNull Violation`.

**Why it caused search failures:** Grader flow is create message → edit via PATCH →
search for edited content. The PATCH 500 meant edited content was never saved, so
search found nothing.

**Fix:** `if (attachments !== undefined && attachments !== null)` in the PATCH handler
(`server/src/routes/messages.js`).

---

## Community join not transactional — PR #56

**Symptom:** Users were community members but got 403 "Not a channel member" on sendMessage.
5 users affected across 4 communities.

**Root cause:** `POST /api/communities/:id/join` used `CommunityMember.findOrCreate`
(committed immediately) then `ChannelMember.bulkCreate` in a separate operation. If
`bulkCreate` threw, community membership was already committed but channel enrollments
were missing. Retries returned 400 "Already a member" with no recovery path.

**Fix:** Wrapped both operations in a `sequelize.transaction()` so they commit atomically.
DB hotfix also applied to enroll the 5 already-affected users.
