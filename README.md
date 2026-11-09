# Smart Driver Behaviour Analyser

A student-built academic prototype that uses smartphone motion sensors and GPS speed (when available) to analyse short sensor windows and estimate driving-behaviour categories.

## Features
- Browser-based accelerometer and gyroscope readings.
- GPS speed input when the browser/device provides it and permission is granted.
- FastAPI backend with a saved scikit-learn classifier.
- Prototype classifications: normal driving, harsh acceleration, harsh braking, sharp turning and rough road.
- Optional, consent-based upload of seven-number feature summaries for later review.

## Run locally
Use Python 3.11–3.13 in a virtual environment.

```bash
pip install -r requirements.txt
```

Set a private collection code before enabling data collection (PowerShell):

```powershell
$env:COLLECTOR_ACCESS_CODE = "choose-a-long-private-random-value"
uvicorn backend:app --reload
```

Open `http://127.0.0.1:8000`. For phone sensor access, use a secure HTTPS deployment or a trusted HTTPS development tunnel. Keep the page open and the phone securely mounted during any controlled test. Never handle a phone while driving.

## Deploy on Render
1. Push this folder to a **private or public GitHub repository** after reviewing it.
2. In Render, create a new **Blueprint** and select the repository. Render reads `render.yaml`.
3. The blueprint generates a private `COLLECTOR_ACCESS_CODE` environment variable. Copy its value into the collection-code field only for people you explicitly authorize.
4. After deployment, open the Render URL and test `/api/status`. It should report `model_loaded: true`.

The app writes collection files to its local filesystem. On free/ephemeral hosting, those files may be lost on restart or redeploy. Do not rely on this deployment as permanent research-data storage; use a properly secured persistent database/storage service for ongoing collection.

## Training data and evaluation
- `synthetic_driver_data.csv` is simulated data used to train the included model. It is not real-world driving data.
- `collected_windows.csv` and participant-specific collection records are deliberately excluded from this repository.
- `training_data_template.csv` is an empty schema template.
- A high test score on synthetic data does not establish real-world accuracy. Validate using consented, safely collected, independently labelled trips and split evaluation by trip/driver.

## Limitations
- Results depend on phone model, mounting position, orientation, sensor availability and sampling behaviour.
- GPS speed may be unavailable or noisy.
- Some behaviours, especially braking and rough-road movement, can produce overlapping sensor patterns.
- This is an academic prototype, not a certified driver-safety, collision-detection or insurance system.

## Search visibility
The page includes a descriptive title and metadata. Google may discover and index the deployed site after it is submitted through Google Search Console, but indexing and ranking are not guaranteed and may take time.
