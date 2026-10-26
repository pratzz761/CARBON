import base64
import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.main import app
from backend.optimizer import ExperimentRequest, Scenario, evaluate, optimise
from backend.storage import SQLiteStore, now


def request_data():
    return {"profile": "normal", "source": "sample", "candidates": [
        {"window_ms": timer, "scenarios": [
            {"name": split, "split": split, "duration_ms": 1000, "users": 3,
             "converged": True, "batches": [
                {"at_ms": 100 + timer, "bytes": 20, "author": 0, "edit_times": [100]}
             ]}
            for split in ["calibration", "validation"]
        ]} for timer in range(0, 301, 10)
    ]}


class OptimizerTests(unittest.TestCase):
    def test_unconstrained_network_selects_immediate(self):
        result = optimise(ExperimentRequest(**request_data()))
        self.assertEqual(result["selected_window_ms"], 0)
        self.assertTrue(result["validation_passed"])

    def test_validation_does_not_influence_selection(self):
        body = request_data()
        body["candidates"][0]["scenarios"][1]["batches"][0]["at_ms"] = 2000
        result = optimise(ExperimentRequest(**body))
        self.assertEqual(result["selected_window_ms"], 0)
        self.assertFalse(result["validation_passed"])

    def test_no_feasible_candidate_returns_none(self):
        body = request_data()
        for candidate in body["candidates"]:
            candidate["scenarios"][0]["converged"] = False
        result = optimise(ExperimentRequest(**body))
        self.assertIsNone(result["selected_window_ms"])

    def test_fifo_queue_counts_fanout_and_final_drain(self):
        scenario = Scenario(name="Tail", split="calibration", duration_ms=1000,
                            users=3, converged=True, batches=[
                                {"at_ms": 1100, "bytes": 98, "author": 0, "edit_times": [990]}
                            ])
        result = evaluate(scenario, {"capacity_bps": 1000, "budget_bps": 800, "propagation_ms": 50})
        self.assertEqual(result["total_bytes"], 200)
        self.assertEqual(result["messages"], 2)
        self.assertEqual(result["latency_ms"], 360)
        self.assertEqual(result["drain_ms"], 350)
        self.assertEqual(result["rate_bps"], 200)

    def test_incomplete_and_mismatched_search_is_rejected(self):
        body = request_data()
        body["candidates"][1]["window_ms"] = 0
        with self.assertRaises(ValidationError):
            ExperimentRequest(**body)
        body = request_data()
        body["candidates"][1]["scenarios"][0]["duration_ms"] = 2000
        with self.assertRaises(ValidationError):
            ExperimentRequest(**body)


class PersistenceTests(unittest.TestCase):
    def test_updates_survive_restart_and_duplicate_ids_are_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            from pathlib import Path
            store = SQLiteStore(Path(directory))
            store.create_note({"id": "test", "title": "Test", "created_at": now(),
                               "updated_at": now(), "window_ms": 0})
            store.append_updates("test", [("event-1", "AQID"), ("event-1", "AQID")])
            store.close()
            store = SQLiteStore(Path(directory))
            self.assertEqual(store.get_updates("test"), ["AQID"])
            self.assertEqual(store.get_note("test")["title"], "Test")
            store.close()


class APITests(unittest.TestCase):
    def test_room_relay_durable_ack_reload_and_policy_broadcast(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "CARBON_DATA_DIR": directory, "MONGODB_URI": ""
        }), TestClient(app) as client:
            note = client.post("/api/notes", json={"title": "Together"}).json()
            room_url = f"/ws/notes/{note['id']}"
            with client.websocket_connect(room_url) as first:
                first.send_json({"name": "Asha"})
                self.assertEqual(first.receive_json()["type"], "sync")
                first.receive_json()  # own presence
                with client.websocket_connect(room_url) as second:
                    second.send_json({"name": "Sam"})
                    second.receive_json()  # sync
                    self.assertEqual(len(second.receive_json()["peers"]), 2)
                    self.assertEqual(len(first.receive_json()["peers"]), 2)
                    payload = base64.b64decode("AQID")
                    first.send_bytes((7).to_bytes(4, "big") + payload)
                    self.assertEqual(second.receive_bytes(), payload)
                    self.assertEqual(first.receive_json(), {"type": "ack", "seq": 7})
                    saved = client.patch(f"/api/notes/{note['id']}", json={"window_ms": 100})
                    self.assertEqual(saved.status_code, 200)
                    self.assertEqual(second.receive_json()["note"]["window_ms"], 100)
                    first.receive_json()
            self.assertEqual(client.patch(f"/api/notes/{note['id']}", json={"window_ms": 15}).status_code, 422)
            with client.websocket_connect(room_url) as reloaded:
                reloaded.send_json({"name": "Returning"})
                sync = reloaded.receive_json()
                self.assertEqual(sync["updates"], ["AQID"])
                self.assertEqual(sync["note"]["window_ms"], 100)

    def test_experiment_api_persists_result(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "CARBON_DATA_DIR": directory, "MONGODB_URI": ""
        }), TestClient(app) as client:
            response = client.post("/api/experiments", json=request_data())
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["selected_window_ms"], 0)
            self.assertIn("id", response.json())


if __name__ == "__main__":
    unittest.main()
