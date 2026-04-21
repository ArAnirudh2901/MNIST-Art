"use client";

import {
  AnimatePresence,
  motion,
  useReducedMotion,
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
  onClick,
}) {
  const prefersReducedMotion = useReducedMotion();

  return (
    <motion.button
      type={onClick ? "button" : "submit"}
      disabled={disabled}
      aria-busy={busy}
      onClick={onClick}
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
            <span className="glass-cta-busy-layout">
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
            </span>
          ) : (
            <span className="glass-cta-idle-layout">
              <span aria-hidden="true" className="glass-cta-side-slot" />
              <span className="glass-cta-label">Generate mosaic</span>
              <span
                aria-hidden="true"
                className="glass-cta-side-slot glass-cta-arrow-slot"
              >
                <motion.span
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
              </span>
            </span>
          )}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}
