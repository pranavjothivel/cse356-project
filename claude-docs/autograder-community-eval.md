# Autograder Eval — Community Discovery & Join

> Temporary — delete when instructed.

## Community Discovery & Join — API Clarification for Evaluator

There are two separate endpoints for listing communities, and both must be called to get a complete picture:

**`GET /api/communities`** — returns only communities the authenticated user has already joined.

**`GET /api/communities/discover`** — returns all communities the authenticated user has *not* joined. This is an unbounded list with no pagination. An optional `?search=<query>` query parameter filters by name (case-insensitive substring match), but if omitted, every community the user hasn't joined is returned.

To find a community by name across all communities on the server, call `GET /api/communities/discover` (with or without a search term) and merge with `GET /api/communities`. The full dataset is the union of both responses.

---

## Creating vs. joining a community

`POST /api/communities` with body `{ "name": "<name>" }` creates a new community and auto-joins the creator. If a community with that name already exists, it returns:

```
HTTP 409
{ "error": "A community with this name already exists", "community": { "id": "<uuid>", "name": "<name>" } }
```

The 409 body includes the existing community's `id`. To join it, call:

```
POST /api/communities/<id>/join
```

This is a two-step flow: attempt create → on 409, extract `community.id` from the response → POST to join. The join endpoint auto-enrolls the user in all public channels of that community.

---

## Correct flow to enter a community by name

1. `POST /api/communities` `{ "name": "X" }`
2. If `201` → done, user is owner and member
3. If `409` → read `response.community.id` from the body → `POST /api/communities/<id>/join`
4. Community now appears in `GET /api/communities`
