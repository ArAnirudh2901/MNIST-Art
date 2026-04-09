"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import GenerateMosaicButton from "@/components/generate-mosaic-button";
import GlassSlider from "@/components/glass-slider";
import InspectableImage from "@/components/inspectable-image";
import LiquidGlassPanel from "@/components/liquid-glass-panel";
import MnistDigitGridBackground from "@/components/mnist-digit-grid-background";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
const TARGET_OUTPUT_PX = 3000;
const UPSCALE_MIN = 1;
const UPSCALE_MAX = 5;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_LABEL = "20 MB";
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const HEALTH_CHECK_TIMEOUT_MS = 2_500;
const HEALTH_CHECK_COLD_START_TIMEOUT_MS = 65_000;
const HEALTH_CHECK_WARMING_HINT_DELAY_MS = 1_500;

const defaultOptions = {
  tileSize: 13,
  upscale: "auto",
  gamma: 0.8,
  contrast: 3,
  bgThresh: 5,
};

const upscaleOptions = ["auto", 1, 2, 3, 4, 5];

const presets = [
  { id: "quick", label: "Quick", tileSize: 20, gamma: 0.8, contrast: 2, bgThresh: 8 },
  { id: "balanced", label: "Balanced", tileSize: 13, gamma: 0.8, contrast: 3, bgThresh: 5 },
  { id: "detailed", label: "Detailed", tileSize: 6, gamma: 0.7, contrast: 4.5, bgThresh: 3 },
];

const structureControls = [
  {
    id: "tileSize",
    label: "Tile size",
    min: 4,
    max: 24,
    step: 1,
  },
  {
    id: "bgThresh",
    label: "Bg threshold",
    min: 0,
    max: 40,
    step: 1,
  },
];

const toneControls = [
  {
    id: "gamma",
    label: "Gamma",
    min: 0.3,
    max: 1.8,
    step: 0.1,
  },
  {
    id: "contrast",
    label: "CLAHE",
    min: 0.5,
    max: 8,
    step: 0.5,
  },
];

const fallbackPipelineStages = [
  {
    id: "intake_upload",
    label: "Validate upload",
    detail: "Inspecting the uploaded payload envelope.",
    startProgress: 0,
    endProgress: 1.1,
  },
  {
    id: "sanitize_upload",
    label: "Sanitize upload",
    detail: "Normalizing the image and stripping metadata.",
    startProgress: 1.1,
    endProgress: 5.3,
  },
  {
    id: "queued",
    label: "Queued",
    detail: "Waiting for an available mosaic worker.",
    startProgress: 5.3,
    endProgress: 5.8,
  },
  {
    id: "boot_sequence",
    label: "Worker boot",
    detail: "Initializing the mosaic worker runtime.",
    startProgress: 5.8,
    endProgress: 6.6,
  },
  {
    id: "library_probe",
    label: "Check library",
    detail: "Checking whether the MNIST glyph cache is already warm.",
    startProgress: 6.6,
    endProgress: 6.9,
  },
  {
    id: "loading_library",
    label: "Read dataset",
    detail: "Streaming the raw MNIST glyph archive.",
    startProgress: 6.9,
    endProgress: 13.6,
  },
  {
    id: "expanding_library",
    label: "Invert glyphs",
    detail: "Generating inverse digit states for the matcher.",
    startProgress: 13.6,
    endProgress: 19.4,
  },
  {
    id: "binning_library",
    label: "Index buckets",
    detail: "Mapping brightness buckets for fast glyph lookup.",
    startProgress: 19.4,
    endProgress: 26.9,
  },
  {
    id: "library_ready",
    label: "Library ready",
    detail: "Glyph matcher locked and ready for assembly.",
    startProgress: 26.9,
    endProgress: 27.8,
  },
  {
    id: "decoding_frame",
    label: "Decode frame",
    detail: "Reading the uploaded portrait pixels.",
    startProgress: 27.8,
    endProgress: 31.4,
  },
  {
    id: "tonal_normalization",
    label: "Tone shaping",
    detail: "Applying CLAHE and gamma correction.",
    startProgress: 31.4,
    endProgress: 37.6,
  },
  {
    id: "lattice_lock",
    label: "Plan lattice",
    detail: "Projecting the tile field onto the portrait.",
    startProgress: 37.6,
    endProgress: 42.3,
  },
  {
    id: "glyph_matching",
    label: "Glyph match",
    detail: "Matching and assembling digit cells row by row.",
    startProgress: 42.3,
    endProgress: 92.2,
  },
  {
    id: "encoding_frame",
    label: "Encode PNG",
    detail: "Encoding the finished mosaic image.",
    startProgress: 92.2,
    endProgress: 99.7,
  },
  {
    id: "complete",
    label: "Complete",
    detail: "Preview and download are ready.",
    startProgress: 99.7,
    endProgress: 100,
  },
];

function formatNumber(value) {
  return new Intl.NumberFormat().format(value);
}

function formatCompactNumber(value) {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatDecimal(value) {
  return new Intl.NumberFormat("en", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

function formatFileSize(bytes) {
  if (!bytes) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${formatDecimal(value)} ${units[unitIndex]}`;
}

function decodeBase64Image(base64Value) {
  const binary = window.atob(base64Value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function computeAutoUpscale(width, height) {
  const raw = TARGET_OUTPUT_PX / Math.max(width, height);
  return Math.max(UPSCALE_MIN, Math.min(UPSCALE_MAX, Math.round(raw)));
}

function getOrientationLabel(width, height) {
  const ratio = width / height;
  if (ratio > 1.1) {
    return "landscape bias";
  }
  if (ratio < 0.9) {
    return "portrait bias";
  }
  return "balanced frame";
}

function humanizeStage(stage) {
  if (!stage) {
    return "Pipeline sync";
  }

  return stage
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getPipelineStages(jobState) {
  if (Array.isArray(jobState?.pipelineStages) && jobState.pipelineStages.length > 0) {
    return jobState.pipelineStages;
  }
  return fallbackPipelineStages;
}

function buildProgressPresentation(jobState, pipelineStages) {
  const stage = jobState?.stage || pipelineStages[0]?.id || "queued";
  const currentStatus = jobState?.status || "queued";
  const stageMessage = jobState?.message || "Waiting for backend telemetry";
  const completedRows = Number(jobState?.completedRows || 0);
  const totalRows = Number(jobState?.totalRows || 0);

  const stageMeta = {
    intake_upload: {
      label: "Validate Upload",
      primary: "payload inspection",
      secondary: "checking file envelope",
    },
    sanitize_upload: {
      label: "Sanitize Upload",
      primary: "image normalization",
      secondary: "stripping metadata",
    },
    queued: {
      label: "Queued",
      primary: "upload handoff",
      secondary: "awaiting worker slot",
    },
    boot_sequence: {
      label: "Boot Sequence",
      primary: "worker warmup",
      secondary: "initializing pipeline runtime",
    },
    library_probe: {
      label: "Check Library",
      primary: "cache probe",
      secondary: "verifying glyph cache",
    },
    loading_library: {
      label: "Loading Library",
      primary: "dataset stream",
      secondary: "reading MNIST glyph archive",
    },
    expanding_library: {
      label: "Expanding Library",
      primary: "glyph inversion",
      secondary: "generating inverse digit states",
    },
    binning_library: {
      label: "Indexing Library",
      primary: "bucket calibration",
      secondary: "mapping brightness buckets",
    },
    library_ready: {
      label: "Library Ready",
      primary: "140K glyph states",
      secondary: "matcher online",
    },
    decoding_frame: {
      label: "Decoding Frame",
      primary: "source decode",
      secondary: "reading uploaded portrait data",
    },
    tonal_normalization: {
      label: "Tonal Normalization",
      primary: "CLAHE + gamma",
      secondary: "shaping the portrait tone field",
    },
    lattice_lock: {
      label: "Lattice Lock",
      primary: totalRows > 0 ? `${formatNumber(totalRows)} rows staged` : "grid planning",
      secondary: "synthesizing the tile lattice",
    },
    glyph_matching: {
      label: "Glyph Matching",
      primary:
        totalRows > 0
          ? `${formatNumber(completedRows)} / ${formatNumber(totalRows)} rows`
          : "row synthesis",
      secondary: "live backend trace",
    },
    encoding_frame: {
      label: "Encoding Frame",
      primary: "PNG export",
      secondary: "encoding the final raster",
    },
    complete: {
      label: "Complete",
      primary:
        totalRows > 0
          ? `${formatNumber(totalRows)} / ${formatNumber(totalRows)} rows`
          : "render complete",
      secondary: "download ready",
    },
    failed: {
      label: "Failed",
      primary: "pipeline halted",
      secondary: "check backend telemetry",
    },
  };

  const fallback = {
    label:
      pipelineStages.find((candidate) => candidate.id === stage)?.label || humanizeStage(stage),
    primary:
      totalRows > 0
        ? `${formatNumber(completedRows)} / ${formatNumber(totalRows)} rows`
        : "pipeline trace",
    secondary: stageMessage,
  };

  if (currentStatus === "cancelled") {
    return {
      label: "Stopped",
      message: stageMessage,
      primary: "processing halted",
      secondary: "cancelled by user",
    };
  }

  const active = stageMeta[stage] || fallback;

  return {
    label: active.label,
    message: stageMessage,
    primary: active.primary,
    secondary: active.secondary,
  };
}

function buildCurrentPipelineState(jobState, pipelineStages) {
  const currentStage = jobState?.stage || pipelineStages[0]?.id || "queued";
  const currentStatus = jobState?.status || "queued";
  const traceEntries = Array.isArray(jobState?.trace) ? jobState.trace : [];
  const traceEntry =
    [...traceEntries].reverse().find((entry) => entry?.stage === currentStage) ||
    traceEntries.at(-1) ||
    null;
  const stage =
    pipelineStages.find((candidate) => candidate.id === currentStage) || {
      id: currentStage,
      label: humanizeStage(currentStage),
      detail: "Live backend stage",
    };
  const completedRows = Number(traceEntry?.completedRows || jobState?.completedRows || 0);
  const totalRows = Number(traceEntry?.totalRows || jobState?.totalRows || 0);

  return {
    ...stage,
    label: currentStatus === "cancelled" ? "Stopped" : stage.label,
    state:
      currentStatus === "cancelled"
        ? "cancelled"
        : currentStatus === "failed"
          ? "failed"
          : currentStatus === "completed" || currentStage === "complete"
            ? "complete"
            : "active",
    message: traceEntry?.message || stage.detail,
    detail:
      currentStatus === "cancelled"
        ? traceEntry?.message || "Processing stopped by user"
        : stage.id === "glyph_matching" && totalRows > 0
          ? `${formatNumber(completedRows)} / ${formatNumber(totalRows)} rows`
          : stage.detail,
    meta:
      currentStatus === "cancelled"
        ? "Stopped"
        : currentStatus === "failed"
          ? "Failed"
          : currentStatus === "completed" || currentStage === "complete"
            ? "Done"
            : typeof traceEntry?.progress === "number"
              ? `${Math.round(traceEntry.progress)}%`
              : "Pending",
  };
}

function buildPipelineStageStates(jobState, pipelineStages) {
  const traceEntries = Array.isArray(jobState?.trace) ? jobState.trace : [];
  const traceByStage = new Map();

  for (const entry of traceEntries) {
    if (entry?.stage) {
      traceByStage.set(entry.stage, entry);
    }
  }

  const currentStage = jobState?.stage || pipelineStages[0]?.id || "queued";
  const currentStatus = jobState?.status || "queued";
  const currentIndex = pipelineStages.findIndex((stage) => stage.id === currentStage);
  const furthestIndex = traceEntries.reduce((highestIndex, entry) => {
    const entryIndex = pipelineStages.findIndex((stage) => stage.id === entry?.stage);
    return entryIndex > highestIndex ? entryIndex : highestIndex;
  }, currentIndex);

  return pipelineStages.map((stage, index) => {
    const traceEntry = traceByStage.get(stage.id) || null;
    let state = "pending";

    if (currentStatus === "cancelled" && stage.id === currentStage) {
      state = "cancelled";
    } else if (currentStatus === "failed" && stage.id === currentStage) {
      state = "failed";
    } else if (stage.id === currentStage && !["completed", "cancelled"].includes(currentStatus)) {
      state = "active";
    } else if (traceEntry || (currentStatus === "completed" && stage.id === "complete")) {
      state = "complete";
    } else if (furthestIndex > index) {
      state = "skipped";
    }

    let meta = "Pending";
    if (state === "active") {
      meta =
        typeof jobState?.progress === "number"
          ? `${Math.round(jobState.progress)}%`
          : "In progress";
    } else if (state === "cancelled") {
      meta = "Stopped";
    } else if (state === "complete") {
      meta = "Done";
    } else if (state === "skipped") {
      meta = stage.id.startsWith("library_") || stage.id === "loading_library" || stage.id === "expanding_library" || stage.id === "binning_library"
        ? "Cached"
        : "Skipped";
    } else if (state === "failed") {
      meta = "Failed";
    }

    return {
      ...stage,
      state,
      meta,
      message: traceEntry?.message || stage.detail,
      markerProgress:
        stage.id === "complete"
          ? 100
          : ((Number(stage.startProgress || 0) + Number(stage.endProgress || 0)) / 2),
    };
  });
}

function buildSourceTelemetry(sourceMeta, options) {
  if (!sourceMeta || !sourceMeta.width || !sourceMeta.height) {
    return [];
  }

  const cols = Math.floor(sourceMeta.width / options.tileSize);
  const rows = Math.floor(sourceMeta.height / options.tileSize);
  const totalTiles = cols * rows;
  const effectiveUpscale =
    options.upscale === "auto"
      ? computeAutoUpscale(sourceMeta.width, sourceMeta.height)
      : options.upscale;
  const mimeLabel = sourceMeta.mimeType
    ? sourceMeta.mimeType.replace("image/", "").toUpperCase()
    : "IMAGE";

  return [
    {
      label: "Dimensions",
      value: `${formatNumber(sourceMeta.width)} × ${formatNumber(sourceMeta.height)}`,
    },
    {
      label: "Megapixels",
      value: formatDecimal(sourceMeta.pixelCount / 1_000_000),
    },
    {
      label: "Aspect",
      value: getOrientationLabel(sourceMeta.width, sourceMeta.height),
    },
    {
      label: "Format",
      value: mimeLabel,
    },
    {
      label: "File size",
      value: formatFileSize(sourceMeta.fileSize),
    },
    {
      label: "Tile size",
      value: `${options.tileSize}px`,
    },
    {
      label: "Grid",
      value: `${formatNumber(cols)} × ${formatNumber(rows)}`,
    },
    {
      label: "Total cells",
      value: formatCompactNumber(totalTiles),
    },
  ];
}

export default function Home() {
  const prefersReducedMotion = useReducedMotion();
  const [file, setFile] = useState(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceMeta, setSourceMeta] = useState(null);
  const [resultUrl, setResultUrl] = useState("");
  const [resultMeta, setResultMeta] = useState(null);
  const [apiStatus, setApiStatus] = useState("checking");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [jobState, setJobState] = useState(null);
  const [activeJobId, setActiveJobId] = useState("");
  const [submittedOptions, setSubmittedOptions] = useState(null);
  const [options, setOptions] = useState(defaultOptions);
  const resultUrlRef = useRef("");
  const jobToastIdRef = useRef(null);
  const hasShownOfflineToastRef = useRef(false);
  const fileInputRef = useRef(null);
  const outputSectionRef = useRef(null);
  const displayedProgressRef = useRef(null);
  const previousApiStatusRef = useRef("checking");
  const pendingCancellationRef = useRef(false);
  const [displayedProgressState, setDisplayedProgressState] = useState(null);
  const canvasRef = useRef(null);
  const [hasCanvasContent, setHasCanvasContent] = useState(false);
  const apiStatusRef = useRef("checking");

  const scrollOutputIntoView = useCallback(() => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const outputSection = outputSectionRef.current;
        if (!outputSection) {
          return;
        }

        const top = Math.max(
          0,
          outputSection.getBoundingClientRect().top + window.scrollY - 24,
        );

        window.scrollTo({
          top,
          behavior: prefersReducedMotion ? "auto" : "smooth",
        });
      });
    });
  }, [prefersReducedMotion]);

  function dismissJobToast() {
    if (jobToastIdRef.current) {
      toast.dismiss(jobToastIdRef.current);
      jobToastIdRef.current = null;
    }
  }

  function updateApiStatus(nextStatus) {
    apiStatusRef.current = nextStatus;
    setApiStatus(nextStatus);
  }

  function resetGeneratedState() {
    pendingCancellationRef.current = false;
    setIsCancelling(false);
    setIsGenerating(false);
    setJobState(null);
    setActiveJobId("");
    setSubmittedOptions(null);
    dismissJobToast();

    if (resultUrlRef.current) {
      URL.revokeObjectURL(resultUrlRef.current);
      resultUrlRef.current = "";
    }

    setResultUrl("");
    setResultMeta(null);
    setHasCanvasContent(false);

    // Clear the canvas.
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  async function requestJobCancellation(jobId) {
    const response = await fetch(`${API_URL}/api/mosaic/jobs/${jobId}/cancel`, {
      method: "POST",
    });

    if (!response.ok) {
      let detail = "The backend could not stop the mosaic job.";
      try {
        const payload = await response.json();
        if (payload.detail) {
          detail = payload.detail;
        }
      } catch { }
      throw new Error(detail);
    }

    return response.json();
  }

  function applyCancelledJobState(job) {
    pendingCancellationRef.current = false;
    setIsCancelling(false);
    startTransition(() => {
      setJobState(job);
    });
    toast.success("Processing stopped", {
      id: jobToastIdRef.current ?? undefined,
      description: "The backend job was stopped before completion.",
    });
    jobToastIdRef.current = null;
    setActiveJobId("");
    setIsGenerating(false);
  }

  function clearSelectedImage() {
    resetGeneratedState();
    setFile(null);
    setSourceMeta(null);

    if (sourceUrl) {
      URL.revokeObjectURL(sourceUrl);
      setSourceUrl("");
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  useEffect(() => {
    let cancelled = false;
    let pollTimeoutId = null;
    let activeRequest = null;

    function scheduleNextHealthCheck(delay = HEALTH_CHECK_INTERVAL_MS) {
      if (cancelled || document.visibilityState === "hidden") {
        return;
      }

      pollTimeoutId = window.setTimeout(() => {
        checkHealth();
      }, delay);
    }

    async function checkHealth() {
      const controller = new AbortController();
      const isColdStartProbe = apiStatusRef.current !== "online";
      const requestTimeoutMs = isColdStartProbe
        ? HEALTH_CHECK_COLD_START_TIMEOUT_MS
        : HEALTH_CHECK_TIMEOUT_MS;
      let didTimeout = false;
      const requestTimeoutId = window.setTimeout(() => {
        didTimeout = true;
        controller.abort();
      }, requestTimeoutMs);
      const warmingHintTimeoutId = isColdStartProbe
        ? window.setTimeout(() => {
          if (!cancelled && apiStatusRef.current !== "online") {
            updateApiStatus("waking");
          }
        }, HEALTH_CHECK_WARMING_HINT_DELAY_MS)
        : null;

      activeRequest = controller;

      try {
        const response = await fetch(`${API_URL}/api/health`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error("Health check failed");
        }

        if (!cancelled) {
          updateApiStatus("online");
        }
      } catch {
        if (controller.signal.aborted && !didTimeout) {
          return;
        }

        if (!cancelled) {
          updateApiStatus("offline");
        }
      } finally {
        window.clearTimeout(requestTimeoutId);
        if (warmingHintTimeoutId) {
          window.clearTimeout(warmingHintTimeoutId);
        }

        if (activeRequest === controller) {
          activeRequest = null;
          scheduleNextHealthCheck();
        }
      }
    }

    function refreshHealthNow() {
      if (cancelled) {
        return;
      }

      if (pollTimeoutId) {
        window.clearTimeout(pollTimeoutId);
        pollTimeoutId = null;
      }

      if (activeRequest) {
        activeRequest.abort();
      }

      checkHealth();
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        refreshHealthNow();
        return;
      }

      if (pollTimeoutId) {
        window.clearTimeout(pollTimeoutId);
        pollTimeoutId = null;
      }

      if (activeRequest) {
        activeRequest.abort();
      }
    }

    checkHealth();

    window.addEventListener("focus", refreshHealthNow);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;

      if (pollTimeoutId) {
        window.clearTimeout(pollTimeoutId);
      }

      if (activeRequest) {
        activeRequest.abort();
      }

      window.removeEventListener("focus", refreshHealthNow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const previousApiStatus = previousApiStatusRef.current;

    if (apiStatus === "offline" && !hasShownOfflineToastRef.current) {
      toast.error("Mosaic service unavailable", {
        description: "The mosaic engine did not respond. If Render is waking up, give it a moment and try again.",
      });
      hasShownOfflineToastRef.current = true;
    }

    if (apiStatus === "online" && ["offline", "waking"].includes(previousApiStatus)) {
      toast.success("Mosaic service restored", {
        description: "The mosaic engine is back online and ready to render again.",
      });
    }

    if (["online", "checking", "waking"].includes(apiStatus)) {
      hasShownOfflineToastRef.current = false;
    }

    previousApiStatusRef.current = apiStatus;
  }, [apiStatus]);

  useEffect(() => {
    resultUrlRef.current = resultUrl;
  }, [resultUrl]);

  useEffect(() => {
    return () => {
      if (sourceUrl) {
        URL.revokeObjectURL(sourceUrl);
      }
    };
  }, [sourceUrl]);

  useEffect(() => {
    return () => {
      if (resultUrl) {
        URL.revokeObjectURL(resultUrl);
      }
    };
  }, [resultUrl]);

  useEffect(() => {
    if (!sourceUrl || !file) {
      setSourceMeta(null);
      return undefined;
    }

    let cancelled = false;
    const image = new window.Image();
    image.onload = () => {
      if (cancelled) {
        return;
      }

      setSourceMeta({
        width: image.naturalWidth,
        height: image.naturalHeight,
        pixelCount: image.naturalWidth * image.naturalHeight,
        fileSize: file.size,
        mimeType: file.type,
        name: file.name,
      });
    };
    image.onerror = () => {
      if (!cancelled) {
        setSourceMeta(null);
      }
    };
    image.src = sourceUrl;

    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [sourceUrl, file]);

  // ── SSE row stream: draw rows onto canvas ──
  useEffect(() => {
    if (!activeJobId) {
      return undefined;
    }

    let eventSource = null;
    let isCancelled = false;
    let sseStarted = false;

    function startSSE() {
      if (sseStarted) return;
      sseStarted = true;
      eventSource = new EventSource(`${API_URL}/api/mosaic/jobs/${activeJobId}/stream`);

      eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.done) {
          eventSource.close();
          eventSource = null;
          return;
        }

        const { width, height, offsetY, rowHeight, pixels } = data;
        const canvas = canvasRef.current;
        if (!canvas) return;

        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const rowPixels = decodeBase64Image(pixels);
        if (rowPixels.length !== width * rowHeight) {
          return;
        }
        const imageData = ctx.createImageData(width, rowHeight);
        const rgbaPixels = imageData.data;

        if (isCancelled) {
          return;
        }

        for (let sourceIndex = 0; sourceIndex < rowPixels.length; sourceIndex += 1) {
          const value = rowPixels[sourceIndex];
          const targetIndex = sourceIndex * 4;
          rgbaPixels[targetIndex + 0] = value;
          rgbaPixels[targetIndex + 1] = value;
          rgbaPixels[targetIndex + 2] = value;
          rgbaPixels[targetIndex + 3] = 255;
        }

        ctx.putImageData(imageData, 0, offsetY);

        if (!hasCanvasContent) {
          setHasCanvasContent(true);
        }
      };

      eventSource.onerror = () => {
        // SSE errors are non-fatal — the job poller handles state.
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
      };
    }

    startSSE();

    return () => {
      isCancelled = true;
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobId]);

  // ── Job status poller ──
  useEffect(() => {
    if (!activeJobId) {
      return undefined;
    }

    let cancelled = false;
    let timeoutId;

    async function pollJob() {
      try {
        const response = await fetch(`${API_URL}/api/mosaic/jobs/${activeJobId}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error("Unable to read mosaic job status.");
        }

        const job = await response.json();
        if (cancelled) {
          return;
        }

        startTransition(() => {
          setJobState(job);
        });

        // When glyph_matching starts, kick off the SSE stream if not already.
        // We do this by checking a ref — the SSE effect above runs once per activeJobId.
        // But we need to "start" it lazily since the stream has no data until matching begins.
        // The SSE effect is already connected, so rows just flow when available.

        if (job.status === "completed" && job.metadata) {
          const imageResponse = await fetch(`${API_URL}/api/mosaic/jobs/${activeJobId}/image`, {
            cache: "no-store",
          });
          if (!imageResponse.ok) {
            throw new Error("The mosaic finished, but the image could not be retrieved.");
          }

          const blob = await imageResponse.blob();
          if (cancelled) {
            return;
          }

          const nextResultUrl = URL.createObjectURL(blob);
          if (resultUrlRef.current) {
            URL.revokeObjectURL(resultUrlRef.current);
          }
          resultUrlRef.current = nextResultUrl;

          setResultUrl(nextResultUrl);
          setResultMeta({
            width: job.metadata.width,
            height: job.metadata.height,
            rows: job.metadata.rows,
            cols: job.metadata.cols,
            upscale: job.metadata.upscale,
            tileSize: job.metadata.tile_size,
            renderSize: job.metadata.render_size,
            totalTiles: job.metadata.total_tiles,
            pixelCount: job.metadata.pixel_count,
            gamma: submittedOptions?.gamma ?? options.gamma,
            contrast: submittedOptions?.contrast ?? options.contrast,
            bgThresh: submittedOptions?.bgThresh ?? options.bgThresh,
          });
          toast.success("Mosaic ready", {
            id: jobToastIdRef.current ?? undefined,
            description: `${formatNumber(job.metadata.width)} x ${formatNumber(job.metadata.height)} export is ready to preview and download.`,
          });
          jobToastIdRef.current = null;
          setIsGenerating(false);
          setActiveJobId("");
          setHasCanvasContent(false);
          return;
        }

        if (job.status === "cancelled") {
          applyCancelledJobState(job);
          setHasCanvasContent(false);
          return;
        }

        if (job.status === "failed") {
          toast.error("Generation failed", {
            id: jobToastIdRef.current ?? undefined,
            description: job.error || "The backend could not generate a mosaic.",
          });
          jobToastIdRef.current = null;
          setIsGenerating(false);
          setActiveJobId("");
          setHasCanvasContent(false);
          return;
        }

        timeoutId = window.setTimeout(
          pollJob,
          job.stage === "glyph_matching" ? 140 : 180,
        );
      } catch (pollError) {
        if (cancelled) {
          return;
        }

        toast.error("Pipeline tracking failed", {
          id: jobToastIdRef.current ?? undefined,
          description:
            pollError.message || "Something went wrong while tracking the mosaic job.",
        });
        jobToastIdRef.current = null;
        setIsGenerating(false);
        setActiveJobId("");
      }
    }

    pollJob();
    return () => {
      cancelled = true;
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [activeJobId, submittedOptions, options.gamma, options.contrast, options.bgThresh]);

  function updateOption(key, value) {
    setOptions((current) => ({ ...current, [key]: value }));
  }

  function handleFileChange(event) {
    const nextFile = event.target.files?.[0] || null;
    if (!nextFile) {
      return;
    }

    if (nextFile.size > MAX_UPLOAD_BYTES) {
      toast.error("Upload too large", {
        description: `Choose an image that is ${MAX_UPLOAD_LABEL} or smaller.`,
      });
      event.target.value = "";
      return;
    }

    resetGeneratedState();
    setSourceMeta(null);

    if (sourceUrl) {
      URL.revokeObjectURL(sourceUrl);
      setSourceUrl("");
    }

    setFile(nextFile);
    setSourceUrl(URL.createObjectURL(nextFile));
  }

  function openImagePicker() {
    fileInputRef.current?.click();
  }

  async function handleSubmit(event) {
    if (event?.preventDefault) event.preventDefault();
    if (!file) {
      toast.error("No portrait image selected", {
        description: "Choose a portrait image before generating the mosaic.",
      });
      return;
    }

    pendingCancellationRef.current = false;
    setIsCancelling(false);
    setIsGenerating(true);
    const submittedOptions = { ...options };
    setJobState({
      status: "running",
      progress: 0,
      stage: "intake_upload",
      message: "Inspecting upload envelope",
      completedRows: 0,
      totalRows: 0,
      pipelineStages: fallbackPipelineStages,
      trace: [
        {
          stage: "intake_upload",
          status: "running",
          message: "Inspecting upload envelope",
          progress: 0,
          completedRows: 0,
          totalRows: 0,
        },
      ],
    });
    setSubmittedOptions(submittedOptions);
    dismissJobToast();
    jobToastIdRef.current = toast.loading("Fabricating MNIST mosaic", {
      description: "Dispatching your portrait to the backend pipeline.",
    });
    scrollOutputIntoView();

    const body = new FormData();
    body.append("image", file);
    body.append("tile_size", String(submittedOptions.tileSize));
    body.append("gamma", String(submittedOptions.gamma));
    body.append("contrast", String(submittedOptions.contrast));
    body.append("bg_thresh", String(submittedOptions.bgThresh));

    if (submittedOptions.upscale !== "auto") {
      body.append("upscale", String(submittedOptions.upscale));
    }

    try {
      if (resultUrlRef.current) {
        URL.revokeObjectURL(resultUrlRef.current);
        resultUrlRef.current = "";
      }
      setResultUrl("");
      setResultMeta(null);

      const response = await fetch(`${API_URL}/api/mosaic/jobs`, {
        method: "POST",
        body,
      });

      if (!response.ok) {
        let detail = "The backend could not generate a mosaic.";
        try {
          const payload = await response.json();
          if (payload.detail) {
            detail = payload.detail;
          }
        } catch { }
        throw new Error(detail);
      }

      const job = await response.json();
      if (pendingCancellationRef.current) {
        try {
          const cancelledJob = await requestJobCancellation(job.id);
          applyCancelledJobState(cancelledJob);
        } catch (cancelError) {
          pendingCancellationRef.current = false;
          setIsCancelling(false);
          startTransition(() => {
            setJobState(job);
          });
          setActiveJobId(job.id);
          toast.error("Unable to stop processing", {
            id: jobToastIdRef.current ?? undefined,
            description:
              cancelError.message || "The job started, but the stop request could not be completed.",
          });
          jobToastIdRef.current = null;
        }
        return;
      }

      startTransition(() => {
        setJobState(job);
      });
      setActiveJobId(job.id);
    } catch (submitError) {
      toast.error("Unable to start the mosaic job", {
        id: jobToastIdRef.current ?? undefined,
        description:
          submitError.message || "Something went wrong while generating the mosaic.",
      });
      jobToastIdRef.current = null;
      setJobState(null);
      setActiveJobId("");
      setIsGenerating(false);
    }
  }

  async function handleCancelProcessing() {
    if (!isGenerating || isCancelling) {
      return;
    }

    pendingCancellationRef.current = true;
    setIsCancelling(true);

    if (!activeJobId) {
      toast.loading("Stopping mosaic job", {
        id: jobToastIdRef.current ?? undefined,
        description: "Cancelling as soon as the backend confirms the job id.",
      });
      return;
    }

    try {
      const cancelledJob = await requestJobCancellation(activeJobId);
      applyCancelledJobState(cancelledJob);
    } catch (cancelError) {
      pendingCancellationRef.current = false;
      setIsCancelling(false);
      toast.error("Unable to stop processing", {
        id: jobToastIdRef.current ?? undefined,
        description:
          cancelError.message || "The backend could not cancel the active job.",
      });
      jobToastIdRef.current = null;
    }
  }

  const hasTelemetry =
    resultMeta && resultMeta.width > 0 && resultMeta.height > 0;
  const sourceTelemetry = buildSourceTelemetry(sourceMeta, options);
  const hasSourceTelemetry = sourceTelemetry.length > 0;
  const pipelineStages = getPipelineStages(jobState);
  const progressValue = Math.max(0, Math.min(100, Math.round(jobState?.progress ?? 0)));
  const progressCopy = buildProgressPresentation(jobState, pipelineStages);
  const currentPipelineState = buildCurrentPipelineState(jobState, pipelineStages);
  const pipelineStageStates = buildPipelineStageStates(jobState, pipelineStages);
  const progressDisplay = displayedProgressState || {
    progressValue,
    stage: currentPipelineState.id,
    state: currentPipelineState.state,
    label: currentPipelineState.label,
    meta: currentPipelineState.meta,
    message: currentPipelineState.message,
    detail: currentPipelineState.detail,
    primary: progressCopy.primary,
    secondary: progressCopy.secondary,
  };
  const activeUpscaleIndex = Math.max(
    0,
    upscaleOptions.findIndex((value) => value === options.upscale),
  );

  useEffect(() => {
    if (!jobState) {
      displayedProgressRef.current = null;
      startTransition(() => {
        setDisplayedProgressState(null);
      });
      return;
    }

    const nextSnapshot = {
      progressValue,
      stage: currentPipelineState.id,
      state: currentPipelineState.state,
      label: currentPipelineState.label,
      meta: currentPipelineState.meta,
      message: currentPipelineState.message,
      detail: currentPipelineState.detail,
      primary: progressCopy.primary,
      secondary: progressCopy.secondary,
    };

    const previousSnapshot = displayedProgressRef.current;
    const isSameSnapshot =
      previousSnapshot &&
      previousSnapshot.progressValue === nextSnapshot.progressValue &&
      previousSnapshot.stage === nextSnapshot.stage &&
      previousSnapshot.state === nextSnapshot.state &&
      previousSnapshot.label === nextSnapshot.label &&
      previousSnapshot.meta === nextSnapshot.meta &&
      previousSnapshot.message === nextSnapshot.message &&
      previousSnapshot.detail === nextSnapshot.detail &&
      previousSnapshot.primary === nextSnapshot.primary &&
      previousSnapshot.secondary === nextSnapshot.secondary;

    if (isSameSnapshot) {
      return;
    }

    displayedProgressRef.current = nextSnapshot;
    startTransition(() => {
      setDisplayedProgressState(nextSnapshot);
    });
  }, [jobState, progressValue, currentPipelineState, progressCopy]);

  const telemetryCards = hasTelemetry
    ? [
      {
        label: "Output",
        value: `${formatNumber(resultMeta.width)} × ${formatNumber(resultMeta.height)}`,
      },
      {
        label: "Megapixels",
        value: formatDecimal(resultMeta.pixelCount / 1_000_000),
      },
      {
        label: "Grid",
        value: `${formatNumber(resultMeta.cols)} × ${formatNumber(resultMeta.rows)}`,
      },
      {
        label: "Tiles",
        value: formatCompactNumber(resultMeta.totalTiles),
      },
      {
        label: "Scale",
        value: `${resultMeta.upscale}x`,
      },
      {
        label: "Render tile",
        value: `${resultMeta.tileSize}→${resultMeta.renderSize}px`,
      },
      {
        label: "Gamma",
        value: `${resultMeta.gamma}`,
      },
      {
        label: "CLAHE",
        value: `${resultMeta.contrast}`,
      },
    ]
    : [];
  const apiStatusLabel = apiStatus === "waking" ? "warming up" : apiStatus;

  return (
    <main className="relative h-screen overflow-hidden bg-white px-4 py-4 text-stone-900 sm:px-6 lg:px-8">
      <MnistDigitGridBackground />
      <div className="relative z-10 mx-auto flex h-full w-full max-w-[1600px] flex-col gap-3">
        {/* ── Hero bar ── */}
        <section className="flex flex-shrink-0 flex-wrap items-center justify-center gap-3 text-center">
          <span className="micro-badge-enter rounded-full border border-black/8 bg-black px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-white">
            MNIST Mosaic Studio
          </span>
          <span
            className={`micro-badge-enter micro-status-badge rounded-full px-3 py-1 text-xs font-medium backdrop-blur-md ${apiStatus === "online"
              ? "border border-emerald-200/70 bg-emerald-100/70 text-emerald-800"
              : apiStatus === "waking"
                ? "border border-amber-200/70 bg-amber-100/70 text-amber-800"
              : apiStatus === "offline"
                ? "border border-rose-200/70 bg-rose-100/70 text-rose-800"
                : "border border-stone-200/70 bg-stone-100/70 text-stone-700"
              }`}
          >
            Backend {apiStatusLabel}
          </span>
          <h1 className="micro-heading-enter w-full text-[1.35rem] font-medium leading-tight tracking-[-0.04em] text-stone-800 sm:text-[1.6rem] lg:text-[1.85rem]">
            Turn a portrait into a photomosaic made entirely of handwritten digits.
          </h1>
        </section>

        {/* ── Main content: previews left, controls right ── */}
        <section
          ref={outputSectionRef}
          className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr_280px] xl:grid-cols-[1fr_300px]"
        >
          {/* ── LEFT: Both previews side by side ── */}
          <div className="grid min-h-0 gap-4 sm:grid-cols-2">
            {/* Source preview */}
            <motion.article
              data-background-static-zone
              whileHover={
                prefersReducedMotion ? undefined : { y: -3, scale: 1.002 }
              }
              transition={{ type: "spring", stiffness: 260, damping: 24, mass: 0.72 }}
              className="premium-display-card micro-card-reveal flex min-h-0 flex-col overflow-y-auto overflow-x-hidden rounded-[22px] border border-white/28 bg-white/[0.03] shadow-[0_14px_36px_rgba(42,32,19,0.03)]"
              style={{ "--micro-delay": "200ms" }}
            >
              <div className="flex-shrink-0 border-b border-white/20 px-4 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-stone-500">
                  Source
                </p>
                <h2 className="text-sm font-semibold text-stone-950">
                  Portrait preview
                </h2>
              </div>
              <div className="relative min-h-0 flex-1 p-3">
                <motion.div
                  whileHover={
                    prefersReducedMotion ? undefined : { scale: 1.004 }
                  }
                  transition={{ type: "spring", stiffness: 280, damping: 24, mass: 0.7 }}
                  className="premium-preview-frame micro-preview-frame relative flex h-full items-center justify-center overflow-hidden rounded-[16px] border border-white/20 bg-white/[0.02]"
                >
                  {sourceUrl ? (
                    <InspectableImage
                      src={sourceUrl}
                      alt="Uploaded portrait preview"
                      title="Source portrait preview"
                      hint="Open the uploaded portrait in a larger preview before generation."
                      previewLabel="Click to preview"
                    />
                  ) : (
                    <div className="premium-empty-state px-4 text-center">
                      <span className="premium-empty-chip">Source feed idle</span>
                      <p className="mt-2 max-w-[12rem] text-xs leading-5 text-stone-500">
                        Upload a portrait to preview.
                      </p>
                    </div>
                  )}
                </motion.div>
              </div>
              {hasSourceTelemetry ? (
                <div className="flex-shrink-0 border-t border-white/15 px-5 py-4 text-center">
                  <h3 className="mb-3 text-[0.7rem] font-bold uppercase tracking-[0.15em] text-stone-900/40">
                    Source Details
                  </h3>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-2">
                    {sourceTelemetry.map((card, index) => (
                      <div
                        key={card.label}
                        className="micro-card-reveal flex flex-col items-center gap-0.5"
                        style={{ "--micro-delay": `${480 + (index * 55)}ms` }}
                      >
                        <span className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-stone-400">
                          {card.label}
                        </span>
                        <span className="text-sm font-semibold tracking-[-0.01em] text-stone-800">
                          {card.value}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </motion.article>

            {/* Result preview */}
            <motion.article
              data-background-static-zone
              whileHover={
                prefersReducedMotion ? undefined : { y: -3, scale: 1.002 }
              }
              transition={{ type: "spring", stiffness: 260, damping: 24, mass: 0.72 }}
              className="premium-display-card micro-card-reveal flex min-h-0 flex-col overflow-y-auto overflow-x-hidden rounded-[22px] border border-white/28 bg-white/[0.03] shadow-[0_14px_36px_rgba(42,32,19,0.03)]"
              style={{ "--micro-delay": "280ms" }}
            >
              <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-white/20 px-4 py-2.5">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-stone-500">
                    Result
                  </p>
                  <h2 className="text-sm font-semibold text-stone-950">
                    Generated mosaic
                  </h2>
                </div>
                {resultUrl ? (
                  <a
                    href={resultUrl}
                    download="mnist-mosaic.png"
                    aria-label="Download PNG"
                    title="Download PNG"
                    className="glass-value-pill micro-download-chip inline-flex items-center justify-center rounded-full px-3 py-1.5 text-xs font-semibold text-stone-900"
                  >
                    ↓ Download
                  </a>
                ) : null}
              </div>
              <div className="relative min-h-0 flex-1 p-3">
                <motion.div
                  whileHover={
                    prefersReducedMotion ? undefined : { scale: 1.004 }
                  }
                  transition={{ type: "spring", stiffness: 280, damping: 24, mass: 0.7 }}
                  className={`premium-preview-frame micro-preview-frame relative flex h-full items-center justify-center overflow-hidden rounded-[16px] border border-white/20 bg-white/[0.02] ${isGenerating ? "is-generating" : ""}`}
                >
                  {resultUrl ? (
                    <div className="result-image-reveal flex h-full w-full items-center justify-center">
                      <InspectableImage
                        src={resultUrl}
                        alt="MNIST photomosaic output"
                        title="Generated MNIST mosaic"
                        hint="Open the generated mosaic in a larger preview."
                        previewLabel="Click to preview"
                      />
                    </div>
                  ) : isGenerating ? (
                    <>
                      <canvas
                        ref={canvasRef}
                        className="live-preview-canvas"
                      />
                      {!hasCanvasContent && (
                        <div className="live-preview-overlay absolute inset-0 z-10 flex items-center justify-center">
                          <div className="premium-empty-state px-4 text-center">
                            <span className="premium-empty-chip">Fabricating…</span>
                            <p className="mt-2 max-w-[12rem] text-xs leading-5 text-stone-500">
                              Mosaic preview will appear shortly.
                            </p>
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="premium-empty-state px-4 text-center">
                      <span className="premium-empty-chip">
                        Output standby
                      </span>
                      <p className="mt-2 max-w-[12rem] text-xs leading-5 text-stone-500">
                        Mosaic will appear here after generation.
                      </p>
                    </div>
                  )}
                </motion.div>
              </div>
              {isGenerating ? (
                <div className="fabrication-bottom-bar flex-shrink-0 border-t border-white/15 px-5 py-3">
                  <div className="flex items-center gap-3">
                    <div className="flex min-w-[3.2rem] flex-col gap-0.5">
                      <span className="text-[0.56rem] font-bold uppercase tracking-[0.14em] text-stone-500/70">
                        Fabricating
                      </span>
                      <span className="text-[0.82rem] font-bold text-stone-900/90 [font-variant-numeric:tabular-nums]">
                        {progressDisplay.progressValue}%
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="micro-progress-shell h-2 overflow-hidden rounded-full bg-black/[0.07] shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)]">
                        <div
                          className="micro-progress-fill h-full rounded-full transition-[width] duration-500 ease-out"
                          style={{ width: `${progressDisplay.progressValue}%` }}
                        />
                      </div>
                      <div className="mt-1 flex justify-between">
                        <span className="text-[0.62rem] font-semibold text-stone-600/80">{progressCopy.primary}</span>
                        <span className="text-[0.56rem] font-bold uppercase tracking-[0.12em] text-stone-400/70">{progressDisplay.label}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={handleCancelProcessing}
                      disabled={isCancelling}
                      className="glass-value-pill live-preview-stop-btn flex-shrink-0"
                    >
                      {isCancelling ? "Stopping…" : "Stop"}
                    </button>
                  </div>
                </div>
              ) : hasTelemetry ? (
                <div className="flex-shrink-0 border-t border-white/15 px-5 py-4 text-center">
                  <h3 className="mb-3 text-[0.7rem] font-bold uppercase tracking-[0.15em] text-stone-900/40">
                    Render Telemetry
                  </h3>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-2">
                    {telemetryCards.map((card, index) => (
                      <div
                        key={card.label}
                        className="micro-card-reveal flex flex-col items-center gap-0.5"
                        style={{ "--micro-delay": `${560 + (index * 55)}ms` }}
                      >
                        <span className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-stone-400">
                          {card.label}
                        </span>
                        <span className="text-sm font-semibold tracking-[-0.01em] text-stone-800">
                          {card.value}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </motion.article>
          </div>

          {/* ── RIGHT: Compact controls sidebar ── */}
          <LiquidGlassPanel
            as="form"
            onSubmit={handleSubmit}
            data-background-static-zone
            className="liquid-glass-panel micro-panel-enter relative flex w-full flex-col overflow-y-auto overflow-x-hidden rounded-[22px] px-3 py-3 text-left text-stone-950 lg:sticky lg:top-4"
            style={{ maxHeight: "calc(100vh - 6rem)" }}
          >
            <div className="flex flex-col gap-1.5">
              {/* Upload section — compact */}
              <div className="glass-block glass-block-strong micro-card-reveal p-2" style={{ "--micro-delay": "90ms" }}>
                <div className="micro-interactive-surface flex flex-col gap-1.5 p-2 transition">
                  <span className="text-[0.8rem] font-semibold tracking-[-0.02em] text-stone-950">
                    Source portrait
                  </span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={openImagePicker}
                      className="glass-value-pill glass-upload-chip micro-pill inline-flex shrink-0 items-center px-3 py-1.5 text-xs font-semibold text-stone-900"
                    >
                      Select image
                    </button>
                    <div
                      className={`glass-value-pill micro-pill upload-file-pill inline-flex min-w-0 flex-1 items-center px-2.5 py-1.5 text-xs font-medium text-stone-700 ${file ? "is-filled" : "is-empty"}`}
                      title={file?.name || "No image selected"}
                    >
                      <span className="block min-w-0 flex-1 truncate">
                        {file ? file.name : "None"}
                      </span>
                      {file ? (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            clearSelectedImage();
                          }}
                          className="upload-file-remove ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold leading-none"
                          aria-label="Remove"
                          title="Remove"
                        >
                          ×
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>

              <div className="mx-2 border-t border-stone-200/40" />

              {/* Presets row */}
              <div
                className="glass-block glass-block-strong micro-card-reveal px-3 py-2"
                style={{ "--micro-delay": "100ms" }}
              >
                <p className="mb-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.1em] text-stone-500">
                  Preset
                </p>
                <div className="flex gap-1.5">
                  {presets.map((preset) => {
                    const isActive =
                      options.tileSize === preset.tileSize &&
                      options.gamma === preset.gamma &&
                      options.contrast === preset.contrast &&
                      options.bgThresh === preset.bgThresh;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() =>
                          setOptions((prev) => ({
                            ...prev,
                            tileSize: preset.tileSize,
                            gamma: preset.gamma,
                            contrast: preset.contrast,
                            bgThresh: preset.bgThresh,
                          }))
                        }
                        className={`glass-preset-btn flex-1 py-1 text-[0.72rem] font-semibold transition ${isActive ? "is-active" : "text-stone-600"
                          }`}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Structure group: Tile size + Bg threshold */}
              <div
                className="glass-block glass-control-block glass-slider-block micro-card-reveal micro-interactive-surface micro-slider-shell px-3 py-2"
                style={{ "--micro-delay": "140ms" }}
              >
                <p className="mb-1 text-[0.68rem] font-semibold uppercase tracking-[0.1em] text-stone-500">
                  Structure
                </p>
                {structureControls.map((control) => (
                  <label key={control.id} className="block">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-[0.72rem] font-medium tracking-[-0.01em] text-stone-700">
                        {control.label}
                      </p>
                      <span className="glass-value-pill glass-control-value glass-slider-value micro-pill inline-flex min-w-[2.4rem] items-center justify-center text-[0.78rem] font-bold text-stone-950 [font-variant-numeric:tabular-nums]">
                        {options[control.id]}
                      </span>
                    </div>
                    <GlassSlider
                      id={control.id}
                      min={control.min}
                      max={control.max}
                      step={control.step}
                      value={options[control.id]}
                      onChange={(event) =>
                        updateOption(
                          control.id,
                          control.step < 1
                            ? Number(event.target.value)
                            : parseInt(event.target.value, 10),
                        )
                      }
                      className="mt-1 mb-1"
                    />
                  </label>
                ))}
              </div>

              {/* Tone group: Gamma + CLAHE */}
              <div
                className="glass-block glass-control-block glass-slider-block micro-card-reveal micro-interactive-surface micro-slider-shell px-3 py-2"
                style={{ "--micro-delay": "180ms" }}
              >
                <p className="mb-1 text-[0.68rem] font-semibold uppercase tracking-[0.1em] text-stone-500">
                  Tone mapping
                </p>
                {toneControls.map((control) => (
                  <label key={control.id} className="block">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-[0.72rem] font-medium tracking-[-0.01em] text-stone-700">
                        {control.label}
                      </p>
                      <span className="glass-value-pill glass-control-value glass-slider-value micro-pill inline-flex min-w-[2.4rem] items-center justify-center text-[0.78rem] font-bold text-stone-950 [font-variant-numeric:tabular-nums]">
                        {options[control.id]}
                      </span>
                    </div>
                    <GlassSlider
                      id={control.id}
                      min={control.min}
                      max={control.max}
                      step={control.step}
                      value={options[control.id]}
                      onChange={(event) =>
                        updateOption(
                          control.id,
                          control.step < 1
                            ? Number(event.target.value)
                            : parseInt(event.target.value, 10),
                        )
                      }
                      className="mt-1 mb-1"
                    />
                  </label>
                ))}
              </div>

              {/* Upscale */}
              <div
                className="glass-block glass-upscale-block micro-card-reveal micro-interactive-surface px-3 py-2"
                style={{ "--micro-delay": "220ms" }}
              >
                <p className="mb-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.1em] text-stone-500">
                  Upscale
                </p>
                <div
                  className="glass-segmented-control grid grid-cols-6 gap-1 p-1"
                  style={{
                    "--segment-index-mobile-col": activeUpscaleIndex % 3,
                    "--segment-index-mobile-row": Math.floor(activeUpscaleIndex / 3),
                    "--segment-index-desktop": activeUpscaleIndex,
                  }}
                >
                  {upscaleOptions.map((value) => {
                    const active = options.upscale === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => updateOption("upscale", value)}
                        className={`glass-segment micro-choice w-full h-full px-2 py-2 text-xs font-semibold [font-variant-numeric:tabular-nums] transition ${active
                          ? "glass-segment-active text-stone-950"
                          : "text-stone-600"
                          }`}
                      >
                        {value === "auto" ? "Auto" : `${value}x`}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Generate button */}
              <div className="mt-0.5">
                <GenerateMosaicButton
                  disabled={isGenerating}
                  busy={isGenerating}
                  onClick={handleSubmit}
                  className="h-9 w-full px-4 text-[0.82rem] font-semibold tracking-[-0.03em] text-stone-950 transition disabled:cursor-not-allowed disabled:opacity-70"
                />
              </div>
            </div>
          </LiquidGlassPanel>
        </section>
      </div>
    </main>
  );
}
