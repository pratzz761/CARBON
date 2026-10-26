"""Finite constrained search over measured Yjs batches and a FIFO relay model."""

import math
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class Batch(BaseModel):
    at_ms: float = Field(ge=0, le=3_600_000)
    bytes: int = Field(ge=1, le=2_000_000)
    author: int = Field(ge=0, le=4)
    edit_times: list[float] = Field(min_length=1, max_length=10000)

    @model_validator(mode="after")
    def valid_times(self):
        if any(not math.isfinite(t) or t < 0 or t > self.at_ms for t in self.edit_times):
            raise ValueError("Edit times must be finite and precede the batch flush.")
        return self


class Scenario(BaseModel):
    name: str = Field(max_length=100)
    split: Literal["calibration", "validation"]
    duration_ms: float = Field(ge=1000, le=3_600_000)
    users: int = Field(ge=2, le=5)
    converged: bool
    batches: list[Batch] = Field(min_length=1, max_length=10000)

    @model_validator(mode="after")
    def valid_authors(self):
        if any(batch.author >= self.users for batch in self.batches):
            raise ValueError("Batch author must belong to the scenario.")
        if any(t > self.duration_ms for batch in self.batches for t in batch.edit_times):
            raise ValueError("An edit cannot occur after the trace duration.")
        return self


class Candidate(BaseModel):
    window_ms: int = Field(ge=0, le=300, multiple_of=10)
    scenarios: list[Scenario] = Field(min_length=2, max_length=4)


class ExperimentRequest(BaseModel):
    profile: Literal["normal", "shared", "limited"] = "shared"
    source: Literal["sample", "recorded"] = "sample"
    candidates: list[Candidate] = Field(min_length=31, max_length=31)

    @model_validator(mode="after")
    def complete_search(self):
        if sorted(c.window_ms for c in self.candidates) != list(range(0, 301, 10)):
            raise ValueError("Supply all 31 distinct timer candidates.")
        signature = None
        for candidate in self.candidates:
            current = [(s.name, s.split, s.duration_ms, s.users,
                        sum(len(b.edit_times) for b in s.batches)) for s in candidate.scenarios]
            if signature is not None and current != signature:
                raise ValueError("All candidates must evaluate the same scenarios and edit counts.")
            signature = current
            if not any(s.split == "calibration" for s in candidate.scenarios) or not any(
                s.split == "validation" for s in candidate.scenarios
            ):
                raise ValueError("Both calibration and held-out validation traces are required.")
        return self


PROFILES = {
    "normal": {"capacity_bps": 16384, "budget_bps": 13107, "propagation_ms": 20},
    "shared": {"capacity_bps": 1024, "budget_bps": 819, "propagation_ms": 60},
    "limited": {"capacity_bps": 512, "budget_bps": 409, "propagation_ms": 120},
}
LATENCY_LIMIT_MS = 500


def evaluate(scenario: Scenario, profile: dict):
    ready = 0.0
    delays = []
    total_bytes = 0
    max_queue_ms = 0.0
    for batch in sorted(scenario.batches, key=lambda b: b.at_ms):
        # One unmasked, unfragmented server-to-browser binary WebSocket frame.
        header = 2 if batch.bytes < 126 else 4 if batch.bytes < 65536 else 10
        frame_bytes = batch.bytes + header
        for recipient in range(scenario.users):
            if recipient == batch.author:
                continue
            start = max(ready, batch.at_ms)
            max_queue_ms = max(max_queue_ms, start - batch.at_ms)
            ready = start + frame_bytes / profile["capacity_bps"] * 1000
            applied_at = ready + profile["propagation_ms"]
            delays.extend(applied_at - t for t in batch.edit_times)
            total_bytes += frame_bytes
    delays.sort()
    latency = delays[math.ceil(0.95 * len(delays)) - 1]
    rate = total_bytes / (scenario.duration_ms / 1000)
    return {
        "name": scenario.name,
        "split": scenario.split,
        "latency_ms": round(latency, 2),
        "rate_bps": round(rate, 2),
        "messages": len(scenario.batches) * (scenario.users - 1),
        "total_bytes": total_bytes,
        "edits": sum(len(b.edit_times) for b in scenario.batches),
        "converged": scenario.converged,
        "max_queue_ms": round(max_queue_ms, 2),
        "drain_ms": round(max(0, ready + profile["propagation_ms"] - scenario.duration_ms), 2),
        "feasible": scenario.converged and rate <= profile["budget_bps"] and latency <= LATENCY_LIMIT_MS,
    }


def summarise(rows):
    return {
        "latency_ms": max(row["latency_ms"] for row in rows),
        "rate_bps": max(row["rate_bps"] for row in rows),
        "messages": sum(row["messages"] for row in rows),
        "converged": all(row["converged"] for row in rows),
        "feasible": all(row["feasible"] for row in rows),
    }


def optimise(request: ExperimentRequest):
    profile = PROFILES[request.profile]
    results = []
    for candidate in sorted(request.candidates, key=lambda c: c.window_ms):
        rows = [evaluate(scenario, profile) for scenario in candidate.scenarios]
        results.append({
            "window_ms": candidate.window_ms,
            "calibration": summarise([row for row in rows if row["split"] == "calibration"]),
            "validation": summarise([row for row in rows if row["split"] == "validation"]),
            "scenarios": rows,
        })
    feasible = [result for result in results if result["calibration"]["feasible"]]
    # Held-out results are deliberately excluded from selection.
    selected = min(feasible, key=lambda r: (
        r["calibration"]["latency_ms"], r["calibration"]["rate_bps"], r["window_ms"]
    )) if feasible else None
    return {
        "profile": request.profile,
        "source": request.source,
        "network": {**profile, "latency_limit_ms": LATENCY_LIMIT_MS},
        "selected_window_ms": selected["window_ms"] if selected else None,
        "validation_passed": selected["validation"]["feasible"] if selected else False,
        "results": results,
    }
