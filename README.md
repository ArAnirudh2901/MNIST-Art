# MNIST Mosaic Studio

MNIST Mosaic Studio is a split web app that turns portrait uploads into
high-resolution photomosaics made entirely from handwritten MNIST digits.

It uses:

- a `Next.js` frontend for upload, tuning controls, live progress, preview, and
  download
- a `FastAPI` backend for MNIST loading, image sanitization, and mosaic
  generation

## What the app does

- Upload a portrait image from the web UI
- Tune render controls such as tile size, gamma, CLAHE contrast, background
  threshold, and upscale
- Watch live fabrication progress from the backend job pipeline
- Preview both the source frame and the final mosaic
- Download the rendered result as a PNG

## Architecture

The frontend sends the selected portrait to the FastAPI backend as a multipart
form upload. The backend:

1. validates the file
2. strips metadata by decoding and re-encoding it as a lossless PNG
3. loads or reuses the cached MNIST tile library
4. runs the mosaic pipeline in a background worker
5. exposes job progress and the final image over polling endpoints

The frontend polls the job status until the result is complete, then fetches
the final PNG.

## Project structure

```text
mnist-art/
├── .gitignore
├── README.md
├── backend/
│   ├── .env.example
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py
│   │   └── mosaic.py
│   ├── data/
│   │   └── MNIST/
│   │       └── raw/
│   └── pyproject.toml
└── frontend/
    ├── .env.example
    ├── package.json
    └── src/
        ├── app/
        │   ├── favicon.ico
        │   ├── globals.css
        │   ├── layout.js
        │   └── page.js
        └── components/
            ├── app-toaster.js
            ├── generate-mosaic-button.js
            ├── liquid-glass-panel.js
            └── mnist-digit-grid-background.js
```

## Requirements

- `Python 3.10+`
- `Bun 1.x`

The README examples use Bun for the frontend because that is the workflow used
in this repo.

## Quick start

### 1. Start the backend

```bash
cd /Users/anirudharavalli/Web_Dev/NextJS/mnist-art/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

Notes:

- The backend runs on `http://127.0.0.1:8000` by default.
- The first request may take longer because the backend may need to download the
  raw MNIST IDX files and build the in-memory glyph library.

### 2. Start the frontend

```bash
cd /Users/anirudharavalli/Web_Dev/NextJS/mnist-art/frontend
bun install
cp .env.example .env.local
bun run dev
```

Open `http://localhost:3000`.

## Environment variables

### Frontend

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | `http://127.0.0.1:8000` | Base URL for the FastAPI backend |

### Backend

| Variable | Default | Purpose |
| --- | --- | --- |
| `CORS_ALLOW_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Allowed frontend origins |
| `MAX_UPLOAD_BYTES` | `20971520` | Maximum upload size in bytes (`20 MB`) |
| `JOB_TTL_SECONDS` | `3600` | How long completed or failed jobs remain available |
| `JOB_WORKERS` | `2` | Number of background worker threads for mosaic jobs |
| `MNIST_AUTO_DOWNLOAD` | `1` | Automatically download MNIST raw files if missing |
| `MNIST_TRAIN_IMAGES_URL` | Google storage MNIST URL | Optional override for the training image archive |
| `MNIST_TEST_IMAGES_URL` | Google storage MNIST URL | Optional override for the test image archive |

## Upload rules and processing behavior

- Accepted input is any file that resolves to `image/*`
- The frontend and backend both enforce a `20 MB` upload limit
- Uploaded images are sanitized before processing:
  - metadata is removed
  - the image is re-encoded as a lossless PNG
- The backend rejects corrupt or unsupported image uploads
- The mosaic library uses both original MNIST glyphs and inverted glyphs

## Render controls

The web UI exposes these controls:

- `Tile size`
- `Gamma`
- `CLAHE contrast`
- `Background threshold`
- `Upscale`

Backend validation currently accepts:

- `tile_size`: `4` to `64`
- `upscale`: `1` to `5`, or omitted for auto
- `gamma`: `0.3` to `1.8`
- `contrast`: `0.5` to `8.0`
- `bg_thresh`: `0` to `255`

## API

The backend is job-based. The old single-request `/api/mosaic` flow is no
longer the active interface.

### `GET /api/health`

Returns service health and runtime state.

Example response:

```json
{
  "status": "ok",
  "libraryLoaded": false,
  "mnistDataDir": "/path/to/backend/data/MNIST/raw",
  "activeJobs": 0
}
```

### `POST /api/mosaic/jobs`

Creates a new mosaic job.

Multipart form fields:

- `image` (required)
- `tile_size`
- `upscale` (optional, omit for auto)
- `gamma`
- `contrast`
- `bg_thresh`

Returns `202 Accepted` with a job object like:

```json
{
  "id": "job-id",
  "status": "queued",
  "progress": 0,
  "stage": "queued",
  "message": "Job accepted",
  "completedRows": 0,
  "totalRows": 0,
  "metadata": null,
  "error": null,
  "createdAt": 0,
  "updatedAt": 0
}
```

### `GET /api/mosaic/jobs/{job_id}`

Returns the current job state.

Possible job statuses:

- `queued`
- `running`
- `completed`
- `failed`

### `GET /api/mosaic/jobs/{job_id}/image`

Returns the finished PNG once the job has completed.

If the image is not ready yet, the endpoint returns `409`.

Response headers include:

- `Content-Disposition`
- `X-Mosaic-Width`
- `X-Mosaic-Height`
- `X-Mosaic-Rows`
- `X-Mosaic-Cols`
- `X-Mosaic-Upscale`
- `X-Mosaic-Tile-Size`
- `X-Mosaic-Render-Size`
- `X-Mosaic-Total-Tiles`
- `X-Mosaic-Pixel-Count`

## Example local flow

Check backend health:

```bash
curl http://127.0.0.1:8000/api/health
```

Create a mosaic job:

```bash
curl -X POST http://127.0.0.1:8000/api/mosaic/jobs \
  -F "image=@image.jpg" \
  -F "tile_size=13" \
  -F "gamma=0.8" \
  -F "contrast=3.0" \
  -F "bg_thresh=5"
```

Poll a job:

```bash
curl http://127.0.0.1:8000/api/mosaic/jobs/<job_id>
```

Fetch the rendered image:

```bash
curl http://127.0.0.1:8000/api/mosaic/jobs/<job_id>/image --output mnist-mosaic.png
```

## Development commands

### Frontend

```bash
cd /Users/anirudharavalli/Web_Dev/NextJS/mnist-art/frontend
bun run dev
bun run lint
bun run build
```

### Backend

```bash
cd /Users/anirudharavalli/Web_Dev/NextJS/mnist-art/backend
source .venv/bin/activate
uvicorn app.main:app --reload --port 8000
python3 -m py_compile app/main.py app/mosaic.py
```

## MNIST dataset notes

- Raw MNIST IDX files are stored under `backend/data/MNIST/raw/`
- If they do not exist and `MNIST_AUTO_DOWNLOAD=1`, the backend downloads them
  automatically
- If auto-download is disabled, place the raw files in that directory manually

## Troubleshooting

### The frontend says the backend is offline

- Make sure FastAPI is running on the URL configured in `NEXT_PUBLIC_API_URL`
- Verify the backend health endpoint:

```bash
curl http://127.0.0.1:8000/api/health
```

### The first mosaic request is slow

That is expected on a fresh backend start if the MNIST files are still being
downloaded or the glyph library has not been built yet.

### Uploads are rejected

- Keep the file size at or below `20 MB`
- Upload a real image file
- If the backend returns an image decode error, try a different export of the
  same image
