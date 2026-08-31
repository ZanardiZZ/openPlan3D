#!/usr/bin/env python3
"""Small local-first sync server for OpenPlan3D.

Stores project JSON and metadata in SQLite. The browser remains authoritative
while offline; PUT uses an optimistic revision check to prevent silent loss.
"""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

HOST = os.getenv("OPENPLAN3D_SYNC_HOST", "127.0.0.1")
PORT = int(os.getenv("OPENPLAN3D_SYNC_PORT", "8787"))
DATA_DIR = Path(os.getenv("OPENPLAN3D_DATA_DIR", "./data"))
DB_PATH = Path(os.getenv("OPENPLAN3D_DB", str(DATA_DIR / "projects.sqlite3")))
SYNC_TOKEN = os.getenv("OPENPLAN3D_SYNC_TOKEN", "")
ALLOWED_ORIGIN = os.getenv("OPENPLAN3D_ALLOWED_ORIGIN", "")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        project_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )""")
    conn.commit()
    return conn


class SyncHandler(BaseHTTPRequestHandler):
    server_version = "OpenPlan3DSync/1.0"

    def log_message(self, format, *args):
        # Keep project contents and credentials out of logs.
        print(f"[{self.log_date_time_string()}] {self.command} {self.path.split('?')[0]} - {format % args}")

    def _send(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if ALLOWED_ORIGIN:
            self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        if not SYNC_TOKEN:
            return True
        return self.headers.get("Authorization", "") == f"Bearer {SYNC_TOKEN}"

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 20 * 1024 * 1024:
            raise ValueError("invalid request body")
        value = json.loads(self.rfile.read(length))
        if not isinstance(value, dict):
            raise ValueError("request must be an object")
        return value

    def _project_id(self):
        path = urlparse(self.path).path
        if path.startswith("/api/sync"):
            path = path[len("/api/sync"):]
        parts = [unquote(p) for p in path.split("/") if p]
        if len(parts) == 2 and parts[0] == "projects":
            return parts[1]
        return None

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        if ALLOWED_ORIGIN:
            self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
        self.end_headers()

    def do_GET(self):
        if not self._authorized():
            return self._send(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
        path = urlparse(self.path).path
        if path.startswith("/api/sync"):
            path = path[len("/api/sync"): ] or "/"
        with connection() as conn:
            if path == "/projects":
                rows = conn.execute("SELECT id, name, revision, updated_at FROM projects ORDER BY updated_at DESC").fetchall()
                return self._send(HTTPStatus.OK, {"projects": [dict(row) for row in rows]})
            project_id = self._project_id()
            if project_id:
                row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
                if not row:
                    return self._send(HTTPStatus.NOT_FOUND, {"error": "project not found"})
                return self._send(HTTPStatus.OK, {"project": json.loads(row["project_json"]), "revision": row["revision"]})
        self._send(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_PUT(self):
        if not self._authorized():
            return self._send(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
        project_id = self._project_id()
        if not project_id:
            return self._send(HTTPStatus.NOT_FOUND, {"error": "not found"})
        try:
            body = self._read_json()
            project = body["project"]
            if not isinstance(project, dict) or project.get("id") != project_id:
                raise ValueError("project id mismatch")
            base_revision = body.get("baseRevision")
        except (KeyError, ValueError, json.JSONDecodeError) as exc:
            return self._send(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        timestamp = now()
        with connection() as conn:
            row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
            if row and base_revision != row["revision"]:
                return self._send(HTTPStatus.CONFLICT, {"error": "revision conflict", "project": json.loads(row["project_json"]), "revision": row["revision"]})
            revision = (row["revision"] + 1) if row else 1
            created_at = row["created_at"] if row else project.get("createdAt", timestamp)
            conn.execute("""INSERT INTO projects(id, name, project_json, revision, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name, project_json=excluded.project_json,
                revision=excluded.revision, updated_at=excluded.updated_at""",
                (project_id, str(project.get("name", "Untitled Project")), json.dumps(project, ensure_ascii=False), revision, created_at, timestamp))
            conn.commit()
        self._send(HTTPStatus.OK, {"revision": revision, "updatedAt": timestamp})

    def do_DELETE(self):
        if not self._authorized():
            return self._send(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
        project_id = self._project_id()
        if not project_id:
            return self._send(HTTPStatus.NOT_FOUND, {"error": "not found"})
        with connection() as conn:
            conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
            conn.commit()
        self._send(HTTPStatus.OK, {"deleted": project_id})


if __name__ == "__main__":
    print(f"OpenPlan3D sync server listening on {HOST}:{PORT}; database={DB_PATH}")
    ThreadingHTTPServer((HOST, PORT), SyncHandler).serve_forever()
