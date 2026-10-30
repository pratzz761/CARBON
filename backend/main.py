import asyncio
import base64
import contextlib
import json
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .optimizer import ExperimentRequest, optimise
from .storage import ROOT, now, open_store

load_dotenv(ROOT / ".env")
logger = logging.getLogger("carbon")


@dataclass
class Peer:
    socket: WebSocket
    session: str
    name: str
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send(self, data):
        async with self.send_lock:
            if isinstance(data, bytes):
                await self.socket.send_bytes(data)
            else:
                await self.socket.send_json(data)


class Room:
    def __init__(self, note, updates, store):
        self.note = note
        self.updates = updates
        self.store = store
        self.peers = {}
        # Awareness is intentionally transient: it is neither persisted nor part of the
        # document-update batching experiment.
        self.awareness = {}
        self.pending = []
        self.lock = asyncio.Lock()
        self.flush_lock = asyncio.Lock()

    async def broadcast(self, message, exclude=None):
        for session, peer in list(self.peers.items()):
            if session != exclude:
                with contextlib.suppress(Exception):
                    await peer.send(message)

    async def presence(self):
        await self.broadcast({"type": "presence", "peers": [
            {"id": p.session, "name": p.name} for p in self.peers.values()
        ]})

    async def flush(self):
        async with self.flush_lock:
            async with self.lock:
                pending, self.pending = self.pending, []
            if not pending:
                return
            try:
                await asyncio.to_thread(self.store.append_updates, self.note["id"], [
                    (event_id, data) for event_id, data, _, _ in pending
                ])
            except Exception:
                async with self.lock:
                    self.pending = pending + self.pending
                logger.exception("Could not persist document updates")
                await self.broadcast({"type": "storage_error"})
                return
            for _, _, peer, seq in pending:
                with contextlib.suppress(Exception):
                    await peer.send({"type": "ack", "seq": seq})


@asynccontextmanager
async def lifespan(app):
    store = await asyncio.to_thread(open_store)
    app.state.store = store
    app.state.rooms = {}
    app.state.room_lock = asyncio.Lock()
    seed_file = Path(__file__).with_name("seed.json")
    if seed_file.exists():
        for seed in json.loads(seed_file.read_text(encoding="utf-8")):
            if not await asyncio.to_thread(store.get_note, seed["id"]):
                await asyncio.to_thread(store.create_note, {
                    "id": seed["id"], "title": seed["title"],
                    "created_at": now(), "updated_at": now(), "window_ms": 0,
                })
                await asyncio.to_thread(store.append_updates, seed["id"], [("seed", seed["update"])])

    async def persist_loop():
        while True:
            await asyncio.sleep(0.5)
            for room in list(app.state.rooms.values()):
                await room.flush()

    task = asyncio.create_task(persist_loop())
    yield
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    for room in list(app.state.rooms.values()):
        await room.flush()
    await asyncio.to_thread(store.close)


app = FastAPI(title="CARBON notes", lifespan=lifespan)


async def get_room(note_id):
    async with app.state.room_lock:
        if note_id not in app.state.rooms:
            note = await asyncio.to_thread(app.state.store.get_note, note_id)
            if not note:
                return None
            updates = await asyncio.to_thread(app.state.store.get_updates, note_id)
            app.state.rooms[note_id] = Room(note, updates, app.state.store)
        return app.state.rooms[note_id]


class NewNote(BaseModel):
    title: str = Field(default="Untitled note", min_length=1, max_length=120)


class PatchNote(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    window_ms: int | None = Field(default=None, ge=0, le=300, multiple_of=10)


@app.get("/api/health")
async def health():
    return {"status": "ok", "storage": app.state.store.kind}


@app.get("/api/notes")
async def list_notes():
    return await asyncio.to_thread(app.state.store.list_notes)


@app.post("/api/notes", status_code=201)
async def create_note(body: NewNote):
    timestamp = now()
    return await asyncio.to_thread(app.state.store.create_note, {
        "id": str(uuid4()), "title": body.title.strip() or "Untitled note",
        "created_at": timestamp, "updated_at": timestamp, "window_ms": 0,
    })


@app.patch("/api/notes/{note_id}")
async def patch_note(note_id: str, body: PatchNote):
    room = await get_room(note_id)
    if not room:
        raise HTTPException(404, "Note not found")
    fields = body.model_dump(exclude_none=True)
    if "title" in fields:
        fields["title"] = fields["title"].strip() or "Untitled note"
    async with room.lock:
        room.note = await asyncio.to_thread(app.state.store.patch_note, note_id, fields)
        await room.broadcast({"type": "note", "note": room.note})
    return room.note


@app.post("/api/experiments")
async def experiment(body: ExperimentRequest):
    result = await asyncio.to_thread(optimise, body)
    result.update({"id": str(uuid4()), "created_at": now()})
    await asyncio.to_thread(app.state.store.save_experiment, result)
    return result


@app.websocket("/ws/notes/{note_id}")
async def websocket_room(socket: WebSocket, note_id: str):
    room = await get_room(note_id)
    await socket.accept()
    if not room:
        await socket.close(code=4004, reason="Note not found")
        return
    session = str(uuid4())
    peer = Peer(socket, session, "Student")
    try:
        hello = await asyncio.wait_for(socket.receive_json(), timeout=10)
        peer.name = str(hello.get("name", "Student")).strip()[:30] or "Student"
        async with room.lock:
            # Holding the room lock prevents a gap between history and subscription.
            await peer.send({"type": "sync", "updates": room.updates,
                             "note": room.note, "session": session,
                             "awareness": list(room.awareness.values())})
            room.peers[session] = peer
            await room.presence()
        while True:
            message = await socket.receive()
            if message["type"] == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                packet = message["bytes"]
                if len(packet) <= 4 or len(packet) > 2_000_004:
                    await socket.close(code=1009, reason="Update size outside limits")
                    break
                seq = int.from_bytes(packet[:4], "big")
                update = packet[4:]
                encoded = base64.b64encode(update).decode("ascii")
                async with room.lock:
                    room.updates.append(encoded)
                    room.pending.append((f"{session}:{seq}", encoded, peer, seq))
                    await room.broadcast(update, exclude=session)
            elif message.get("text"):
                command = json.loads(message["text"])
                if command.get("type") == "name":
                    peer.name = str(command.get("name", "Student")).strip()[:30] or "Student"
                    await room.presence()
                elif command.get("type") == "awareness":
                    update = command.get("update")
                    if not isinstance(update, str) or len(update) > 16_384:
                        continue
                    try:
                        base64.b64decode(update, validate=True)
                    except ValueError:
                        continue
                    room.awareness[session] = update
                    await room.broadcast({"type": "awareness", "update": update}, exclude=session)
                elif command.get("type") == "ping":
                    await peer.send({"type": "pong", "sent_at": command.get("sent_at")})
    except (WebSocketDisconnect, asyncio.TimeoutError, ValueError):
        pass
    finally:
        async with room.lock:
            room.peers.pop(session, None)
            room.awareness.pop(session, None)
            await room.presence()


# A production build can be served by the same single FastAPI process.
if (ROOT / "dist").is_dir():
    app.mount("/", StaticFiles(directory=ROOT / "dist", html=True), name="frontend")
