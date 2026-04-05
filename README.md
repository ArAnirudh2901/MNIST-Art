# MNIST Mosaic Studio

A split web app for turning portrait uploads into photomosaics made from MNIST
digits:

- `frontend/`: Next.js upload UI
- `backend/`: FastAPI image-processing service

The frontend sends the selected image to the FastAPI backend, which runs the
Python mosaic pipeline and returns a PNG result.

## Project structure

```text
mnist-art/
├── backend/
│   ├── app/
│   │   ├── main.py
│   │   └── mosaic.py
│   └── pyproject.toml
└── frontend/
    └── src/app/
        ├── layout.js
        ├── page.js
        └── globals.css
```

## Local development

### 1. Start the backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
uvicorn app.main:app --reload --port 8000
```

The first mosaic request may also download the raw MNIST IDX files into
`backend/data/MNIST/raw/` if they are not already present.

### 2. Start the frontend

```bash
cd frontend
bun install
cp .env.example .env.local
bun run dev
```

Open `http://localhost:3000`.

## Environment variables

### Frontend

- `NEXT_PUBLIC_API_URL`: backend base URL, usually `http://127.0.0.1:8000`

### Backend

- `CORS_ALLOW_ORIGINS`: comma-separated allowed origins
- `MAX_UPLOAD_BYTES`: upload size limit in bytes, default `20971520` (`20 MB`)
- `MNIST_AUTO_DOWNLOAD`: set to `0` to disable automatic dataset download
- `MNIST_TRAIN_IMAGES_URL`: optional override for the training IDX URL
- `MNIST_TEST_IMAGES_URL`: optional override for the test IDX URL

## API

### `GET /api/health`

Returns the backend status and whether the MNIST library is already loaded.

### `POST /api/mosaic`

Accepts multipart form data with:

- `image`
- `tile_size`
- `upscale` (optional)
- `gamma`
- `contrast`
- `bg_thresh`

Returns a PNG image and these headers:

- `X-Mosaic-Width`
- `X-Mosaic-Height`
- `X-Mosaic-Rows`
- `X-Mosaic-Cols`
- `X-Mosaic-Upscale`
- `X-Mosaic-Tile-Size`

## Notes

- The FastAPI backend owns the MNIST dataset and all image processing.
- The Next.js frontend is only responsible for upload, controls, preview, and download.
- Use `bun run build` and `bun run lint` for frontend checks.
