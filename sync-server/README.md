# OpenPlan3D local sync server

This service is intentionally small and self-hosted. It stores project JSON and
revision metadata in SQLite; it never calls Firebase or any external service.

## Run

```bash
OPENPLAN3D_SYNC_HOST=0.0.0.0 \
OPENPLAN3D_DATA_DIR=/srv/openplan3d/data \
OPENPLAN3D_ALLOWED_ORIGIN=https://floorplan.example.lan \
python3 sync-server/server.py
```

The browser uses `PUBLIC_SYNC_URL` and defaults to `/api/sync`. Put the service
behind the same reverse proxy as the SvelteKit app, mapping `/api/sync` to this
process, or set `PUBLIC_SYNC_URL` to its private LAN URL.

Optional `OPENPLAN3D_SYNC_TOKEN` enables a bearer token, but a browser-visible
shared token is only appropriate behind a trusted private reverse proxy. For
multi-user access, put authentication at the reverse proxy instead of storing
credentials in project JSON.

## Protocol

- `GET /projects` — summaries and server revisions
- `GET /projects/:id` — project plus revision
- `PUT /projects/:id` — `{project, baseRevision}`; returns `409` with the server copy on conflict
- `DELETE /projects/:id`

Create a verified SQLite backup before production migrations. The database uses
WAL mode and should be backed up with SQLite-aware tooling or after a clean
shutdown, not by blindly copying a live `-wal` database.
