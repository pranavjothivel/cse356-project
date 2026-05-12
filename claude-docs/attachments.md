# File Attachments Architecture

## Overview

File attachments are stored on a dedicated NFS VM with an attached block volume. All app nodes and the LB node mount the NFS export, making the system fully stateless — any app node can handle any upload request since they all see the same filesystem.

---

## Why This Works for a Stateless System

App nodes never own files. They write to and read from a shared NFS mount. No sticky sessions are needed for uploads or downloads because every node sees the same `/mnt/uploads` path.

---

## Topology

```
Client
  │
  ├─ POST /api/upload ──► HAProxy ──► App node (any)
  │                                        │
  │                                        ▼
  │                                   writes to /mnt/uploads (NFS mount)
  │                                        │
  │                                        ▼
  │                                   inserts row into PostgreSQL attachments table
  │
  └─ GET /uploads/* ────► HAProxy ──► Nginx on LB
                                           │
                                           ▼
                                      serves directly from /mnt/uploads (NFS mount)
                                      (app nodes never touched for downloads)
```

Downloads bypass app nodes entirely — Nginx on the LB serves files directly from its own NFS mount. This scales well: adding app nodes does not increase download capacity pressure.

---

## NFS Setup

A dedicated VM exports its block volume over NFS on the private network:

```bash
# On NFS VM — install and configure
apt-get install -y nfs-kernel-server
mkdir -p /mnt/uploads-vol

# /etc/exports
/mnt/uploads-vol  10.0.0.0/8(rw,sync,no_subtree_check,no_root_squash)

exportfs -ra
systemctl enable nfs-kernel-server
systemctl start nfs-kernel-server
```

All app nodes and the LB node mount it:

```bash
# On each app node and LB node
apt-get install -y nfs-common
mkdir -p /mnt/uploads
echo "<nfs-vm-private-ip>:/mnt/uploads-vol  /mnt/uploads  nfs  defaults,soft,timeo=30  0  0" >> /etc/fstab
mount -a
```

`soft` + `timeo=30` prevents app nodes from hanging indefinitely if NFS goes down.

---

## Filesystem Layout

```
/mnt/uploads/
  {userId}/
    {uuid}.{ext}
```

Bucketed by user to avoid flat directories with millions of files. UUID filename prevents collisions and path traversal attacks.

---

## PostgreSQL Schema

```sql
CREATE TABLE attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id   UUID NOT NULL REFERENCES users(id),
  message_id    UUID REFERENCES messages(id),   -- NULL until message is sent
  position      INTEGER NOT NULL CHECK (position BETWEEN 0 AND 3),
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size          INTEGER NOT NULL,
  path          TEXT NOT NULL,                  -- relative: {userId}/{uuid}.ext
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## Upload Flow

1. Client `POST /api/upload` with file
2. App node validates mime type and size
3. App node writes file to `/mnt/uploads/{userId}/{uuid}.ext`
4. App node inserts `attachments` row with `message_id = NULL`
5. App node returns `{ id, path }` to client
6. Client includes attachment IDs when sending a message
7. App node sets `message_id` on those rows when the message is created

---

## Download Flow

1. Client `GET /uploads/{userId}/{uuid}.ext`
2. HAProxy routes to Nginx on LB (not an app node)
3. Nginx serves file directly from `/mnt/uploads/{userId}/{uuid}.ext`

Nginx config on LB:
```nginx
location /uploads/ {
    alias /mnt/uploads/;
}
```

---

## Orphan Cleanup

Attachments uploaded but never attached to a message (`message_id IS NULL`) are cleaned up by a cron job on the NFS/DB VM:

```sql
-- Find orphaned attachments older than 1 hour
SELECT path FROM attachments
WHERE message_id IS NULL AND created_at < NOW() - INTERVAL '1 hour';
```

```bash
# Cron: run every hour
# 1. Query orphaned paths from PostgreSQL
# 2. Delete files from /mnt/uploads/
# 3. DELETE FROM attachments WHERE message_id IS NULL AND created_at < NOW() - INTERVAL '1 hour'
```

---

## Failure Modes

| Failure | Impact | Mitigation |
|---|---|---|
| NFS VM down | Uploads fail, downloads fail | `soft` mount — app nodes return errors instead of hanging. NFS can be colocated with PostgreSQL VM to reduce single points of failure. |
| App node down | Uploads rerouted to other nodes by HAProxy | Stateless — no impact |
| LB Nginx down | Downloads fail | HAProxy can temporarily route `/uploads/*` to an app node as fallback |

---

## Option B: Dedicated Attachment Microservice (future)

If file handling needs independent scaling, a standalone service can be extracted:

```
Client → LB → Attachment service VM
               ↓ reads/writes NFS directly
               ↓ writes metadata to PostgreSQL
```

App nodes would POST upload requests to this service rather than handling files themselves. Adds a network hop and operational complexity — not needed at current scale.

---

## Colocation Note

The NFS VM can be colocated with PostgreSQL to save cost. They don't compete: NFS is disk I/O bound, PostgreSQL is CPU/memory bound with sequential disk writes. Redis should remain separate (memory bound).
