from pathlib import Path
from typing import List, Optional
from datetime import datetime, timezone
import csv
import threading
import os
import hmac
import joblib
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = BASE_DIR / "driver_model.joblib"
TRAINING_CSV = BASE_DIR / "training_data.csv"
COLLECTION_CSV = BASE_DIR / "collected_windows.csv"

# Share this code privately with your invited participants.
# Change it before sharing the site if you want a different cod
COLLECTOR_ACCESS_CODE = os.getenv("COLLECTOR_ACCESS_CODE", "change-this-code")

def verify_collection_access_code(candidate: str) -> None:
    """Fail closed unless the owner configures a private environment secret."""
    if not COLLECTOR_ACCESS_CODE:
        raise HTTPException(status_code=503, detail="Data collection is not configured.")
    if not hmac.compare_digest(candidate, COLLECTOR_ACCESS_CODE):
        raise HTTPException(status_code=403, detail="Incorrect collection access code.")
CSV_COLUMNS = [
    "mean_accel", "std_accel", "max_accel",
    "mean_gyro", "std_gyro", "max_gyro",
    "speed_change", "label", "participant_id", "collected_at"
]
csv_lock = threading.Lock()

app = FastAPI(title="Smart Driver Behaviour Analyser")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")

model = None
if MODEL_PATH.exists():
    try:
        model = joblib.load(MODEL_PATH)
    except Exception:
        model = None

class Sample(BaseModel):
    timestamp: float
    ax: float = 0
    ay: float = 0
    az: float = 0
    gx: float = 0
    gy: float = 0
    gz: float = 0
    speed_kmh: Optional[float] = None

class Batch(BaseModel):
    samples: List[Sample]

class TrainingSubmission(BaseModel):
    participant_id: str = Field(min_length=3, max_length=24, pattern=r"^[a-zA-Z0-9_-]+$")
    access_code: str = Field(min_length=1, max_length=100)
    consent: bool
    features: dict
    label: str

class AutomaticWindowSubmission(BaseModel):
    participant_id: str = Field(min_length=3, max_length=24, pattern=r"^[a-zA-Z0-9_-]+$")
    access_code: str = Field(min_length=1, max_length=100)
    consent: bool
    features: dict
    window_seconds: int = Field(default=10, ge=5, le=30)

def feature_vector(samples):
    a = np.array([[s.ax, s.ay, s.az] for s in samples], dtype=float)
    g = np.array([[s.gx, s.gy, s.gz] for s in samples], dtype=float)
    amag = np.linalg.norm(a, axis=1)
    gmag = np.linalg.norm(g, axis=1)
    speeds = [s.speed_kmh for s in samples if s.speed_kmh is not None]
    # Signed change: last available speed minus first available speed.
    # This preserves acceleration (+) versus deceleration (-) direction.
    speed_change = (speeds[-1] - speeds[0]) if len(speeds) > 1 else 0.0
    return np.array([[
        float(np.mean(amag)), float(np.std(amag)),
        float(np.max(amag)), float(np.mean(gmag)),
        float(np.std(gmag)), float(np.max(gmag)),
        float(speed_change)
    ]])

def classify(samples):
    x = feature_vector(samples)
    if model is not None:
        try:
            return str(model.predict(x)[0]), "machine_learning"
        except Exception:
            pass
    a = np.array([[s.ax, s.ay, s.az] for s in samples], dtype=float)
    g = np.array([[s.gx, s.gy, s.gz] for s in samples], dtype=float)
    amag = np.linalg.norm(a, axis=1)
    gmag = np.linalg.norm(g, axis=1)
    peak_a = float(np.max(amag)) if len(amag) else 0
    peak_g = float(np.max(gmag)) if len(gmag) else 0
    if peak_a > 18:
        return "possible_high_acceleration_event", "threshold_baseline"
    if peak_g > 3.0:
        return "possible_sharp_turn", "threshold_baseline"
    return "normal_or_unclassified", "threshold_baseline"

@app.get("/")
def home():
    return FileResponse(BASE_DIR / "static" / "index.html")

@app.post("/api/analyse")
def analyse(batch: Batch):
    if len(batch.samples) < 3:
        return {"ok": False, "message": "Send at least 3 sensor samples."}
    label, method = classify(batch.samples)
    speeds = [s.speed_kmh for s in batch.samples if s.speed_kmh is not None]
    return {
        "ok": True,
        "classification": label,
        "method": method,
        "sample_count": len(batch.samples),
        "average_speed_kmh": round(float(np.mean(speeds)), 1) if speeds else None,
        "note": "Prototype estimate only; validate thresholds and labels using controlled, safely collected data."
    }

@app.post("/api/collection/submit")
def submit_automatic_window(submission: AutomaticWindowSubmission):
    if not submission.consent:
        raise HTTPException(status_code=400, detail="Consent is required.")
    verify_collection_access_code(submission.access_code)
    feature_names = CSV_COLUMNS[:7]
    try:
        values = {name: float(submission.features[name]) for name in feature_names}
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Seven numeric features are required.")
    if not all(np.isfinite(value) for value in values.values()):
        raise HTTPException(status_code=400, detail="Feature values must be finite numbers.")
    columns = feature_names + ["participant_id", "collected_at", "window_seconds", "review_status"]
    row = {
        **values,
        "participant_id": submission.participant_id,
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "window_seconds": submission.window_seconds,
        "review_status": "unlabelled_pending_review"
    }
    with csv_lock:
        exists = COLLECTION_CSV.exists() and COLLECTION_CSV.stat().st_size > 0
        with COLLECTION_CSV.open("a", newline="", encoding="utf-8") as file:
            writer = csv.DictWriter(file, fieldnames=columns)
            if not exists:
                writer.writeheader()
            writer.writerow(row)
        with COLLECTION_CSV.open("r", newline="", encoding="utf-8") as file:
            total = sum(1 for _ in csv.DictReader(file))
    return {"ok": True, "total_windows": total}

@app.get("/api/collection/stats")
def collection_stats():
    if not COLLECTION_CSV.exists():
        return {"total_windows": 0}
    with csv_lock, COLLECTION_CSV.open("r", newline="", encoding="utf-8") as file:
        total = sum(1 for _ in csv.DictReader(file))
    return {"total_windows": total}

@app.post("/api/training/submit")
def submit_training_record(submission: TrainingSubmission):
    if not submission.consent:
        raise HTTPException(status_code=400, detail="Consent is required.")
    verify_collection_access_code(submission.access_code)
    allowed_labels = {
        "normal_driving", "harsh_acceleration", "harsh_braking",
        "sharp_turning", "rough_road"
    }
    if submission.label not in allowed_labels:
        raise HTTPException(status_code=400, detail="Invalid behaviour label.")
    feature_names = CSV_COLUMNS[:7]
    try:
        row = {name: float(submission.features[name]) for name in feature_names}
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Seven numeric features are required.")
    if not all(np.isfinite(value) for value in row.values()):
        raise HTTPException(status_code=400, detail="Feature values must be finite numbers.")
    row.update({
        "label": submission.label,
        "participant_id": submission.participant_id,
        "collected_at": datetime.now(timezone.utc).isoformat()
    })
    with csv_lock:
        # Upgrade the original 8-column template (if present) to the shared
        # 10-column format while preserving any locally collected rows.
        existing_rows = []
        existing_header = []
        if TRAINING_CSV.exists() and TRAINING_CSV.stat().st_size > 0:
            with TRAINING_CSV.open("r", newline="", encoding="utf-8") as file:
                reader = csv.DictReader(file)
                existing_header = reader.fieldnames or []
                existing_rows = list(reader)

        if existing_header != CSV_COLUMNS:
            temp_path = TRAINING_CSV.with_suffix(".migrating")
            with temp_path.open("w", newline="", encoding="utf-8") as file:
                writer = csv.DictWriter(file, fieldnames=CSV_COLUMNS)
                writer.writeheader()
                for old_row in existing_rows:
                    migrated = {column: old_row.get(column, "") for column in CSV_COLUMNS}
                    writer.writerow(migrated)
            temp_path.replace(TRAINING_CSV)

        with TRAINING_CSV.open("a", newline="", encoding="utf-8") as file:
            writer = csv.DictWriter(file, fieldnames=CSV_COLUMNS)
            writer.writerow(row)
        with TRAINING_CSV.open("r", newline="", encoding="utf-8") as file:
            total_rows = sum(1 for _ in csv.DictReader(file))
    return {"ok": True, "saved": True, "total_rows": total_rows}

@app.get("/api/training/stats")
def training_stats():
    if not TRAINING_CSV.exists():
        return {"total_rows": 0}
    with csv_lock, TRAINING_CSV.open("r", newline="", encoding="utf-8") as file:
        total_rows = sum(1 for _ in csv.DictReader(file))
    return {"total_rows": total_rows}

@app.get("/api/status")
def status():
    return {
        "model_loaded": model is not None,
        "mode": "machine_learning" if model is not None else "threshold_baseline"
    }
