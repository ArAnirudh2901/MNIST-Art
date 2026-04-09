from __future__ import annotations

import asyncio
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Event, Lock
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from .mosaic import (
    DEFAULT_DATA_DIR,
    MosaicError,
    MosaicSettings,
    compute_upscale,
    describe_image_bytes,
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
    "X-Preview-Rows",
    "X-Preview-Total-Rows",
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
PREVIEW_CACHE: dict[str, tuple[bytes, int, int]] = {}
ROW_BUFFERS: dict[str, list[dict[str, object]]] = {}
ROW_EVENTS: dict[str, Event] = {}
JOBS_LOCK = Lock()
JOB_EXECUTOR = ThreadPoolExecutor(
    max_workers=job_worker_count,
    thread_name_prefix="mnist-mosaic",
)
TRACE_STAGE_LIMIT = 24

PIPELINE_STAGE_BLUEPRINTS = (
    {
        "id": "intake_upload",
        "label": "Validate upload",
        "detail": "Inspecting the uploaded payload envelope.",
    },
    {
        "id": "sanitize_upload",
        "label": "Sanitize upload",
        "detail": "Normalizing the image and stripping metadata.",
    },
    {
        "id": "queued",
        "label": "Queued",
        "detail": "Waiting for an available mosaic worker.",
    },
    {
        "id": "boot_sequence",
        "label": "Worker boot",
        "detail": "Initializing the mosaic worker runtime.",
    },
    {
        "id": "library_probe",
        "label": "Check library",
        "detail": "Checking whether the MNIST glyph cache is already warm.",
    },
    {
        "id": "loading_library",
        "label": "Read dataset",
        "detail": "Streaming the raw MNIST glyph archive.",
    },
    {
        "id": "expanding_library",
        "label": "Invert glyphs",
        "detail": "Generating inverse digit states for the matcher.",
    },
    {
        "id": "binning_library",
        "label": "Index buckets",
        "detail": "Mapping brightness buckets for fast glyph lookup.",
    },
    {
        "id": "library_ready",
        "label": "Library ready",
        "detail": "Glyph matcher locked and ready for assembly.",
    },
    {
        "id": "decoding_frame",
        "label": "Decode frame",
        "detail": "Reading the uploaded portrait pixels.",
    },
    {
        "id": "tonal_normalization",
        "label": "Tone shaping",
        "detail": "Applying CLAHE and gamma correction.",
    },
    {
        "id": "lattice_lock",
        "label": "Plan lattice",
        "detail": "Projecting the tile field onto the portrait.",
    },
    {
        "id": "glyph_matching",
        "label": "Glyph match",
        "detail": "Matching and assembling digit cells row by row.",
    },
    {
        "id": "encoding_frame",
        "label": "Encode PNG",
        "detail": "Encoding the finished mosaic image.",
    },
    {
        "id": "complete",
        "label": "Complete",
        "detail": "Preview and download are ready.",
    },
)
PIPELINE_STAGE_BLUEPRINT_LOOKUP = {
    stage["id"]: stage for stage in PIPELINE_STAGE_BLUEPRINTS
}
DEFAULT_PIPELINE_CONTEXT = {
    "libraryCached": False,
    "inputPixels": 1_600_000,
    "tileSize": 13,
    "resolvedUpscale": 2,
    "totalTiles": 4_800,
    "activeTiles": 3_456,
    "outputPixels": 5_500_000,
}
MIN_LIBRARY_STAGE_WORK = 0.15
TERMINAL_JOB_STATUSES = {"completed", "failed", "cancelled"}


class MosaicCancelledError(RuntimeError):
    pass

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
            if job["status"] in TERMINAL_JOB_STATUSES and float(job["updatedAt"]) < cutoff
        ]
        for job_id in stale_job_ids:
            JOBS.pop(job_id, None)
            PREVIEW_CACHE.pop(job_id, None)


def _safe_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _build_pipeline_context(**overrides: object) -> dict[str, object]:
    context = dict(DEFAULT_PIPELINE_CONTEXT)
    for key, value in overrides.items():
        if value is not None:
            context[key] = value

    width = _safe_int(context.get("width"))
    height = _safe_int(context.get("height"))
    tile_size = max(1, _safe_int(context.get("tileSize"), 13))
    total_tiles = _safe_int(context.get("totalTiles"))
    input_pixels = _safe_int(context.get("inputPixels"))

    if width > 0 and height > 0:
        input_pixels = width * height
        rows = max(1, height // tile_size)
        cols = max(1, width // tile_size)
        total_tiles = rows * cols
        resolved_upscale = _safe_int(context.get("resolvedUpscale"))
        if resolved_upscale <= 0:
            explicit_upscale = _safe_int(context.get("upscale"))
            resolved_upscale = explicit_upscale if explicit_upscale > 0 else compute_upscale(
                width, height
            )
        output_width = cols * tile_size * resolved_upscale
        output_height = rows * tile_size * resolved_upscale
        context["inputPixels"] = input_pixels
        context["totalTiles"] = total_tiles
        context["resolvedUpscale"] = resolved_upscale
        context["outputPixels"] = output_width * output_height

    if input_pixels <= 0:
        context["inputPixels"] = DEFAULT_PIPELINE_CONTEXT["inputPixels"]
    if total_tiles <= 0:
        context["totalTiles"] = DEFAULT_PIPELINE_CONTEXT["totalTiles"]
    if _safe_int(context.get("outputPixels")) <= 0:
        context["outputPixels"] = DEFAULT_PIPELINE_CONTEXT["outputPixels"]
    if _safe_int(context.get("activeTiles")) <= 0:
        context["activeTiles"] = max(
            1,
            int(round(_safe_int(context["totalTiles"]) * 0.72)),
        )

    context["libraryCached"] = bool(context.get("libraryCached"))
    context["tileSize"] = tile_size
    return context


def _build_pipeline_stages(
    planning_context: dict[str, object] | None = None,
) -> list[dict[str, object]]:
    context = _build_pipeline_context(**(planning_context or {}))
    input_pixels = _safe_int(context["inputPixels"])
    total_tiles = _safe_int(context["totalTiles"])
    active_tiles = _safe_int(context["activeTiles"])
    output_pixels = _safe_int(context["outputPixels"])
    library_cached = bool(context["libraryCached"])

    work_by_stage = {
        "intake_upload": 1.3,
        "sanitize_upload": 2.6 + min(4.8, input_pixels / 650_000),
        "queued": 0.6,
        "boot_sequence": 0.9,
        "library_probe": 0.4,
        "loading_library": MIN_LIBRARY_STAGE_WORK if library_cached else 8.0,
        "expanding_library": MIN_LIBRARY_STAGE_WORK if library_cached else 7.0,
        "binning_library": MIN_LIBRARY_STAGE_WORK if library_cached else 9.0,
        "library_ready": 1.0,
        "decoding_frame": 1.4 + min(4.4, input_pixels / 550_000),
        "tonal_normalization": 2.1 + min(6.8, input_pixels / 300_000),
        "lattice_lock": 1.6 + min(6.2, total_tiles / 1_200),
        "glyph_matching": 6.0 + (total_tiles * 0.004) + (active_tiles * 0.01),
        "encoding_frame": 1.6 + min(7.4, output_pixels / 500_000),
        "complete": 0.4,
    }

    total_work = sum(work_by_stage.values())
    completed_work = 0.0
    stages: list[dict[str, object]] = []

    for blueprint in PIPELINE_STAGE_BLUEPRINTS:
        stage_id = str(blueprint["id"])
        stage_work = float(work_by_stage.get(stage_id, 1.0))
        start_progress = 100.0 * (completed_work / total_work)
        completed_work += stage_work
        end_progress = 100.0 * (completed_work / total_work)
        stages.append(
            {
                **blueprint,
                "workUnits": round(stage_work, 3),
                "startProgress": round(start_progress, 1),
                "endProgress": round(100.0 if stage_id == "complete" else end_progress, 1),
            }
        )

    return stages


def _serialize_pipeline_stages(
    pipeline_stages: list[dict[str, object]] | None = None,
) -> list[dict[str, object]]:
    return [dict(stage) for stage in (pipeline_stages or _build_pipeline_stages())]


def _clamp_stage_progress(value: float) -> float:
    return max(0.0, min(1.0, value))


def _pipeline_progress(
    pipeline_stages: list[dict[str, object]],
    stage_id: str,
    stage_progress: float | None = None,
) -> float:
    stage = next(
        (candidate for candidate in pipeline_stages if candidate["id"] == stage_id),
        None,
    )
    if stage is None:
        return 0.0

    start = float(stage["startProgress"])
    end = float(stage["endProgress"])
    if end <= start:
        return end

    progress_within_stage = 1.0 if stage_id == "complete" else 0.0
    if stage_progress is not None:
        progress_within_stage = _clamp_stage_progress(float(stage_progress))

    return round(start + ((end - start) * progress_within_stage), 1)


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
        "trace": job["trace"],
        "pipelineStages": _serialize_pipeline_stages(job.get("pipelineStages")),
        "createdAt": job["createdAt"],
        "updatedAt": job["updatedAt"],
    }


def _build_trace_entry(
    *,
    status: str,
    stage: str,
    message: str,
    progress: float,
    completed_rows: int,
    total_rows: int,
    created_at: float,
) -> dict[str, object]:
    return {
        "status": status,
        "stage": stage,
        "message": message,
        "progress": progress,
        "completedRows": completed_rows,
        "totalRows": total_rows,
        "createdAt": created_at,
    }


def _create_job(filename: str | None) -> dict[str, object]:
    _prune_jobs()
    now = time.time()
    job_id = uuid4().hex
    planning_context = _build_pipeline_context(libraryCached=library_is_loaded())
    pipeline_stages = _build_pipeline_stages(planning_context)
    job = {
        "id": job_id,
        "filename": filename,
        "status": "running",
        "progress": _pipeline_progress(pipeline_stages, "intake_upload", 0.0),
        "stage": "intake_upload",
        "message": "Inspecting upload envelope",
        "completedRows": 0,
        "totalRows": 0,
        "metadata": None,
        "error": None,
        "resultBytes": None,
        "planningContext": planning_context,
        "pipelineStages": pipeline_stages,
        "cancelRequested": False,
        "createdAt": now,
        "updatedAt": now,
        "trace": [
            _build_trace_entry(
                status="running",
                stage="intake_upload",
                message="Inspecting upload envelope",
                progress=_pipeline_progress(pipeline_stages, "intake_upload", 0.0),
                completed_rows=0,
                total_rows=0,
                created_at=now,
            )
        ],
    }
    with JOBS_LOCK:
        JOBS[job_id] = job
    return dict(job)


def _update_job(job_id: str, **changes: object) -> dict[str, object]:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            raise KeyError(job_id)

        current_status = str(job["status"])
        incoming_status = str(changes.get("status", current_status))
        if current_status in TERMINAL_JOB_STATUSES and incoming_status != current_status:
            return dict(job)

        current_stage = str(job["stage"])
        current_message = str(job["message"])
        current_progress = float(job["progress"])
        current_completed_rows = int(job["completedRows"])
        current_total_rows = int(job["totalRows"])

        if "progress" in changes:
            incoming_progress = float(changes["progress"])
            changes["progress"] = max(float(job["progress"]), incoming_progress)

        job.update(changes)
        now = time.time()
        job["updatedAt"] = now

        next_status = str(job["status"])
        next_stage = str(job["stage"])
        next_message = str(job["message"])
        next_progress = float(job["progress"])
        next_completed_rows = int(job["completedRows"])
        next_total_rows = int(job["totalRows"])

        trace = list(job.get("trace", []))
        next_trace_entry = _build_trace_entry(
            status=next_status,
            stage=next_stage,
            message=next_message,
            progress=next_progress,
            completed_rows=next_completed_rows,
            total_rows=next_total_rows,
            created_at=now,
        )

        should_append_trace = (
            not trace
            or current_stage != next_stage
            or current_status != next_status
        )
        should_refresh_trace = (
            current_message != next_message
            or current_progress != next_progress
            or current_completed_rows != next_completed_rows
            or current_total_rows != next_total_rows
        )

        if should_append_trace:
            trace.append(next_trace_entry)
        elif should_refresh_trace:
            trace[-1] = next_trace_entry

        job["trace"] = trace[-TRACE_STAGE_LIMIT:]
        return dict(job)


def _get_job(job_id: str) -> dict[str, object]:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Mosaic job not found.")
        return dict(job)


def _raise_if_job_cancelled(job_id: str) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            raise MosaicCancelledError("Mosaic job no longer exists.")
        if bool(job.get("cancelRequested")) or str(job.get("status")) == "cancelled":
            raise MosaicCancelledError("Mosaic generation cancelled by user.")


def _extract_planning_updates(payload: dict[str, object]) -> dict[str, object]:
    planning_updates: dict[str, object] = {}
    for source_key, target_key in (
        ("width", "width"),
        ("height", "height"),
        ("inputPixels", "inputPixels"),
        ("totalTiles", "totalTiles"),
        ("activeTiles", "activeTiles"),
        ("outputPixels", "outputPixels"),
        ("tileSize", "tileSize"),
        ("resolvedUpscale", "resolvedUpscale"),
    ):
        if source_key in payload and payload[source_key] is not None:
            planning_updates[target_key] = payload[source_key]
    return planning_updates


def _job_progress_callback(job_id: str, payload: dict[str, object]) -> None:
    _raise_if_job_cancelled(job_id)
    stage = str(payload.get("stage", "running"))
    stage_progress = payload.get("stageProgress", payload.get("stage_progress"))
    job = _get_job(job_id)
    planning_context = dict(job.get("planningContext", {}))
    planning_context.update(_extract_planning_updates(payload))

    if stage in {"loading_library", "expanding_library", "binning_library"}:
        planning_context["libraryCached"] = False

    pipeline_stages = _build_pipeline_stages(planning_context)
    _update_job(
        job_id,
        status="running",
        planningContext=planning_context,
        pipelineStages=pipeline_stages,
        progress=_pipeline_progress(
            pipeline_stages,
            stage,
            None if stage_progress is None else float(stage_progress),
        ),
        stage=stage,
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


def _row_callback_for_job(job_id: str):
    """Return a row callback that pushes row data into the per-job row buffer."""
    def _on_row(row_entry: dict[str, int | str]) -> None:
        with JOBS_LOCK:
            buf = ROW_BUFFERS.get(job_id)
            if buf is not None:
                buf.append(row_entry)
        event = ROW_EVENTS.get(job_id)
        if event is not None:
            event.set()
    return _on_row


def _run_mosaic_job(job_id: str, image_bytes: bytes, settings: MosaicSettings) -> None:
    # Initialize the row buffer before processing begins.
    with JOBS_LOCK:
        ROW_BUFFERS[job_id] = []
    ROW_EVENTS[job_id] = Event()

    try:
        _raise_if_job_cancelled(job_id)
        job = _get_job(job_id)
        planning_overrides = dict(job.get("planningContext", {}))
        planning_overrides["libraryCached"] = library_is_loaded()
        planning_context = _build_pipeline_context(**planning_overrides)
        pipeline_stages = _build_pipeline_stages(planning_context)
        _update_job(
            job_id,
            status="running",
            planningContext=planning_context,
            pipelineStages=pipeline_stages,
            progress=_pipeline_progress(pipeline_stages, "boot_sequence", 0.0),
            stage="boot_sequence",
            message="Initializing mosaic worker",
        )

        _update_job(
            job_id,
            status="running",
            planningContext=planning_context,
            pipelineStages=pipeline_stages,
            progress=_pipeline_progress(pipeline_stages, "library_probe", 0.0),
            stage="library_probe",
            message="Checking glyph library cache",
        )

        library = get_library(
            DEFAULT_DATA_DIR,
            lambda payload: _job_progress_callback(job_id, payload),
        )
        _raise_if_job_cancelled(job_id)
        _update_job(
            job_id,
            status="running",
            planningContext=planning_context,
            pipelineStages=pipeline_stages,
            progress=_pipeline_progress(pipeline_stages, "library_ready", 1.0),
            stage="library_ready",
            message="Glyph library ready",
        )

        png_bytes, metadata = generate_mosaic_bytes(
            image_bytes,
            library,
            settings,
            lambda payload: _job_progress_callback(job_id, payload),
            row_callback=_row_callback_for_job(job_id),
        )
        _raise_if_job_cancelled(job_id)

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
        PREVIEW_CACHE.pop(job_id, None)
    except MosaicCancelledError:
        job = _get_job(job_id)
        _update_job(
            job_id,
            status="cancelled",
            stage=job["stage"],
            message="Processing stopped by user",
            error=None,
            cancelRequested=True,
        )
        PREVIEW_CACHE.pop(job_id, None)
    except MosaicError as exc:
        _update_job(
            job_id,
            status="failed",
            stage="failed",
            message="Mosaic generation failed",
            error=str(exc),
        )
        PREVIEW_CACHE.pop(job_id, None)
    except Exception:
        _update_job(
            job_id,
            status="failed",
            stage="failed",
            message="Unexpected backend error",
            error="Unexpected backend error during mosaic generation.",
        )
        PREVIEW_CACHE.pop(job_id, None)
    finally:
        # Signal stream consumers that the job is done.
        event = ROW_EVENTS.get(job_id)
        if event is not None:
            event.set()


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
    job = _create_job(image.filename)
    job_id = str(job["id"])
    pipeline_stages = list(job["pipelineStages"])

    try:
        _update_job(
            job_id,
            status="running",
            progress=_pipeline_progress(pipeline_stages, "intake_upload", 1.0),
            stage="intake_upload",
            message="Upload envelope validated",
        )
        _update_job(
            job_id,
            status="running",
            progress=_pipeline_progress(pipeline_stages, "sanitize_upload", 0.0),
            stage="sanitize_upload",
            message="Sanitizing upload and stripping metadata",
        )
        image_bytes = await _read_upload_image(image)
    except HTTPException as exc:
        _update_job(
            job_id,
            status="failed",
            stage="failed",
            message="Upload rejected",
            error=str(exc.detail),
        )
        raise

    settings = _parse_settings(tile_size, upscale, gamma, contrast, bg_thresh)
    image_details = describe_image_bytes(image_bytes)
    planning_overrides = dict(_get_job(job_id).get("planningContext", {}))
    planning_overrides.update(
        {
            "width": image_details["width"],
            "height": image_details["height"],
            "inputPixels": image_details["pixel_count"],
            "tileSize": settings.tile_size,
            "upscale": settings.upscale,
            "libraryCached": library_is_loaded(),
        }
    )
    planning_context = _build_pipeline_context(**planning_overrides)
    pipeline_stages = _build_pipeline_stages(planning_context)
    _update_job(
        job_id,
        status="queued",
        planningContext=planning_context,
        pipelineStages=pipeline_stages,
        progress=_pipeline_progress(pipeline_stages, "queued", 0.0),
        stage="queued",
        message="Queued for worker pickup",
    )
    JOB_EXECUTOR.submit(_run_mosaic_job, job_id, image_bytes, settings)
    return _serialize_job(_get_job(job_id))


@app.get("/api/mosaic/jobs/{job_id}")
async def get_mosaic_job(job_id: str) -> dict[str, object]:
    return _serialize_job(_get_job(job_id))


@app.post("/api/mosaic/jobs/{job_id}/cancel")
async def cancel_mosaic_job(job_id: str) -> dict[str, object]:
    job = _get_job(job_id)
    if job["status"] in TERMINAL_JOB_STATUSES:
        return _serialize_job(job)

    updated_job = _update_job(
        job_id,
        status="cancelled",
        stage=job["stage"],
        message="Processing stopped by user",
        error=None,
        cancelRequested=True,
    )
    return _serialize_job(updated_job)


@app.get("/api/mosaic/jobs/{job_id}/image")
async def get_mosaic_job_image(job_id: str) -> Response:
    job = _get_job(job_id)
    if job["status"] != "completed" or job["resultBytes"] is None or job["metadata"] is None:
        raise HTTPException(status_code=409, detail="Mosaic image is not ready yet.")

    return _build_mosaic_response(
        png_bytes=job["resultBytes"],
        metadata=job["metadata"],
    )


@app.get("/api/mosaic/jobs/{job_id}/stream")
async def stream_mosaic_rows(job_id: str) -> StreamingResponse:
    """SSE endpoint that streams row pixel data as the mosaic is generated."""
    # Verify the job exists.
    _get_job(job_id)

    async def _event_generator():
        cursor = 0
        while True:
            # Check if there are buffered rows to send.
            with JOBS_LOCK:
                buf = ROW_BUFFERS.get(job_id, [])
                pending = buf[cursor:]

            for row_entry in pending:
                yield f"data: {json.dumps(row_entry, separators=(',', ':'))}\n\n"
                cursor += 1

            # Check if the job has reached a terminal state.
            job = _get_job(job_id)
            status = str(job.get("status", ""))
            if status in TERMINAL_JOB_STATUSES:
                # Drain any final rows.
                with JOBS_LOCK:
                    buf = ROW_BUFFERS.get(job_id, [])
                    final_pending = buf[cursor:]
                for row_entry in final_pending:
                    yield f"data: {json.dumps(row_entry, separators=(',', ':'))}\n\n"
                yield f"data: {json.dumps({'done': True, 'status': status})}\n\n"
                # Clean up the row buffer for this job.
                with JOBS_LOCK:
                    ROW_BUFFERS.pop(job_id, None)
                ROW_EVENTS.pop(job_id, None)
                return

            # Wait for new rows or a short timeout.
            event = ROW_EVENTS.get(job_id)
            if event is not None:
                event.clear()
                # Use asyncio sleep to avoid blocking the event loop,
                # with a short poll interval.
                await asyncio.sleep(0.05)
            else:
                await asyncio.sleep(0.1)

    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/mosaic/jobs/{job_id}/preview")
async def get_mosaic_job_preview(job_id: str) -> Response:
    cached = PREVIEW_CACHE.get(job_id)
    if cached is None:
        raise HTTPException(status_code=404, detail="No preview available yet.")

    jpeg_bytes, done_rows, total_rows = cached
    return Response(
        content=jpeg_bytes,
        media_type="image/jpeg",
        headers={
            "X-Preview-Rows": str(done_rows),
            "X-Preview-Total-Rows": str(total_rows),
            "Cache-Control": "no-store",
        },
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
