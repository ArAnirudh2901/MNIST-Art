"use client";

import { useEffect, useRef } from "react";

const ACTIVE_FRAME_INTERVAL_MS = 1000 / 60;
const IDLE_FRAME_INTERVAL_MS = 1000 / 30;
const MAX_DPR = 1.5;

const VERTEX_SHADER_SOURCE = `
attribute vec2 aPosition;
varying vec2 vUv;

void main() {
  vUv = vec2(aPosition.x * 0.5 + 0.5, 1.0 - (aPosition.y * 0.5 + 0.5));
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER_SOURCE = `
precision mediump float;

varying vec2 vUv;

uniform sampler2D uSource;
uniform vec2 uViewport;
uniform vec2 uRectOrigin;
uniform vec2 uRectSize;
uniform vec2 uSourceResolution;
uniform vec2 uHover;
uniform float uHoverStrength;
uniform float uTime;

float squircleField(vec2 localPx, vec2 radii) {
  vec2 q = abs(localPx / max(radii, vec2(1.0)));
  return pow(pow(q.x, 4.0) + pow(q.y, 4.0), 0.25);
}

vec2 squircleNormal(vec2 localPx, vec2 radii) {
  vec2 q = localPx / max(radii, vec2(1.0));
  vec2 gradient = vec2(
    4.0 * sign(q.x) * pow(abs(q.x), 3.0) / max(radii.x, 1.0),
    4.0 * sign(q.y) * pow(abs(q.y), 3.0) / max(radii.y, 1.0)
  );
  float gradientLength = max(length(gradient), 0.0001);
  return gradient / gradientLength;
}

vec4 sampleRefracted(vec2 uv, vec2 normal, float edgeFactor) {
  vec2 texel = 1.0 / max(uSourceResolution, vec2(1.0));
  vec2 spread = normal * texel * (1.6 + (edgeFactor * 8.0));
  vec4 base = texture2D(uSource, clamp(uv, 0.0, 1.0));
  vec4 ahead = texture2D(uSource, clamp(uv + spread, 0.0, 1.0));
  vec4 behind = texture2D(uSource, clamp(uv - (spread * 0.55), 0.0, 1.0));
  return (base * 0.64) + (ahead * 0.22) + (behind * 0.14);
}

void main() {
  vec2 localPx = (vUv - 0.5) * uRectSize;
  vec2 radii = max((uRectSize * 0.5) - vec2(12.0), vec2(12.0));
  float squircle = squircleField(localPx, radii);
  float mask = 1.0 - smoothstep(0.996, 1.018, squircle);

  if (mask <= 0.001) {
    discard;
  }

  vec2 normal = squircleNormal(localPx, radii);
  float edgeFactor = smoothstep(0.58, 1.0, squircle);
  float coreFactor = 1.0 - smoothstep(0.0, 0.92, squircle);

  vec2 baseUv = (uRectOrigin + (vUv * uRectSize)) / max(uViewport, vec2(1.0));
  vec2 lens = (vUv - 0.5) * (-0.012 * coreFactor);
  vec2 rimBend = normal * (0.006 + (edgeFactor * edgeFactor * 0.02));

  float hoverDistance = distance(vUv, uHover);
  float hoverGlow = exp(-(hoverDistance * hoverDistance) * 18.0) * uHoverStrength;
  vec2 hoverDirection = normalize((vUv - uHover) + vec2(0.0001));
  vec2 hoverBend = hoverDirection * hoverGlow * 0.0035;

  vec2 refractedUv = clamp(baseUv + lens + rimBend + hoverBend, 0.0, 1.0);
  vec4 refracted = sampleRefracted(refractedUv, normal, edgeFactor);

  vec3 glass = refracted.rgb;
  glass = mix(glass, vec3(1.0), 0.018 + (edgeFactor * 0.028));

  float fresnel = pow(edgeFactor, 1.35);
  float rimLight = fresnel * (0.09 + (0.11 * (1.0 - vUv.y)));
  float topGlow = smoothstep(0.32, 0.0, vUv.y) * (0.045 + (coreFactor * 0.022));
  float hoverSpecular = hoverGlow * (0.045 + (0.06 * (1.0 - edgeFactor)));
  float sweep = exp(
    -(pow(vUv.x - (0.18 + (sin(uTime * 0.35) * 0.05)), 2.0) * 42.0)
    -(pow(vUv.y - 0.13, 2.0) * 360.0)
  ) * 0.08;
  vec3 highlights = vec3(rimLight + topGlow + hoverSpecular + sweep);

  vec3 shaded = glass + highlights + vec3(0.008 + (coreFactor * 0.008));

  float alpha = 0.11 + (edgeFactor * 0.08) + (hoverGlow * 0.02);
  gl_FragColor = vec4(clamp(shaded, 0.0, 1.0), alpha * mask);
}
`;

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Unable to allocate WebGL shader.");
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(shader) || "Unknown shader compile failure.";
    gl.deleteShader(shader);
    throw new Error(error);
  }

  return shader;
}

function createProgram(gl) {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
  const program = gl.createProgram();

  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error("Unable to allocate WebGL program.");
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const error = gl.getProgramInfoLog(program) || "Unknown program link failure.";
    gl.deleteProgram(program);
    throw new Error(error);
  }

  return program;
}

function getSourceCanvas() {
  const node = document.querySelector("[data-mnist-background-source]");
  return node instanceof HTMLCanvasElement ? node : null;
}

export default function LiquidGlassPanel({
  as: Component = "div",
  children,
  className = "",
  ...props
}) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) {
      return undefined;
    }

    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: true,
      depth: false,
      stencil: false,
      desynchronized: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });

    if (!gl) {
      return undefined;
    }

    let program;
    try {
      program = createProgram(gl);
    } catch (error) {
      console.error("Liquid glass shader failed to initialize.", error);
      return undefined;
    }

    const positionAttribute = gl.getAttribLocation(program, "aPosition");
    const sourceUniform = gl.getUniformLocation(program, "uSource");
    const viewportUniform = gl.getUniformLocation(program, "uViewport");
    const rectOriginUniform = gl.getUniformLocation(program, "uRectOrigin");
    const rectSizeUniform = gl.getUniformLocation(program, "uRectSize");
    const sourceResolutionUniform = gl.getUniformLocation(program, "uSourceResolution");
    const hoverUniform = gl.getUniformLocation(program, "uHover");
    const hoverStrengthUniform = gl.getUniformLocation(program, "uHoverStrength");
    const timeUniform = gl.getUniformLocation(program, "uTime");

    const quadBuffer = gl.createBuffer();
    const texture = gl.createTexture();

    if (!quadBuffer || !texture) {
      gl.deleteProgram(program);
      return undefined;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.useProgram(program);
    gl.enableVertexAttribArray(positionAttribute);
    gl.vertexAttribPointer(positionAttribute, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(sourceUniform, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const state = {
      dpr: 1,
      rect: container.getBoundingClientRect(),
      hoverX: 0.26,
      hoverY: 0.18,
      hoverTargetX: 0.26,
      hoverTargetY: 0.18,
      hoverStrength: 0,
      hoverTargetStrength: 0,
      lastFrameTime: 0,
    };

    let frameId = 0;

    function resize() {
      state.rect = container.getBoundingClientRect();
      state.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

      const nextWidth = Math.max(1, Math.round(state.rect.width * state.dpr));
      const nextHeight = Math.max(1, Math.round(state.rect.height * state.dpr));
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth;
        canvas.height = nextHeight;
        canvas.style.width = `${state.rect.width}px`;
        canvas.style.height = `${state.rect.height}px`;
      }

      gl.viewport(0, 0, canvas.width, canvas.height);
    }

    function handlePointerMove(event) {
      state.rect = container.getBoundingClientRect();
      state.hoverTargetX = (event.clientX - state.rect.left) / Math.max(state.rect.width, 1);
      state.hoverTargetY = (event.clientY - state.rect.top) / Math.max(state.rect.height, 1);
      state.hoverTargetStrength = 1;
    }

    function handlePointerLeave() {
      state.hoverTargetStrength = 0;
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    container.addEventListener("pointermove", handlePointerMove, { passive: true });
    container.addEventListener("pointerleave", handlePointerLeave);
    window.addEventListener("resize", resize);

    function render(now) {
      const frameInterval =
        state.hoverStrength > 0.02 ? ACTIVE_FRAME_INTERVAL_MS : IDLE_FRAME_INTERVAL_MS;

      if (state.lastFrameTime && now - state.lastFrameTime < frameInterval) {
        frameId = window.requestAnimationFrame(render);
        return;
      }

      const delta = state.lastFrameTime ? now - state.lastFrameTime : frameInterval;
      state.lastFrameTime = now;
      state.rect = container.getBoundingClientRect();

      const nextWidth = Math.max(1, Math.round(state.rect.width * state.dpr));
      const nextHeight = Math.max(1, Math.round(state.rect.height * state.dpr));
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        resize();
      }

      const hoverEase = 1 - Math.exp(-delta / 180);
      const positionEase = 1 - Math.exp(-delta / 140);
      state.hoverStrength +=
        (state.hoverTargetStrength - state.hoverStrength) * hoverEase;
      state.hoverX += (state.hoverTargetX - state.hoverX) * positionEase;
      state.hoverY += (state.hoverTargetY - state.hoverY) * positionEase;

      const sourceCanvas = getSourceCanvas();
      if (!sourceCanvas || sourceCanvas.width === 0 || sourceCanvas.height === 0) {
        frameId = window.requestAnimationFrame(render);
        return;
      }

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);

      gl.useProgram(program);
      gl.uniform2f(viewportUniform, window.innerWidth, window.innerHeight);
      gl.uniform2f(rectOriginUniform, state.rect.left, state.rect.top);
      gl.uniform2f(rectSizeUniform, state.rect.width, state.rect.height);
      gl.uniform2f(sourceResolutionUniform, sourceCanvas.width, sourceCanvas.height);
      gl.uniform2f(hoverUniform, state.hoverX, state.hoverY);
      gl.uniform1f(hoverStrengthUniform, state.hoverStrength);
      gl.uniform1f(timeUniform, now * 0.001);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      frameId = window.requestAnimationFrame(render);
    }

    resize();
    frameId = window.requestAnimationFrame(render);

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      container.removeEventListener("pointermove", handlePointerMove);
      container.removeEventListener("pointerleave", handlePointerLeave);
      window.removeEventListener("resize", resize);

      gl.deleteTexture(texture);
      gl.deleteBuffer(quadBuffer);
      gl.deleteProgram(program);
    };
  }, []);

  return (
    <Component ref={containerRef} className={className} {...props}>
      <div aria-hidden="true" className="liquid-glass-base" />
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="liquid-glass-canvas"
      />
      <div aria-hidden="true" className="liquid-glass-rim" />
      <div aria-hidden="true" className="liquid-glass-sheen" />
      <div aria-hidden="true" className="liquid-glass-shadow" />
      <div className="liquid-glass-content">{children}</div>
    </Component>
  );
}
