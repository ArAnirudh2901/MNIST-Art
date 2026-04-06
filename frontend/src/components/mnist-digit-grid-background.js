"use client";

import { useEffect, useRef } from "react";

const SPRITE_TILE_SIZE = 28;
const SPRITE_COLUMNS = 24;
const SPRITE_COUNT = 480;
const POINTER_RADIUS = 118;
const SHOCK_MIN_DURATION_MS = 1200;
const SHOCK_SPEED = 480;
const SHOCK_WIDTH = 52;
const SHOCK_STRENGTH = 15;
const SHOCK_RADIUS_MIN = 120;
const SHOCK_RADIUS_MAX = 200;
const SHOCK_RADIUS_VIEWPORT_FACTOR = 0.13;
const ACTIVE_FRAME_INTERVAL_MS = 1000 / 60;
const IDLE_FRAME_INTERVAL_MS = 1000 / 12;
const MAX_DPR = 1.5;
const MOBILE_GRID_GAP = 24;
const DESKTOP_GRID_GAP = 30;
const MOBILE_BASE_SIZE = 9;
const DESKTOP_BASE_SIZE = 11;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(value) {
  return value * value * (3 - (2 * value));
}

function spriteIndexForCell(row, column) {
  return (
    (row * 37 + column * 17 + (((row + 3) * (column + 5)) % 67)) % SPRITE_COUNT
  );
}

function isStaticZoneTarget(target) {
  return (
    typeof Element !== "undefined" &&
    target instanceof Element &&
    Boolean(target.closest("[data-background-static-zone]"))
  );
}

export default function MnistDigitGridBackground() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }

    const context = canvas.getContext("2d", {
      alpha: true,
      desynchronized: true,
    });
    if (!context) {
      return undefined;
    }

    const state = {
      width: 0,
      height: 0,
      dpr: 1,
      cells: [],
      sprite: null,
      pointer: {
        x: -9999,
        y: -9999,
        targetX: -9999,
        targetY: -9999,
        vx: 0,
        vy: 0,
        targetVx: 0,
        targetVy: 0,
        lastX: -9999,
        lastY: -9999,
        lastTime: 0,
        engagement: 0,
        targetEngagement: 0,
        active: false,
      },
      shocks: [],
      lastFrameTime: 0,
    };

    let frameId = 0;

    function buildGrid() {
      const gap = state.width < 640 ? MOBILE_GRID_GAP : DESKTOP_GRID_GAP;
      const margin = gap;
      const baseSize = state.width < 640 ? MOBILE_BASE_SIZE : DESKTOP_BASE_SIZE;
      const cells = [];
      let row = 0;

      for (let y = margin; y < state.height + margin; y += gap) {
        let column = 0;
        for (let x = margin; x < state.width + margin; x += gap) {
          const spriteIndex = spriteIndexForCell(row, column);
          cells.push({
            x,
            y,
            row,
            column,
            spriteIndex,
            baseSize,
            phase: ((row * 11) + (column * 7)) * 0.17,
            sourceX: (spriteIndex % SPRITE_COLUMNS) * SPRITE_TILE_SIZE,
            sourceY: Math.floor(spriteIndex / SPRITE_COLUMNS) * SPRITE_TILE_SIZE,
          });
          column += 1;
        }
        row += 1;
      }

      state.cells = cells;
    }

    function resize() {
      state.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      state.width = window.innerWidth;
      state.height = window.innerHeight;

      canvas.width = Math.round(state.width * state.dpr);
      canvas.height = Math.round(state.height * state.dpr);
      canvas.style.width = `${state.width}px`;
      canvas.style.height = `${state.height}px`;
      context.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

      buildGrid();
    }

    function updatePointerVelocity(event, now) {
      let nextVx = 0;
      let nextVy = 0;

      if (!state.pointer.active || state.pointer.x < -9000) {
        state.pointer.x = event.clientX;
        state.pointer.y = event.clientY;
        state.pointer.vx = 0;
        state.pointer.vy = 0;
        state.pointer.targetVx = 0;
        state.pointer.targetVy = 0;
      } else {
        const dt = Math.max(16, now - (state.pointer.lastTime || now));
        nextVx =
          ((event.clientX - state.pointer.lastX) / dt) * 11 || state.pointer.vx;
        nextVy =
          ((event.clientY - state.pointer.lastY) / dt) * 11 || state.pointer.vy;
      }

      return { nextVx, nextVy };
    }

    function handoffPointerToStaticZone(event) {
      const now = performance.now();
      const { nextVx, nextVy } = updatePointerVelocity(event, now);

      state.pointer.targetX = event.clientX;
      state.pointer.targetY = event.clientY;
      state.pointer.targetVx = nextVx * 0.22;
      state.pointer.targetVy = nextVy * 0.22;
      state.pointer.lastX = event.clientX;
      state.pointer.lastY = event.clientY;
      state.pointer.lastTime = now;
      state.pointer.targetEngagement = 0;
      state.pointer.active = false;
    }

    function handlePointerMove(event) {
      if (isStaticZoneTarget(event.target)) {
        handoffPointerToStaticZone(event);
        return;
      }

      const now = performance.now();
      const { nextVx, nextVy } = updatePointerVelocity(event, now);

      state.pointer.targetX = event.clientX;
      state.pointer.targetY = event.clientY;
      state.pointer.targetVx = nextVx;
      state.pointer.targetVy = nextVy;
      state.pointer.lastX = event.clientX;
      state.pointer.lastY = event.clientY;
      state.pointer.lastTime = now;
      state.pointer.targetEngagement = 1;
      state.pointer.active = true;
    }

    function handleViewportExit() {
      if (
        state.pointer.lastX < -9000 &&
        state.pointer.x < -9000 &&
        state.pointer.engagement <= 0.001
      ) {
        return;
      }

      const now = performance.now();
      const releaseX = state.pointer.lastX > -9000 ? state.pointer.lastX : state.pointer.x;
      const releaseY = state.pointer.lastY > -9000 ? state.pointer.lastY : state.pointer.y;

      state.pointer.targetX = releaseX;
      state.pointer.targetY = releaseY;
      state.pointer.targetVx = 0;
      state.pointer.targetVy = 0;
      state.pointer.lastX = releaseX;
      state.pointer.lastY = releaseY;
      state.pointer.lastTime = now;
      state.pointer.targetEngagement = 0;
      state.pointer.active = false;
    }

    function handlePointerBoundaryExit(event) {
      if (event.relatedTarget === null) {
        handleViewportExit(event);
      }
    }

    function handlePointerDown(event) {
      if (isStaticZoneTarget(event.target)) {
        return;
      }

      const localizedRadius = clamp(
        Math.min(state.width, state.height) * SHOCK_RADIUS_VIEWPORT_FACTOR,
        SHOCK_RADIUS_MIN,
        SHOCK_RADIUS_MAX,
      );
      const duration = Math.max(
        SHOCK_MIN_DURATION_MS,
        ((localizedRadius + SHOCK_WIDTH) / SHOCK_SPEED) * 1000,
      );

      state.shocks.push({
        x: event.clientX,
        y: event.clientY,
        start: performance.now(),
        duration,
        maxRadius: localizedRadius,
      });
    }

    function render(now) {
      const isInteractive =
        state.pointer.active || state.pointer.engagement > 0.01 || state.shocks.length > 0;
      const frameInterval = isInteractive
        ? ACTIVE_FRAME_INTERVAL_MS
        : IDLE_FRAME_INTERVAL_MS;
      const delta = state.lastFrameTime ? now - state.lastFrameTime : frameInterval;

      if (now - state.lastFrameTime < frameInterval) {
        frameId = window.requestAnimationFrame(render);
        return;
      }

      state.lastFrameTime = now;

      // Smooth pointer state on the animation thread so glyph motion stays fluid.
      const positionEase = 1 - Math.exp(-delta / 54);
      const velocityEase = 1 - Math.exp(-delta / 94);
      const engagementEase = 1 - Math.exp(-delta / 240);

      state.pointer.x += (state.pointer.targetX - state.pointer.x) * positionEase;
      state.pointer.y += (state.pointer.targetY - state.pointer.y) * positionEase;
      state.pointer.vx += (state.pointer.targetVx - state.pointer.vx) * velocityEase;
      state.pointer.vy += (state.pointer.targetVy - state.pointer.vy) * velocityEase;
      state.pointer.engagement +=
        (state.pointer.targetEngagement - state.pointer.engagement) * engagementEase;

      if (!state.pointer.active) {
        state.pointer.vx *= 1 - (velocityEase * 0.65);
        state.pointer.vy *= 1 - (velocityEase * 0.65);
      }

      context.clearRect(0, 0, state.width, state.height);

      state.shocks = state.shocks.filter(
        (shock) => now - shock.start < shock.duration,
      );

      if (!state.sprite) {
        frameId = window.requestAnimationFrame(render);
        return;
      }

      for (const cell of state.cells) {
        let hover = 0;
        if (state.pointer.engagement > 0.001) {
          const dx = state.pointer.x - cell.x;
          const dy = state.pointer.y - cell.y;
          const distance = Math.hypot(dx, dy);
          hover =
            smoothstep(clamp(1 - distance / POINTER_RADIUS, 0, 1)) *
            state.pointer.engagement;
        }

        let offsetX = Math.sin((now * 0.0005) + cell.phase) * 0.5;
        let offsetY = Math.cos((now * 0.00045) + cell.phase) * 0.5;
        let shockInfluence = 0;

        if (hover > 0) {
          offsetX += state.pointer.vx * hover * 0.72;
          offsetY += state.pointer.vy * hover * 0.72;
        }

        for (const shock of state.shocks) {
          const age = now - shock.start;
          const progress = clamp(age / shock.duration, 0, 1);
          const radius = shock.maxRadius * progress;
          const sx = cell.x - shock.x;
          const sy = cell.y - shock.y;
          const shockDistance = Math.hypot(sx, sy);
          const ring = clamp(
            1 - Math.abs(shockDistance - radius) / SHOCK_WIDTH,
            0,
            1,
          );

          if (ring <= 0) {
            continue;
          }

          const decay = 1 - progress;
          const push = ring * decay * SHOCK_STRENGTH;
          const angle = Math.atan2(sy || 0.001, sx || 0.001);
          offsetX += Math.cos(angle) * push;
          offsetY += Math.sin(angle) * push;
          shockInfluence = Math.max(shockInfluence, ring * decay);
        }

        const emphasis = Math.max(hover, shockInfluence);
        const drawSize = cell.baseSize * (1 + (hover * 0.5) + (shockInfluence * 0.65));
        const alpha = 0.1 + (hover * 0.12) + (shockInfluence * 0.16);
        context.globalAlpha = alpha;
        if (emphasis > 0.12) {
          context.shadowColor = `rgba(215, 106, 47, ${0.12 + (emphasis * 0.28)})`;
          context.shadowBlur = 18 * emphasis;
        } else {
          context.shadowColor = "transparent";
          context.shadowBlur = 0;
        }
        context.drawImage(
          state.sprite,
          cell.sourceX,
          cell.sourceY,
          SPRITE_TILE_SIZE,
          SPRITE_TILE_SIZE,
          cell.x - (drawSize / 2) + offsetX,
          cell.y - (drawSize / 2) + offsetY,
          drawSize,
          drawSize,
        );
      }

      context.globalAlpha = 1;
      context.shadowColor = "transparent";
      context.shadowBlur = 0;

      frameId = window.requestAnimationFrame(render);
    }

    const sprite = new window.Image();
    sprite.decoding = "async";
    sprite.src = "/mnist-digit-sprite.png";
    sprite.onload = () => {
      state.sprite = sprite;
      resize();
      frameId = window.requestAnimationFrame(render);
    };

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("pointerdown", handlePointerDown, { passive: true });
    window.addEventListener("pointerleave", handleViewportExit);
    window.addEventListener("pointerout", handlePointerBoundaryExit);
    document.addEventListener("mouseleave", handleViewportExit);
    window.addEventListener("blur", handleViewportExit);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerleave", handleViewportExit);
      window.removeEventListener("pointerout", handlePointerBoundaryExit);
      document.removeEventListener("mouseleave", handleViewportExit);
      window.removeEventListener("blur", handleViewportExit);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      data-mnist-background-source
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 h-full w-full"
    />
  );
}
