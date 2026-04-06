from __future__ import annotations

import gzip
import os
import struct
from collections.abc import Callable
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from threading import Lock
from urllib.request import urlopen

import cv2
import numpy as np

TARGET_OUTPUT_PX = 3000
UPSCALE_MIN = 1
UPSCALE_MAX = 5

MNIST_FILES = {
    "train-images-idx3-ubyte.gz": (
        os.getenv(
            "MNIST_TRAIN_IMAGES_URL",
            "https://storage.googleapis.com/cvdf-datasets/mnist/train-images-idx3-ubyte.gz",
        )
    ),
    "t10k-images-idx3-ubyte.gz": (
        os.getenv(
            "MNIST_TEST_IMAGES_URL",
            "https://storage.googleapis.com/cvdf-datasets/mnist/t10k-images-idx3-ubyte.gz",
        )
    ),
}

DEFAULT_DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "MNIST" / "raw"
ProgressCallback = Callable[[dict[str, int | float | str]], None]


class MosaicError(ValueError):
    pass


@dataclass(frozen=True)
class MosaicSettings:
    tile_size: int = 13
    upscale: int | None = None
    gamma: float = 0.8
    contrast: float = 3.0
    bg_thresh: int = 5
    max_input_pixels: int = 12_000_000
    max_output_pixels: int = 25_000_000


@lru_cache(maxsize=32)
def _build_gamma_lut(gamma: float) -> np.ndarray:
    values = np.arange(256, dtype=np.float32) / 255.0
    corrected = np.power(values, gamma) * 255.0
    return corrected.astype(np.uint8)


def compute_upscale(width: int, height: int) -> int:
    raw = TARGET_OUTPUT_PX / max(width, height)
    return int(max(UPSCALE_MIN, min(UPSCALE_MAX, round(raw))))


def _load_idx_images(path: Path) -> np.ndarray:
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rb") as handle:
        magic, count, rows, cols = struct.unpack(">IIII", handle.read(16))
        if magic != 2051:
            raise MosaicError(f"Unexpected MNIST image magic number in {path}: {magic}")
        data = np.frombuffer(handle.read(), dtype=np.uint8)

    expected_size = count * rows * cols
    if data.size != expected_size:
        raise MosaicError(
            f"Corrupt MNIST image file {path}: expected {expected_size} values, got {data.size}"
        )

    return data.reshape(count, rows, cols)


def _resolve_existing_file(data_dir: Path, basename: str) -> Path | None:
    direct_path = data_dir / basename
    if direct_path.exists():
        return direct_path

    gz_path = data_dir / f"{basename}.gz"
    if gz_path.exists():
        return gz_path

    return None


def ensure_mnist_files(data_dir: Path = DEFAULT_DATA_DIR) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)

    missing = [
        filename
        for filename in MNIST_FILES
        if _resolve_existing_file(data_dir, filename.removesuffix(".gz")) is None
    ]
    if not missing:
        return

    auto_download = os.getenv("MNIST_AUTO_DOWNLOAD", "1").lower() not in {"0", "false", "no"}
    if not auto_download:
        raise MosaicError(
            "MNIST files are missing and auto-download is disabled. "
            f"Add the raw IDX files to {data_dir}."
        )

    for filename in missing:
        url = MNIST_FILES[filename]
        target_path = data_dir / filename
        try:
            with urlopen(url, timeout=60) as response, target_path.open("wb") as handle:
                handle.write(response.read())
        except Exception as exc:  # pragma: no cover - network path depends on runtime
            raise MosaicError(
                "Unable to download the MNIST dataset automatically. "
                f"Place {filename} in {data_dir} or set the MNIST_*_URL env vars."
            ) from exc


def load_mnist(data_dir: Path = DEFAULT_DATA_DIR) -> np.ndarray:
    ensure_mnist_files(data_dir)

    train_path = _resolve_existing_file(data_dir, "train-images-idx3-ubyte")
    test_path = _resolve_existing_file(data_dir, "t10k-images-idx3-ubyte")
    if train_path is None or test_path is None:
        raise MosaicError(f"MNIST files were not found in {data_dir}")

    train = _load_idx_images(train_path)
    test = _load_idx_images(test_path)
    return np.concatenate([train, test], axis=0)


class MNISTLibrary:
    def __init__(self, data_dir: Path = DEFAULT_DATA_DIR):
        self.data_dir = data_dir
        self.images: np.ndarray | None = None
        self.means: np.ndarray | None = None
        self.bins: dict[int, list[int]] = {}
        self.n_buckets = 256

    def build(self, progress_callback: ProgressCallback | None = None) -> None:
        _emit_progress(progress_callback, 2, "loading_library", "Reading MNIST glyph archive")
        raw = load_mnist(self.data_dir)
        _emit_progress(
            progress_callback, 8, "expanding_library", "Generating inverse glyph states"
        )
        inverted = 255 - raw
        self.images = np.concatenate([raw, inverted], axis=0)
        self.means = self.images.mean(axis=(1, 2)).astype(np.float32)
        self.bins = {}
        update_step = max(1, len(self.means) // 24)

        for index, mean_value in enumerate(self.means):
            bucket = int(min(mean_value, self.n_buckets - 1))
            self.bins.setdefault(bucket, []).append(index)
            if progress_callback is not None:
                if index == len(self.means) - 1 or index % update_step == 0:
                    progress = 10 + (10 * ((index + 1) / len(self.means)))
                    _emit_progress(
                        progress_callback,
                        progress,
                        "binning_library",
                        "Indexing brightness buckets",
                        stage_progress=(index + 1) / len(self.means),
                    )

        _emit_progress(
            progress_callback,
            20,
            "library_ready",
            "Glyph library primed",
            stage_progress=1.0,
        )

    def find_best_tile(self, target_patch: np.ndarray, target_brightness: float) -> int:
        if self.images is None or self.means is None:
            raise MosaicError("MNIST library has not been built yet.")

        target_int = int(np.clip(target_brightness, 0, 255))
        candidates: list[int] = []

        for offset in range(-15, 16):
            bucket = target_int + offset
            if bucket in self.bins:
                candidates.extend(self.bins[bucket])

        if not candidates:
            for offset in range(-40, 41):
                bucket = target_int + offset
                if bucket in self.bins:
                    candidates.extend(self.bins[bucket])

        if not candidates:
            return int(np.argmin(np.abs(self.means - target_brightness)))

        candidate_array = np.asarray(candidates, dtype=np.int32)
        brightness_diff = np.abs(self.means[candidate_array] - target_brightness)
        top_n = min(8, len(candidate_array))
        top_indices = (
            np.argpartition(brightness_diff, top_n - 1)[:top_n]
            if top_n < len(candidate_array)
            else np.arange(len(candidate_array))
        )

        target_small = cv2.resize(target_patch, (28, 28), interpolation=cv2.INTER_AREA)
        best_score = float("inf")
        best_index = int(candidate_array[top_indices[0]])

        for top_index in top_indices:
            tile_index = int(candidate_array[top_index])
            tile = self.images[tile_index]
            mse = np.mean(
                (tile.astype(np.float32) - target_small.astype(np.float32)) ** 2
            )
            brightness_penalty = (brightness_diff[top_index] * 10) ** 2
            score = (0.3 * mse) + (0.7 * brightness_penalty)
            if score < best_score:
                best_score = score
                best_index = tile_index

        return best_index


_LIBRARY: MNISTLibrary | None = None
_LIBRARY_LOCK = Lock()


def library_is_loaded() -> bool:
    return _LIBRARY is not None


def get_library(
    data_dir: Path = DEFAULT_DATA_DIR,
    progress_callback: ProgressCallback | None = None,
) -> MNISTLibrary:
    global _LIBRARY

    if _LIBRARY is not None:
        return _LIBRARY

    with _LIBRARY_LOCK:
        if _LIBRARY is None:
            library = MNISTLibrary(data_dir)
            library.build(progress_callback=progress_callback)
            _LIBRARY = library

    return _LIBRARY


def _validate_settings(settings: MosaicSettings) -> None:
    if not 4 <= settings.tile_size <= 64:
        raise MosaicError("tile_size must be between 4 and 64.")
    if settings.upscale is not None and not UPSCALE_MIN <= settings.upscale <= UPSCALE_MAX:
        raise MosaicError(f"upscale must be between {UPSCALE_MIN} and {UPSCALE_MAX}.")
    if not 0.3 <= settings.gamma <= 1.8:
        raise MosaicError("gamma must be between 0.3 and 1.8.")
    if not 0.5 <= settings.contrast <= 8.0:
        raise MosaicError("contrast must be between 0.5 and 8.0.")
    if not 0 <= settings.bg_thresh <= 255:
        raise MosaicError("bg_thresh must be between 0 and 255.")


def _emit_progress(
    progress_callback: ProgressCallback | None,
    progress: float,
    stage: str,
    message: str,
    stage_progress: float | None = None,
    **extra: int | float | str,
) -> None:
    if progress_callback is None:
        return

    payload: dict[str, int | float | str] = {
        "progress": round(progress, 1),
        "stage": stage,
        "message": message,
    }
    if stage_progress is not None:
        payload["stageProgress"] = round(stage_progress, 4)
    payload.update(extra)
    progress_callback(payload)


def _decode_source_bgr(image_bytes: bytes) -> np.ndarray:
    if not image_bytes:
        raise MosaicError("No image was uploaded.")

    image_buffer = np.frombuffer(image_bytes, dtype=np.uint8)
    bgr = cv2.imdecode(image_buffer, cv2.IMREAD_COLOR)
    if bgr is None:
        raise MosaicError("Unsupported or corrupt image upload.")

    return bgr


def sanitize_upload_image_bytes(image_bytes: bytes) -> bytes:
    bgr = _decode_source_bgr(image_bytes)
    encoded, sanitized = cv2.imencode(
        ".png",
        bgr,
        [cv2.IMWRITE_PNG_COMPRESSION, 9],
    )
    if not encoded:
        raise MosaicError("Unable to sanitize the uploaded image.")

    return sanitized.tobytes()


def describe_image_bytes(image_bytes: bytes) -> dict[str, int]:
    bgr = _decode_source_bgr(image_bytes)
    height, width = bgr.shape[:2]
    return {
        "width": int(width),
        "height": int(height),
        "pixel_count": int(width * height),
    }


def generate_mosaic_bytes(
    image_bytes: bytes,
    library: MNISTLibrary,
    settings: MosaicSettings,
    progress_callback: ProgressCallback | None = None,
) -> tuple[bytes, dict[str, int | float]]:
    _validate_settings(settings)
    if library.images is None:
        raise MosaicError("MNIST library is not available.")

    _emit_progress(progress_callback, 24, "decoding_frame", "Decoding source frame")
    bgr = _decode_source_bgr(image_bytes)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape
    if height * width > settings.max_input_pixels:
        raise MosaicError(
            "Input image is too large for this deployment. Try a smaller image."
        )

    upscale = settings.upscale if settings.upscale is not None else compute_upscale(width, height)
    _emit_progress(progress_callback, 30, "tonal_normalization", "Applying contrast field")
    clahe = cv2.createCLAHE(clipLimit=settings.contrast, tileGridSize=(8, 8))
    gray = clahe.apply(gray)

    lut = _build_gamma_lut(settings.gamma)
    gray = cv2.LUT(gray, lut)

    rows = height // settings.tile_size
    cols = width // settings.tile_size
    if rows == 0 or cols == 0:
        raise MosaicError(
            "Image is smaller than the chosen tile size. Lower tile_size or upload a larger image."
        )

    gray = np.ascontiguousarray(gray[: rows * settings.tile_size, : cols * settings.tile_size])
    patch_grid = gray.reshape(rows, settings.tile_size, cols, settings.tile_size).swapaxes(1, 2)
    patch_means = patch_grid.mean(axis=(2, 3), dtype=np.float32)
    render_size = settings.tile_size * upscale
    output_height = rows * render_size
    output_width = cols * render_size
    if output_height * output_width > settings.max_output_pixels:
        raise MosaicError(
            "Output image would be too large for this deployment. Lower the upscale or tile size."
        )

    canvas = np.zeros((output_height, output_width), dtype=np.uint8)
    active_mask = patch_means >= settings.bg_thresh
    total_active_patches = int(active_mask.sum())
    total_tiles = rows * cols
    _emit_progress(
        progress_callback,
        36,
        "lattice_lock",
        "Synthesizing tile lattice",
        stage_progress=1.0,
        completed_rows=0,
        total_rows=rows,
        totalTiles=total_tiles,
        activeTiles=total_active_patches,
        inputPixels=height * width,
        outputPixels=output_height * output_width,
        tileSize=settings.tile_size,
        resolvedUpscale=upscale,
    )

    rendered_tile_cache: dict[int, tuple[np.ndarray, float]] = {}
    patches_done = 0
    scanned_patches = 0

    # Weighted work model: scanning a patch (checking brightness) is cheap,
    # but actually matching + rendering an active patch is expensive.
    # These weights control how the progress bar distributes across the two.
    scan_weight = 0.15
    match_weight = 0.85
    match_total_work = max(
        (total_tiles * scan_weight) + (total_active_patches * match_weight),
        1.0,
    )

    # Throttle: emit at most ~80 updates across the entire matching phase
    # to avoid flooding the poll endpoint while still looking smooth.
    emit_interval = max(1, total_tiles // 80)

    def _current_fraction() -> float:
        work_done = (scanned_patches * scan_weight) + (patches_done * match_weight)
        return min(1.0, work_done / match_total_work)

    for row in range(rows):
        for col in range(cols):
            scanned_patches += 1
            patch = patch_grid[row, col]
            patch_mean = float(patch_means[row, col])

            if patch_mean < settings.bg_thresh:
                # Skipped patch — still counts as scan work for progress.
                # Emit on throttle interval so the bar moves through dark regions.
                if scanned_patches % emit_interval == 0:
                    fraction = _current_fraction()
                    _emit_progress(
                        progress_callback,
                        36 + (56 * fraction),
                        "glyph_matching",
                        "Scanning tile grid",
                        stage_progress=fraction,
                        completed_rows=row + 1,
                        total_rows=rows,
                    )
                continue

            best_index = library.find_best_tile(patch, patch_mean)
            cached_tile = rendered_tile_cache.get(best_index)
            if cached_tile is None:
                rendered_base = cv2.resize(
                    library.images[best_index],
                    (render_size, render_size),
                    interpolation=cv2.INTER_AREA,
                )
                cached_tile = (rendered_base, float(rendered_base.mean()))
                rendered_tile_cache[best_index] = cached_tile

            rendered_base, tile_mean = cached_tile
            rendered = rendered_base
            if tile_mean > 1:
                scale = patch_mean / tile_mean
                if abs(scale - 1.0) > 0.01:
                    rendered = cv2.convertScaleAbs(rendered_base, alpha=scale, beta=0)

            out_y = row * render_size
            out_x = col * render_size
            canvas[out_y : out_y + render_size, out_x : out_x + render_size] = rendered

            patches_done += 1

            # Emit on throttle interval, on the very last active patch,
            # and on the very last scanned patch.
            if (
                scanned_patches % emit_interval == 0
                or patches_done == total_active_patches
                or scanned_patches == total_tiles
            ):
                fraction = _current_fraction()
                _emit_progress(
                    progress_callback,
                    36 + (56 * fraction),
                    "glyph_matching",
                    "Matching and assembling digit cells",
                    stage_progress=fraction,
                    completed_rows=row + 1,
                    total_rows=rows,
                )

    _emit_progress(progress_callback, 96, "encoding_frame", "Encoding output mosaic")
    encoded, png = cv2.imencode(".png", canvas)
    if not encoded:
        raise MosaicError("Failed to encode mosaic output as PNG.")

    metadata = {
        "width": output_width,
        "height": output_height,
        "rows": rows,
        "cols": cols,
        "render_size": render_size,
        "upscale": upscale,
        "tile_size": settings.tile_size,
        "total_tiles": rows * cols,
        "pixel_count": output_width * output_height,
    }
    return png.tobytes(), metadata
