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
const HEALTH_CHECK_INTERVAL_MS = 2500;
const HEALTH_CHECK_TIMEOUT_MS = 1800;

const defaultOptions = {
  tileSize: 13,
  upscale: "auto",
  gamma: 0.8,
  contrast: 3,
  bgThresh: 5,
};

const upscaleOptions = ["auto", 1, 2, 3, 4, 5];

const controlGroups = [
  {
    id: "tileSize",
    label: "Tile size",
    description: "Smaller tiles add detail but take longer to render.",
    min: 4,
    max: 24,
    step: 1,
  },
  {
    id: "gamma",
    label: "Gamma",
    description: "Brightens or darkens the midtones of the portrait.",
    min: 0.3,
    max: 1.8,
    step: 0.1,
  },
  {
    id: "contrast",
    label: "CLAHE contrast",
    description: "Boosts local contrast before the digit matching step.",
    min: 0.5,
    max: 8,
    step: 0.5,
  },
  {
    id: "bgThresh",
    label: "Background threshold",
    description: "Skips the darkest regions so the background stays open.",
    min: 0,
    max: 40,
    step: 1,
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
  const projectedWidth = cols * options.tileSize * effectiveUpscale;
  const projectedHeight = rows * options.tileSize * effectiveUpscale;
  const mimeLabel = sourceMeta.mimeType
    ? sourceMeta.mimeType.replace("image/", "").toUpperCase()
    : "IMAGE";

  return [
    {
      label: "Capture matrix",
      value: `${formatNumber(sourceMeta.width)} × ${formatNumber(sourceMeta.height)}`,
      detail: `${formatDecimal(sourceMeta.pixelCount / 1_000_000)} megapixels`,
    },
    {
      label: "Frame bias",
      value: getOrientationLabel(sourceMeta.width, sourceMeta.height),
      detail: `${formatDecimal(sourceMeta.width / sourceMeta.height)} : 1 aspect vector`,
    },
    {
      label: "Payload signature",
      value: `${mimeLabel} stream`,
      detail: `${formatFileSize(sourceMeta.fileSize)} upload envelope`,
    },
    {
      label: "Lattice forecast",
      value: `${formatNumber(cols)} × ${formatNumber(rows)}`,
      detail: `${formatCompactNumber(totalTiles)} candidate cells`,
    },
    {
      label: "Projection field",
      value: `${effectiveUpscale}x ${options.upscale === "auto" ? "auto" : "manual"}`,
      detail: `${formatNumber(projectedWidth)} × ${formatNumber(projectedHeight)} target raster`,
    },
    {
      label: "Control stack",
      value: `gamma ${options.gamma}`,
      detail: `CLAHE ${options.contrast} / gate ${options.bgThresh}`,
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

    async function checkHealth() {
      const controller = new AbortController();
      const requestTimeoutId = window.setTimeout(() => {
        controller.abort();
      }, HEALTH_CHECK_TIMEOUT_MS);

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
          setApiStatus("online");
        }
      } catch {
        if (!cancelled) {
          setApiStatus("offline");
        }
      } finally {
        window.clearTimeout(requestTimeoutId);

        if (activeRequest === controller) {
          activeRequest = null;
        }

        if (!cancelled) {
          pollTimeoutId = window.setTimeout(checkHealth, HEALTH_CHECK_INTERVAL_MS);
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
        description: "The mosaic engine is temporarily offline. Please try again in a moment.",
      });
      hasShownOfflineToastRef.current = true;
    }

    if (apiStatus === "online" && previousApiStatus === "offline") {
      toast.success("Mosaic service restored", {
        description: "The mosaic engine is back online and ready again.",
      });
    }

    if (apiStatus === "online" || apiStatus === "checking") {
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
          return;
        }

        if (job.status === "cancelled") {
          applyCancelledJobState(job);
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
    event.preventDefault();
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
        label: "Output matrix",
        value: `${formatNumber(resultMeta.width)} × ${formatNumber(resultMeta.height)}`,
        detail: `${formatDecimal(resultMeta.pixelCount / 1_000_000)} megapixels`,
      },
      {
        label: "Tile lattice",
        value: `${formatNumber(resultMeta.cols)} × ${formatNumber(resultMeta.rows)}`,
        detail: `${formatCompactNumber(resultMeta.totalTiles)} digit cells`,
      },
      {
        label: "Scale vector",
        value: `${resultMeta.upscale}x render`,
        detail: `${resultMeta.tileSize}px source -> ${resultMeta.renderSize}px output`,
      },
      {
        label: "Tone profile",
        value: `gamma ${resultMeta.gamma}`,
        detail: `CLAHE ${resultMeta.contrast}`,
      },
      {
        label: "Void threshold",
        value: `gate ${resultMeta.bgThresh}`,
        detail: "background suppression active",
      },
      {
        label: "Library span",
        value: "140K glyph states",
        detail: "MNIST originals + inversions",
      },
    ]
    : [];

  return (
    <main className="relative min-h-screen overflow-hidden bg-white px-5 py-8 text-stone-900 sm:px-8 lg:px-10">
      <MnistDigitGridBackground />
      <div className="relative z-10 mx-auto flex w-full max-w-7xl flex-col gap-4 pb-5 pt-2">
        <section className="mx-auto flex w-full max-w-6xl flex-col items-center gap-4 text-center">
          <div className="flex flex-wrap items-center justify-center gap-3">
            <span className="micro-badge-enter rounded-full border border-black/8 bg-black px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-white">
              MNIST Mosaic Studio
            </span>
            <span
              className={`micro-badge-enter micro-status-badge rounded-full px-3 py-1 text-xs font-medium backdrop-blur-md ${apiStatus === "online"
                ? "border border-emerald-200/70 bg-emerald-100/70 text-emerald-800"
                : apiStatus === "offline"
                  ? "border border-rose-200/70 bg-rose-100/70 text-rose-800"
                  : "border border-stone-200/70 bg-stone-100/70 text-stone-700"
                }`}
            >
              Backend {apiStatus}
            </span>
          </div>

          <div className="max-w-5xl">
            <h2 className="micro-heading-enter text-[2rem] font-medium leading-[0.98] tracking-[-0.045em] text-stone-800 sm:text-[3rem] lg:text-[3.7rem] xl:text-[4rem]">
              Turn a portrait into a photomosaic made entirely of handwritten digits.
            </h2>
          </div>

          <LiquidGlassPanel
            as="form"
            onSubmit={handleSubmit}
            data-background-static-zone
            className="liquid-glass-panel micro-panel-enter relative w-full max-w-6xl overflow-hidden rounded-[42px] px-5 py-5 text-left text-stone-950 sm:px-6 sm:py-6"
          >
            <div className="relative grid gap-4 lg:grid-cols-[minmax(0,0.84fr)_minmax(0,1.16fr)] lg:items-start">
              <div className="flex flex-col gap-3.5">
                <div className="glass-block glass-control-block glass-slider-block micro-card-reveal px-4.5 py-3.5 text-left">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-stone-500">
                    Upload Interface
                  </p>
                  <h2 className="mt-1 text-[0.98rem] font-semibold tracking-[-0.02em] text-stone-950 sm:text-[1.02rem]">
                    Upload your source portrait
                  </h2>
                  <p className="mt-1 max-w-[15rem] text-[0.82rem] leading-5 text-stone-600">
                    Drop in a clean portrait, tune the render field, and let the digit
                    engine synthesize the mosaic.
                  </p>
                </div>

                <div className="glass-block glass-block-strong micro-card-reveal p-3" style={{ "--micro-delay": "90ms" }}>
                  <div className="micro-interactive-surface flex min-h-[210px] flex-col justify-between gap-4 p-4.5 transition">
                    <span className="text-base font-semibold tracking-[-0.03em] text-stone-950">
                      Choose a portrait image
                    </span>
                    <span className="block max-w-sm text-[0.9rem] leading-5 text-stone-600">
                      JPG, PNG, or WebP up to {MAX_UPLOAD_LABEL}. Metadata is stripped
                      automatically before the mosaic pipeline starts.
                    </span>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleFileChange}
                      className="hidden"
                    />
                    <div className="upload-control-stack grid w-full justify-items-start gap-2.5">
                      <div className="upload-selection-row grid w-full items-center gap-2.5 md:grid-cols-[auto_minmax(0,1fr)]">
                        <button
                          type="button"
                          onClick={openImagePicker}
                          className="glass-value-pill glass-upload-chip micro-pill inline-flex w-fit max-w-full items-center px-4.5 py-2.5 text-sm font-semibold text-stone-900"
                        >
                          Select image
                        </button>
                        <div
                          className={`glass-value-pill micro-pill upload-file-pill inline-flex min-w-0 w-full items-center px-4.5 py-2.5 text-sm font-semibold text-stone-800 ${file ? "is-filled" : "is-empty"}`}
                          title={file?.name || "No image selected"}
                        >
                          <span className="block min-w-0 flex-1 truncate">
                            {file ? file.name : "No image selected"}
                          </span>
                          {file ? (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                clearSelectedImage();
                              }}
                              className="upload-file-remove inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-base font-semibold leading-none"
                              aria-label="Remove selected image"
                              title="Remove image"
                            >
                              x
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div
                  className="micro-card-reveal flex justify-center"
                  style={{ "--micro-delay": "150ms" }}
                >
                  <GenerateMosaicButton
                    disabled={isGenerating}
                    busy={isGenerating}
                    className="h-10 px-5 text-[0.92rem] font-semibold tracking-[-0.03em] text-stone-950 transition disabled:cursor-not-allowed disabled:opacity-70 sm:min-w-[12.25rem]"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-3.5">
                <div className="grid gap-3 sm:grid-cols-2">
                  {controlGroups.map((control, index) => (
                    <label
                      key={control.id}
                      className="glass-block glass-control-block glass-slider-block micro-card-reveal micro-interactive-surface micro-slider-shell px-4.5 py-3.5"
                      style={{ "--micro-delay": `${120 + (index * 55)}ms` }}
                    >
                      <div className="grid grid-cols-[minmax(0,1fr)_3.75rem] items-start gap-3">
                        <div className="min-w-0">
                          <p className="text-[0.92rem] font-semibold tracking-[-0.02em] text-stone-900">
                            {control.label}
                          </p>
                          <p className="mt-1 max-w-[15rem] text-[0.82rem] leading-5 text-stone-600">
                            {control.description}
                          </p>
                        </div>
                        <span className="glass-value-pill glass-control-value glass-slider-value micro-pill inline-flex min-w-[3.75rem] items-center justify-center px-3 py-1 text-sm font-semibold text-stone-900 [font-variant-numeric:tabular-nums]">
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
                        className="mt-3"
                      />
                    </label>
                  ))}

                  <label
                    className="glass-block glass-control-block glass-upscale-block micro-card-reveal micro-interactive-surface px-4.5 py-3.5 sm:col-span-2"
                    style={{ "--micro-delay": "330ms" }}
                  >
                    <div className="flex items-end justify-between gap-4">
                      <div>
                        <p className="text-[0.92rem] font-semibold tracking-[-0.02em] text-stone-900">
                          Upscale
                        </p>
                        <p className="mt-1 text-[0.82rem] leading-5 text-stone-600">
                          Auto uses the source resolution to target a high-resolution export.
                        </p>
                      </div>
                    </div>
                    <div
                      className="glass-segmented-control mt-3 grid grid-cols-3 gap-1.5 p-1.5 sm:grid-cols-6"
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
                            className={`glass-segment micro-choice px-3 py-2 text-sm font-semibold [font-variant-numeric:tabular-nums] transition ${active
                              ? "glass-segment-active text-stone-950"
                              : "text-stone-600"
                              }`}
                          >
                            {value === "auto" ? "Auto" : `${value}x`}
                          </button>
                        );
                      })}
                    </div>
                  </label>
                </div>

              </div>
            </div>
          </LiquidGlassPanel>
        </section>

        <section
          ref={outputSectionRef}
          className="grid scroll-mt-6 gap-6 lg:grid-cols-2"
        >
          <motion.article
            data-background-static-zone
            whileHover={
              prefersReducedMotion ? undefined : { y: -4, scale: 1.002 }
            }
            transition={{ type: "spring", stiffness: 260, damping: 24, mass: 0.72 }}
            className="premium-display-card micro-card-reveal overflow-hidden rounded-[28px] border border-white/28 bg-white/[0.03] shadow-[0_14px_36px_rgba(42,32,19,0.03)]"
            style={{ "--micro-delay": "420ms" }}
          >
            <div className="border-b border-white/20 px-5 py-4 sm:px-6">
              <p className="text-sm font-semibold uppercase tracking-[0.22em] text-stone-500">
                Source
              </p>
              <h2 className="mt-1 text-xl font-semibold text-stone-950">
                Portrait preview
              </h2>
            </div>
            <div className="p-5 sm:p-6">
              <motion.div
                whileHover={
                  prefersReducedMotion ? undefined : { scale: 1.004 }
                }
                transition={{ type: "spring", stiffness: 280, damping: 24, mass: 0.7 }}
                className="premium-preview-frame micro-preview-frame relative flex aspect-[4/5] items-center justify-center overflow-hidden rounded-[22px] border border-white/20 bg-white/[0.02]"
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
                  <div className="premium-empty-state px-6 text-center">
                    <span className="premium-empty-chip">Source feed idle</span>
                    <p className="mt-4 max-w-sm text-sm leading-7 text-stone-600">
                      Upload a portrait to preview the input before the MNIST matching starts.
                    </p>
                  </div>
                )}
              </motion.div>

              {hasSourceTelemetry ? (
                <div className="mt-5 space-y-3">
                  <div className="telemetry-section-header gap-3">
                    <p className="telemetry-section-kicker text-sm font-semibold uppercase tracking-[0.22em] text-stone-500">
                      Source Telemetry
                    </p>
                    <p className="telemetry-section-meta text-xs font-medium text-stone-500">
                      Live from the uploaded frame
                    </p>
                  </div>
                  <div className="telemetry-grid grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {sourceTelemetry.map((card, index) => (
                      <div
                        key={card.label}
                        className="micro-telemetry-card telemetry-card micro-card-reveal rounded-3xl border border-white/20 bg-white/[0.03] px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]"
                        style={{ "--micro-delay": `${480 + (index * 55)}ms` }}
                      >
                        <p className="telemetry-card-label text-sm font-medium uppercase tracking-[0.18em] text-stone-500">
                          {card.label}
                        </p>
                        <p className="telemetry-card-value mt-2 text-xl font-semibold tracking-[-0.03em] text-stone-950">
                          {card.value}
                        </p>
                        <p className="telemetry-card-detail mt-2 text-sm leading-6 text-stone-600">
                          {card.detail}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </motion.article>

          <motion.article
            data-background-static-zone
            whileHover={
              prefersReducedMotion ? undefined : { y: -4, scale: 1.002 }
            }
            transition={{ type: "spring", stiffness: 260, damping: 24, mass: 0.72 }}
            className="premium-display-card micro-card-reveal overflow-hidden rounded-[28px] border border-white/28 bg-white/[0.03] shadow-[0_14px_36px_rgba(42,32,19,0.03)]"
            style={{ "--micro-delay": "500ms" }}
          >
            <div className="border-b border-white/20 px-5 py-4 sm:px-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.22em] text-stone-500">
                    Result
                  </p>
                  <h2 className="mt-1 text-xl font-semibold text-stone-950">
                    Generated mosaic
                  </h2>
                </div>
                {resultUrl ? (
                  <a
                    href={resultUrl}
                    download="mnist-mosaic.png"
                    aria-label="Download PNG"
                    title="Download PNG"
                    className="glass-value-pill glass-upload-remove micro-download-chip inline-flex items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold text-stone-900"
                  >
                    Download
                  </a>
                ) : null}
              </div>
            </div>

            <div className="space-y-5 p-5 sm:p-6">
              <motion.div
                whileHover={
                  prefersReducedMotion ? undefined : { scale: 1.004 }
                }
                transition={{ type: "spring", stiffness: 280, damping: 24, mass: 0.7 }}
                className={`premium-preview-frame micro-preview-frame relative flex aspect-[4/5] items-center justify-center overflow-hidden rounded-[22px] border border-white/20 bg-white/[0.02] ${isGenerating ? "is-generating" : ""}`}
              >
                {resultUrl ? (
                  <InspectableImage
                    src={resultUrl}
                    alt="MNIST photomosaic output"
                    title="Generated MNIST mosaic"
                    hint="Open the generated mosaic in a larger preview."
                    previewLabel="Click to preview"
                  />
                ) : isGenerating ? (
                  <AnimatePresence initial={false}>
                    <motion.div
                      initial={{ opacity: 0, y: 10, scale: 0.985 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -8, scale: 0.985 }}
                      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                      className="pipeline-overlay px-6 py-6 sm:px-8"
                    >
                      <span className="pipeline-overlay-chip">Fabrication progress</span>
                      <div className="pipeline-overlay-header">
                        <p className="pipeline-overlay-percent">{progressDisplay.progressValue}%</p>
                        <p className="pipeline-overlay-stage">{progressDisplay.label}</p>
                      </div>
                      <p className="pipeline-overlay-message">{progressDisplay.message}</p>
                      <p className="pipeline-overlay-detail">{progressDisplay.detail}</p>

                      <div className="pipeline-progress-block">
                        <div className="micro-progress-shell pipeline-progress-shell h-3 overflow-hidden rounded-full bg-black/[0.08] shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]">
                          <div
                            className="micro-progress-fill pipeline-progress-fill h-full rounded-full transition-[width] duration-500 ease-out"
                            style={{ width: `${progressDisplay.progressValue}%` }}
                          />
                        </div>
                        <div className="pipeline-progress-copy">
                          <p className="pipeline-progress-primary">{progressCopy.primary}</p>
                          <p className="pipeline-progress-secondary">{progressCopy.secondary}</p>
                        </div>
                      </div>

                      <div className="pipeline-overlay-actions">
                        <button
                          type="button"
                          onClick={handleCancelProcessing}
                          disabled={isCancelling}
                          className="glass-value-pill pipeline-stop-button inline-flex items-center justify-center px-4 py-2.5 text-sm font-semibold text-stone-900 disabled:cursor-not-allowed disabled:opacity-65"
                        >
                          {isCancelling ? "Stopping..." : "Stop processing"}
                        </button>
                      </div>

                      <div className="pipeline-stage-grid">
                        {pipelineStageStates.map((stage) => (
                          <div
                            key={stage.id}
                            className={`pipeline-stage-chip is-${stage.state}`}
                          >
                            <div className="pipeline-stage-chip-head">
                              <span className="pipeline-stage-chip-dot" />
                              <span className="pipeline-stage-chip-label">{stage.label}</span>
                            </div>
                            <span className="pipeline-stage-chip-meta">{stage.meta}</span>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  </AnimatePresence>
                ) : (
                  <div className="premium-empty-state px-6 text-center">
                    <span className="premium-empty-chip">
                      Output buffer standby
                    </span>
                    <p className="mt-4 max-w-sm text-sm leading-7 text-stone-600">
                      Your finished mosaic will appear here as soon as the backend returns the rendered PNG.
                    </p>
                  </div>
                )}
              </motion.div>

              {hasTelemetry ? (
                <div className="space-y-3">
                  <div className="telemetry-section-header gap-3">
                    <p className="telemetry-section-kicker text-sm font-semibold uppercase tracking-[0.22em] text-stone-500">
                      Mosaic Telemetry
                    </p>
                    <p className="telemetry-section-meta text-xs font-medium text-stone-500">
                      Generated from live backend metadata
                    </p>
                  </div>
                  <div className="telemetry-grid grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {telemetryCards.map((card, index) => (
                      <div
                        key={card.label}
                        className="micro-telemetry-card telemetry-card micro-card-reveal rounded-3xl border border-white/20 bg-white/[0.03] px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]"
                        style={{ "--micro-delay": `${560 + (index * 55)}ms` }}
                      >
                        <p className="telemetry-card-label text-sm font-medium uppercase tracking-[0.18em] text-stone-500">
                          {card.label}
                        </p>
                        <p className="telemetry-card-value mt-2 text-xl font-semibold tracking-[-0.03em] text-stone-950">
                          {card.value}
                        </p>
                        <p className="telemetry-card-detail mt-2 text-sm leading-6 text-stone-600">
                          {card.detail}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </motion.article>
        </section>
      </div>
    </main>
  );
}
