"use client";
/* eslint-disable @next/next/no-img-element */

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import GenerateMosaicButton from "@/components/generate-mosaic-button";
import LiquidGlassPanel from "@/components/liquid-glass-panel";
import MnistDigitGridBackground from "@/components/mnist-digit-grid-background";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
const TARGET_OUTPUT_PX = 3000;
const UPSCALE_MIN = 1;
const UPSCALE_MAX = 5;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_LABEL = "20 MB";

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

function getSliderProgress(value, min, max) {
  if (max <= min) {
    return 0;
  }

  return ((value - min) / (max - min)) * 100;
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
  const [file, setFile] = useState(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceMeta, setSourceMeta] = useState(null);
  const [resultUrl, setResultUrl] = useState("");
  const [resultMeta, setResultMeta] = useState(null);
  const [apiStatus, setApiStatus] = useState("checking");
  const [isGenerating, setIsGenerating] = useState(false);
  const [jobState, setJobState] = useState(null);
  const [activeJobId, setActiveJobId] = useState("");
  const [submittedOptions, setSubmittedOptions] = useState(null);
  const [options, setOptions] = useState(defaultOptions);
  const resultUrlRef = useRef("");
  const jobToastIdRef = useRef(null);
  const hasShownOfflineToastRef = useRef(false);
  const fileInputRef = useRef(null);

  function dismissJobToast() {
    if (jobToastIdRef.current) {
      toast.dismiss(jobToastIdRef.current);
      jobToastIdRef.current = null;
    }
  }

  function resetGeneratedState() {
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
    let isMounted = true;

    async function checkHealth() {
      try {
        const response = await fetch(`${API_URL}/api/health`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error("Health check failed");
        }

        if (isMounted) {
          setApiStatus("online");
        }
      } catch {
        if (isMounted) {
          setApiStatus("offline");
        }
      }
    }

    checkHealth();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (apiStatus === "offline" && !hasShownOfflineToastRef.current) {
      toast.error("Backend unavailable", {
        description: "Start the FastAPI server before generating a mosaic.",
      });
      hasShownOfflineToastRef.current = true;
      return;
    }

    if (apiStatus === "online") {
      hasShownOfflineToastRef.current = false;
    }
  }, [apiStatus]);

  useEffect(() => {
    resultUrlRef.current = resultUrl;
  }, [resultUrl]);

  useEffect(() => {
    return () => {
      if (sourceUrl) {
        URL.revokeObjectURL(sourceUrl);
      }
      if (resultUrl) {
        URL.revokeObjectURL(resultUrl);
      }
    };
  }, [sourceUrl, resultUrl]);

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

        setJobState(job);

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

        timeoutId = window.setTimeout(pollJob, 250);
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

  async function handleSubmit(event) {
    event.preventDefault();
    if (!file) {
      toast.error("No portrait image selected", {
        description: "Choose a portrait image before generating the mosaic.",
      });
      return;
    }

    setIsGenerating(true);
    const submittedOptions = { ...options };
    setJobState({
      status: "queued",
      progress: 0,
      stage: "queued",
      message: "Dispatching image to backend",
      completedRows: 0,
      totalRows: 0,
    });
    setSubmittedOptions(submittedOptions);
    dismissJobToast();
    jobToastIdRef.current = toast.loading("Fabricating MNIST mosaic", {
      description: "Dispatching your portrait to the backend pipeline.",
    });

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
      setJobState(job);
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

  const hasTelemetry =
    resultMeta && resultMeta.width > 0 && resultMeta.height > 0;
  const sourceTelemetry = buildSourceTelemetry(sourceMeta, options);
  const hasSourceTelemetry = sourceTelemetry.length > 0;
  const progressValue = Math.max(0, Math.min(100, Math.round(jobState?.progress ?? 0)));
  const progressRows =
    jobState?.totalRows > 0
      ? `${formatNumber(jobState.completedRows)} / ${formatNumber(jobState.totalRows)} rows`
      : "awaiting row scan";
  const progressStage = humanizeStage(jobState?.stage);
  const activeUpscaleIndex = Math.max(
    0,
    upscaleOptions.findIndex((value) => value === options.upscale),
  );

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
                  <label className="glass-dropzone micro-interactive-surface flex min-h-[188px] cursor-pointer flex-col justify-between gap-4 p-4.5 transition">
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
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span className="glass-value-pill glass-upload-chip micro-pill inline-flex max-w-full items-center px-4.5 py-2.5 text-sm font-semibold text-stone-900">
                        <span className="max-w-[13.5rem] truncate sm:max-w-[16rem]">
                          {file ? file.name : "Select image"}
                        </span>
                      </span>
                      {file ? (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            clearSelectedImage();
                          }}
                          className="glass-value-pill glass-upload-remove micro-pill inline-flex items-center px-4 py-2.5 text-sm font-semibold text-stone-800"
                        >
                          Remove image
                        </button>
                      ) : null}
                    </div>
                  </label>
                </div>

                <div className="micro-card-reveal space-y-2.5" style={{ "--micro-delay": "150ms" }}>
                  <GenerateMosaicButton
                    disabled={isGenerating}
                    busy={isGenerating}
                    className="h-11.5 w-full px-6 text-sm font-semibold tracking-[-0.03em] text-stone-950 transition disabled:cursor-not-allowed disabled:opacity-70"
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
                      <input
                        type="range"
                        min={control.min}
                        max={control.max}
                        step={control.step}
                        value={options[control.id]}
                        style={{
                          "--slider-progress": `${getSliderProgress(
                            options[control.id],
                            control.min,
                            control.max,
                          )}%`,
                        }}
                        onChange={(event) =>
                          updateOption(
                            control.id,
                            control.step < 1
                              ? Number(event.target.value)
                              : parseInt(event.target.value, 10),
                          )
                        }
                        className="glass-slider mt-3 h-2 w-full cursor-pointer appearance-none rounded-full"
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

        <section className="grid gap-6 lg:grid-cols-2">
          <article
            data-background-static-zone
            className="micro-card-reveal overflow-hidden rounded-[28px] border border-white/28 bg-white/[0.03] shadow-[0_14px_36px_rgba(42,32,19,0.03)]"
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
              <div className="micro-preview-frame flex aspect-[4/5] items-center justify-center overflow-hidden rounded-[22px] border border-white/20 bg-white/[0.02]">
                {sourceUrl ? (
                  <img
                    src={sourceUrl}
                    alt="Uploaded portrait preview"
                    className="micro-image-reveal h-full w-full object-cover"
                  />
                ) : (
                  <p className="max-w-sm px-6 text-center text-sm leading-7 text-stone-600">
                    Upload a portrait to preview the input before the MNIST matching starts.
                  </p>
                )}
              </div>

              {hasSourceTelemetry ? (
                <div className="mt-5 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold uppercase tracking-[0.22em] text-stone-500">
                      Source Telemetry
                    </p>
                    <p className="text-xs font-medium text-stone-500">
                      Live from the uploaded frame
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {sourceTelemetry.map((card, index) => (
                      <div
                        key={card.label}
                        className="micro-telemetry-card micro-card-reveal rounded-3xl border border-white/20 bg-white/[0.03] px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]"
                        style={{ "--micro-delay": `${480 + (index * 55)}ms` }}
                      >
                        <p className="text-sm font-medium uppercase tracking-[0.18em] text-stone-500">
                          {card.label}
                        </p>
                        <p className="mt-2 text-xl font-semibold tracking-[-0.03em] text-stone-950">
                          {card.value}
                        </p>
                        <p className="mt-2 text-sm leading-6 text-stone-600">
                          {card.detail}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </article>

          <article
            data-background-static-zone
            className="micro-card-reveal overflow-hidden rounded-[28px] border border-white/28 bg-white/[0.03] shadow-[0_14px_36px_rgba(42,32,19,0.03)]"
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
                    className="micro-download-chip rounded-full bg-stone-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-stone-800"
                  >
                    Download PNG
                  </a>
                ) : null}
              </div>
            </div>

            <div className="space-y-5 p-5 sm:p-6">
              <AnimatePresence initial={false}>
                {isGenerating ? (
                  <motion.div
                    initial={{ opacity: 0, y: 10, scale: 0.985 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8, scale: 0.985 }}
                    transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                    className="glass-block glass-progress-panel p-3.5"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-stone-500">
                        Fabrication Progress
                      </p>
                      <p className="text-sm font-semibold text-stone-950">{progressValue}%</p>
                    </div>
                    <div className="micro-progress-shell mt-3 h-3 overflow-hidden rounded-full bg-black/[0.08] shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]">
                      <div
                        className="micro-progress-fill h-full rounded-full bg-[linear-gradient(90deg,rgba(255,255,255,0.96),rgba(220,231,243,0.92),rgba(249,229,207,0.94))] shadow-[0_0_18px_rgba(255,255,255,0.42)] transition-[width] duration-300 ease-out"
                        style={{ width: `${progressValue}%` }}
                      />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm">
                      <div>
                        <p className="font-semibold text-stone-950">{progressStage}</p>
                        <p className="text-stone-600">
                          {jobState?.message || "Waiting for backend telemetry"}
                        </p>
                      </div>
                      <div className="text-right text-stone-600">
                        <p>{progressRows}</p>
                        <p className="text-xs uppercase tracking-[0.16em] text-stone-400">
                          live backend trace
                        </p>
                      </div>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>

              <div className="micro-preview-frame flex aspect-[4/5] items-center justify-center overflow-hidden rounded-[22px] border border-white/20 bg-white/[0.02]">
                {resultUrl ? (
                  <img
                    src={resultUrl}
                    alt="MNIST photomosaic output"
                    className="micro-image-reveal h-full w-full object-cover"
                  />
                ) : (
                  <p className="max-w-sm px-6 text-center text-sm leading-7 text-stone-600">
                    {isGenerating
                      ? "The rendered mosaic will appear here as soon as glyph matching completes."
                      : "Your finished mosaic will appear here as soon as the backend returns the rendered PNG."}
                  </p>
                )}
              </div>

              {hasTelemetry ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold uppercase tracking-[0.22em] text-stone-500">
                      Mosaic Telemetry
                    </p>
                    <p className="text-xs font-medium text-stone-500">
                      Generated from live backend metadata
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {telemetryCards.map((card, index) => (
                      <div
                        key={card.label}
                        className="micro-telemetry-card micro-card-reveal rounded-3xl border border-white/20 bg-white/[0.03] px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]"
                        style={{ "--micro-delay": `${560 + (index * 55)}ms` }}
                      >
                        <p className="text-sm font-medium uppercase tracking-[0.18em] text-stone-500">
                          {card.label}
                        </p>
                        <p className="mt-2 text-xl font-semibold tracking-[-0.03em] text-stone-950">
                          {card.value}
                        </p>
                        <p className="mt-2 text-sm leading-6 text-stone-600">
                          {card.detail}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}
