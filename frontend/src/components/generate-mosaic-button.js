"use client";

import {
  AnimatePresence,
  motion,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useSpring,
} from "framer-motion";

const buttonSpring = {
  type: "spring",
  stiffness: 320,
  damping: 28,
  mass: 0.56,
};

export default function GenerateMosaicButton({
  busy = false,
  disabled = false,
  className = "",
}) {
  const prefersReducedMotion = useReducedMotion();
  const pointerX = useMotionValue(50);
  const pointerY = useMotionValue(50);
  const smoothX = useSpring(pointerX, { stiffness: 260, damping: 28, mass: 0.45 });
  const smoothY = useSpring(pointerY, { stiffness: 260, damping: 28, mass: 0.45 });

  const interactionLayer = useMotionTemplate`
    radial-gradient(
      circle at ${smoothX}% ${smoothY}%,
      rgba(255, 255, 255, 0.28),
      rgba(255, 255, 255, 0.12) 18%,
      rgba(255, 255, 255, 0.04) 34%,
      transparent 64%
    )
  `;

  function handlePointerMove(event) {
    if (prefersReducedMotion || disabled) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const nextX = ((event.clientX - rect.left) / rect.width) * 100;
    const nextY = ((event.clientY - rect.top) / rect.height) * 100;

    pointerX.set(Math.max(0, Math.min(100, nextX)));
    pointerY.set(Math.max(0, Math.min(100, nextY)));
  }

  function resetPointer() {
    pointerX.set(50);
    pointerY.set(50);
  }

  return (
    <motion.button
      type="submit"
      disabled={disabled}
      aria-busy={busy}
      onPointerMove={handlePointerMove}
      onPointerLeave={resetPointer}
      whileHover={
        !prefersReducedMotion && !disabled
          ? { y: -1.5, scale: 1.006 }
          : undefined
      }
      whileTap={
        !prefersReducedMotion && !disabled
          ? { y: 0.5, scale: 0.992 }
          : undefined
      }
      transition={buttonSpring}
      className={`glass-cta glass-cta-dark micro-cta relative isolate inline-flex overflow-hidden ${busy ? "is-busy" : ""} ${className}`}
    >
      <motion.span
        aria-hidden="true"
        className="glass-cta-interaction-layer"
        style={{ backgroundImage: interactionLayer }}
      />
      <motion.span
        aria-hidden="true"
        className="glass-cta-ambient-layer"
        animate={
          busy && !prefersReducedMotion
            ? { x: ["-8%", "9%", "-8%"] }
            : { x: "0%" }
        }
        transition={{
          duration: 3.2,
          ease: "easeInOut",
          repeat: busy && !prefersReducedMotion ? Infinity : 0,
        }}
      />
      <motion.span
        aria-hidden="true"
        className="glass-cta-sheen"
        animate={
          !prefersReducedMotion && !busy && !disabled
            ? { x: ["-165%", "180%"], opacity: [0, 0.86, 0] }
            : { x: "0%", opacity: 0 }
        }
        transition={{
          duration: 2.7,
          ease: [0.22, 1, 0.36, 1],
          repeat: !prefersReducedMotion && !busy && !disabled ? Infinity : 0,
          repeatDelay: 1.8,
        }}
      />
      <span aria-hidden="true" className="glass-cta-rim-layer" />

      <AnimatePresence initial={false} mode="wait">
        <motion.span
          key={busy ? "busy" : "idle"}
          initial={
            prefersReducedMotion
              ? { opacity: 1 }
              : { opacity: 0, y: 7, filter: "blur(6px)" }
          }
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={
            prefersReducedMotion
              ? { opacity: 0 }
              : { opacity: 0, y: -6, filter: "blur(5px)" }
          }
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          className="glass-cta-content"
        >
          {busy ? (
            <>
              <span className="glass-cta-loader" aria-hidden="true">
                {[0, 1, 2].map((index) => (
                  <motion.span
                    key={index}
                    className="glass-cta-loader-dot"
                    animate={
                      prefersReducedMotion
                        ? { opacity: 0.72 }
                        : { y: [0, -3.5, 0], opacity: [0.52, 1, 0.52] }
                    }
                    transition={{
                      duration: 0.88,
                      ease: "easeInOut",
                      repeat: Infinity,
                      delay: index * 0.12,
                    }}
                  />
                ))}
              </span>
              <span>Generating mosaic...</span>
            </>
          ) : (
            <>
              <span>Generate mosaic</span>
              <motion.span
                aria-hidden="true"
                className="glass-cta-arrow"
                animate={
                  prefersReducedMotion
                    ? { x: 0 }
                    : { x: [0, 1.5, 0] }
                }
                transition={{
                  duration: 1.9,
                  ease: "easeInOut",
                  repeat: Infinity,
                  repeatDelay: 0.3,
                }}
              >
                →
              </motion.span>
            </>
          )}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}
