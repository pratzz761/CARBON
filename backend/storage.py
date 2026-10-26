"""Small interchangeable stores. Both preserve CRDT bytes, not rendered text."""

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock

ROOT = Path(__file__).resolve().parents[1]


def now():
    return datetime.now(timezone.utc).isoformat()


class SQLiteStore:
    kind = "local"

    def __init__(self, directory):
        directory.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(directory / "carbon.sqlite3", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = RLock()
        with self.db:
            self.db.executescript("""
                CREATE TABLE IF NOT EXISTS notes (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL, window_ms INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS updates (
                    position INTEGER PRIMARY KEY AUTOINCREMENT, note_id TEXT NOT NULL,
                    event_id TEXT NOT NULL, data TEXT NOT NULL,
                    UNIQUE(note_id, event_id)
                );
                CREATE INDEX IF NOT EXISTS updates_note ON updates(note_id, position);
                CREATE TABLE IF NOT EXISTS experiments (
                    id TEXT PRIMARY KEY, data TEXT NOT NULL
                );
            """)

    def list_notes(self):
        with self.lock:
            return [dict(row) for row in self.db.execute("SELECT * FROM notes ORDER BY updated_at DESC")]

    def get_note(self, note_id):
        with self.lock:
            row = self.db.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
            return dict(row) if row else None

    def create_note(self, note):
        with self.lock, self.db:
            self.db.execute(
                "INSERT OR IGNORE INTO notes VALUES (?, ?, ?, ?, ?)",
                tuple(note[key] for key in ("id", "title", "created_at", "updated_at", "window_ms")),
            )
        return self.get_note(note["id"])

    def patch_note(self, note_id, fields):
        fields = {key: value for key, value in fields.items() if key in {"title", "window_ms"}}
        fields["updated_at"] = now()
        with self.lock, self.db:
            for key, value in fields.items():
                self.db.execute(f"UPDATE notes SET {key} = ? WHERE id = ?", (value, note_id))
        return self.get_note(note_id)

    def get_updates(self, note_id):
        with self.lock:
            return [row[0] for row in self.db.execute(
                "SELECT data FROM updates WHERE note_id = ? ORDER BY position", (note_id,)
            )]

    def append_updates(self, note_id, updates):
        with self.lock, self.db:
            self.db.executemany(
                "INSERT OR IGNORE INTO updates(note_id, event_id, data) VALUES (?, ?, ?)",
                [(note_id, event_id, data) for event_id, data in updates],
            )
            self.db.execute("UPDATE notes SET updated_at = ? WHERE id = ?", (now(), note_id))

    def save_experiment(self, experiment):
        with self.lock, self.db:
            self.db.execute("INSERT INTO experiments VALUES (?, ?)", (experiment["id"], json.dumps(experiment)))

    def close(self):
        self.db.close()


class MongoStore:
    kind = "mongodb"

    def __init__(self, uri):
        from pymongo import MongoClient

        self.client = MongoClient(uri, serverSelectionTimeoutMS=4000)
        self.client.admin.command("ping")
        self.db = self.client[os.getenv("MONGODB_DATABASE", "carbon_notes")]
        self.db.updates.create_index([("note_id", 1), ("event_id", 1)], unique=True)
        self.db.updates.create_index([("note_id", 1), ("_id", 1)])

    def list_notes(self):
        return list(self.db.notes.find({}, {"_id": 0}).sort("updated_at", -1))

    def get_note(self, note_id):
        return self.db.notes.find_one({"id": note_id}, {"_id": 0})

    def create_note(self, note):
        self.db.notes.update_one({"id": note["id"]}, {"$setOnInsert": note}, upsert=True)
        return self.get_note(note["id"])

    def patch_note(self, note_id, fields):
        fields = {key: value for key, value in fields.items() if key in {"title", "window_ms"}}
        self.db.notes.update_one({"id": note_id}, {"$set": {**fields, "updated_at": now()}})
        return self.get_note(note_id)

    def get_updates(self, note_id):
        return [row["data"] for row in self.db.updates.find({"note_id": note_id}).sort("_id", 1)]

    def append_updates(self, note_id, updates):
        from pymongo import UpdateOne

        if updates:
            self.db.updates.bulk_write([
                UpdateOne({"note_id": note_id, "event_id": event_id},
                          {"$setOnInsert": {"data": data}}, upsert=True)
                for event_id, data in updates
            ], ordered=True)
            self.db.notes.update_one({"id": note_id}, {"$set": {"updated_at": now()}})

    def save_experiment(self, experiment):
        self.db.experiments.insert_one(dict(experiment))

    def close(self):
        self.client.close()


def open_store():
    uri = os.getenv("MONGODB_URI")
    if uri:
        return MongoStore(uri)
    return SQLiteStore(Path(os.getenv("CARBON_DATA_DIR", str(ROOT / "data"))))
