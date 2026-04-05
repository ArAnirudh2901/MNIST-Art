from __future__ import annotations

import os
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware

from .mosaic import (
    DEFAULT_DATA_DIR,
    MosaicError,
    MosaicSettings,
    generate_mosaic_bytes,
    get_library,
    library_is_loaded,
    sanitize_upload_image_bytes,
)

DEFAULT_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]
EXPOSED_HEADERS = [
    "Content-Disposition",
    "X-Mosaic-Width",
    "X-Mosaic-Height",
    "X-Mosaic-Rows",
    "X-Mosaic-Cols",
    "X-Mosaic-Upscale",
    "X-Mosaic-Tile-Size",
    "X-Mosaic-Render-Size",
    "X-Mosaic-Total-Tiles",
    "X-Mosaic-Pixel-Count",
]

allowed_origins = [
    origin.strip()
    for origin in os.getenv("CORS_ALLOW_ORIGINS", ",".join(DEFAULT_ORIGINS)).split(",")
    if origin.strip()
]
max_upload_bytes = int(os.getenv("MAX_UPLOAD_BYTES", str(20 * 1024 * 1024)))
job_ttl_seconds = int(os.getenv("JOB_TTL_SECONDS", "3600"))
job_worker_count = int(os.getenv("JOB_WORKERS", "2"))

JOBS: dict[str, dict[str, object]] = {}
JOBS_LOCK = Lock()
JOB_EXECUTOR = ThreadPoolExecutor(
    max_workers=job_worker_count,
    thread_name_prefix="mnist-mosaic",
)

app = FastAPI(title="MNIST Mosaic API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=EXPOSED_HEADERS,
)


@app.on_event("shutdown")
def shutdown_job_executor() -> None:
    JOB_EXECUTOR.shutdown(wait=False, cancel_futures=True)


@app.get("/api/health")
async def health() -> dict[str, object]:
    return {
        "status": "ok",
        "libraryLoaded": library_is_loaded(),
        "mnistDataDir": str(DEFAULT_DATA_DIR),
        "activeJobs": _count_active_jobs(),
    }


def _count_active_jobs() -> int:
    with JOBS_LOCK:
        return sum(
            1
            for job in JOBS.values()
            if job["status"] in {"queued", "running"}
        )


def _prune_jobs() -> None:
    cutoff = time.time() - job_ttl_seconds
    with JOBS_LOCK:
        stale_job_ids = [
            job_id
            for job_id, job in JOBS.items()
            if job["status"] in {"completed", "failed"} and float(job["updatedAt"]) < cutoff
        ]
        for job_id in stale_job_ids:
            JOBS.pop(job_id, None)


def _serialize_job(job: dict[str, object]) -> dict[str, object]:
    return {
        "id": job["id"],
        "status": job["status"],
        "progress": job["progress"],
        "stage": job["stage"],
        "message": job["message"],
        "completedRows": job["completedRows"],
        "totalRows": job["totalRows"],
        "metadata": job["metadata"],
        "error": job["error"],
        "createdAt": job["createdAt"],
        "updatedAt": job["updatedAt"],
    }


def _create_job(filename: str | None) -> dict[str, object]:
    _prune_jobs()
    now = time.time()
    job_id = uuid4().hex
    job = {
        "id": job_id,
        "filename": filename,
        "status": "queued",
        "progress": 0.0,
        "stage": "queued",
        "message": "Job accepted",
        "completedRows": 0,
        "totalRows": 0,
        "metadata": None,
        "error": None,
        "resultBytes": None,
        "createdAt": now,
        "updatedAt": now,
    }
    with JOBS_LOCK:
        JOBS[job_id] = job
    return dict(job)


def _update_job(job_id: str, **changes: object) -> dict[str, object]:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            raise KeyError(job_id)

        if "progress" in changes:
            incoming_progress = float(changes["progress"])
            changes["progress"] = max(float(job["progress"]), incoming_progress)

        job.update(changes)
        job["updatedAt"] = time.time()
        return dict(job)


def _get_job(job_id: str) -> dict[str, object]:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Mosaic job not found.")
        return dict(job)


def _job_progress_callback(job_id: str, payload: dict[str, object]) -> None:
    _update_job(
        job_id,
        status="running",
        progress=payload.get("progress", 0.0),
        stage=payload.get("stage", "running"),
        message=payload.get("message", "Processing"),
        completedRows=payload.get("completed_rows", payload.get("completedRows", 0)),
        totalRows=payload.get("total_rows", payload.get("totalRows", 0)),
    )


def _build_mosaic_response(png_bytes: bytes, metadata: dict[str, object]) -> Response:
    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={
            "Content-Disposition": 'inline; filename="mnist-mosaic.png"',
            "X-Mosaic-Width": str(metadata["width"]),
            "X-Mosaic-Height": str(metadata["height"]),
            "X-Mosaic-Rows": str(metadata["rows"]),
            "X-Mosaic-Cols": str(metadata["cols"]),
            "X-Mosaic-Upscale": str(metadata["upscale"]),
            "X-Mosaic-Tile-Size": str(metadata["tile_size"]),
            "X-Mosaic-Render-Size": str(metadata["render_size"]),
            "X-Mosaic-Total-Tiles": str(metadata["total_tiles"]),
            "X-Mosaic-Pixel-Count": str(metadata["pixel_count"]),
        },
    )


def _run_mosaic_job(job_id: str, image_bytes: bytes, settings: MosaicSettings) -> None:
    try:
        _update_job(
            job_id,
            status="running",
            progress=1,
            stage="boot_sequence",
            message="Initializing mosaic pipeline",
        )

        library = get_library(
            DEFAULT_DATA_DIR,
            lambda payload: _job_progress_callback(job_id, payload),
        )
        _update_job(
            job_id,
            status="running",
            progress=22,
            stage="library_ready",
            message="Glyph library locked",
        )

        png_bytes, metadata = generate_mosaic_bytes(
            image_bytes,
            library,
            settings,
            lambda payload: _job_progress_callback(job_id, payload),
        )

        _update_job(
            job_id,
            status="completed",
            progress=100,
            stage="complete",
            message="Mosaic ready",
            completedRows=metadata["rows"],
            totalRows=metadata["rows"],
            metadata=metadata,
            resultBytes=png_bytes,
        )
    except MosaicError as exc:
        _update_job(
            job_id,
            status="failed",
            stage="failed",
            message="Mosaic generation failed",
            error=str(exc),
        )
    except Exception:
        _update_job(
            job_id,
            status="failed",
            stage="failed",
            message="Unexpected backend error",
            error="Unexpected backend error during mosaic generation.",
        )


def _parse_settings(
    tile_size: int,
    upscale: int | None,
    gamma: float,
    contrast: float,
    bg_thresh: int,
) -> MosaicSettings:
    return MosaicSettings(
        tile_size=tile_size,
        upscale=upscale,
        gamma=gamma,
        contrast=contrast,
        bg_thresh=bg_thresh,
    )


async def _read_upload_image(image: UploadFile) -> bytes:
    if image.content_type and not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Please upload a valid image file.")

    image_bytes = await image.read()
    if len(image_bytes) > max_upload_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"Upload exceeds the {max_upload_bytes // (1024 * 1024)}MB limit.",
        )

    try:
        return await run_in_threadpool(sanitize_upload_image_bytes, image_bytes)
    except MosaicError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/mosaic/jobs", status_code=202)
async def create_mosaic_job(
    image: UploadFile = File(...),
    tile_size: int = Form(13),
    upscale: int | None = Form(None),
    gamma: float = Form(0.8),
    contrast: float = Form(3.0),
    bg_thresh: int = Form(5),
) -> dict[str, object]:
    image_bytes = await _read_upload_image(image)
    settings = _parse_settings(tile_size, upscale, gamma, contrast, bg_thresh)
    job = _create_job(image.filename)
    JOB_EXECUTOR.submit(_run_mosaic_job, str(job["id"]), image_bytes, settings)
    return _serialize_job(job)


@app.get("/api/mosaic/jobs/{job_id}")
async def get_mosaic_job(job_id: str) -> dict[str, object]:
    return _serialize_job(_get_job(job_id))


@app.get("/api/mosaic/jobs/{job_id}/image")
async def get_mosaic_job_image(job_id: str) -> Response:
    job = _get_job(job_id)
    if job["status"] != "completed" or job["resultBytes"] is None or job["metadata"] is None:
        raise HTTPException(status_code=409, detail="Mosaic image is not ready yet.")

    return _build_mosaic_response(
        png_bytes=job["resultBytes"],
        metadata=job["metadata"],
    )


@app.post("/api/mosaic")
async def create_mosaic(
    image: UploadFile = File(...),
    tile_size: int = Form(13),
    upscale: int | None = Form(None),
    gamma: float = Form(0.8),
    contrast: float = Form(3.0),
    bg_thresh: int = Form(5),
) -> Response:
    image_bytes = await _read_upload_image(image)
    settings = _parse_settings(tile_size, upscale, gamma, contrast, bg_thresh)

    try:
        library = await run_in_threadpool(get_library, DEFAULT_DATA_DIR)
        png_bytes, metadata = await run_in_threadpool(
            generate_mosaic_bytes,
            image_bytes,
            library,
            settings,
        )
    except MosaicError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return _build_mosaic_response(png_bytes, metadata)
