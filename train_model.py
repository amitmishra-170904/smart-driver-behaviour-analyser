"""
Train the integrated classifier from a labelled CSV.

Required columns:
mean_accel, std_accel, max_accel, mean_gyro, std_gyro, max_gyro,
speed_change, label

Collect and label your own sessions/events. Do not treat synthetic or
unverified data as evidence of real driving safety performance.
"""
from pathlib import Path
import pandas as pd
import joblib
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

BASE = Path(__file__).resolve().parent
CSV = BASE / "synthetic_driver_data.csv"
OUT = BASE / "driver_model.joblib"

FEATURES = [
    "mean_accel", "std_accel", "max_accel",
    "mean_gyro", "std_gyro", "max_gyro", "speed_change"
]

if not CSV.exists():
    raise SystemExit(f"{CSV.name} not found. Place the training CSV beside this script.")

df = pd.read_csv(CSV)

LABEL_COLUMN = "behaviour_label"

required_columns = FEATURES + [LABEL_COLUMN]

missing = [col for col in required_columns if col not in df.columns]

if missing:
    raise SystemExit(f"Missing columns in CSV: {missing}")

df = df.dropna(subset=required_columns)

if df[LABEL_COLUMN].nunique() < 2 or len(df) < 20:
    raise SystemExit("The training CSV must contain at least 20 rows and at least two behaviour classes.")

X = df[FEATURES]
y = df[LABEL_COLUMN].astype(str)
stratify = y if y.value_counts().min() >= 2 else None
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.25, random_state=42, stratify=stratify
)
model = make_pipeline(
    StandardScaler(),
    RandomForestClassifier(n_estimators=200, random_state=42, class_weight="balanced")
)
model.fit(X_train, y_train)
print(classification_report(y_test, model.predict(X_test), zero_division=0))
joblib.dump(model, OUT)
print(f"Saved model to {OUT}")
