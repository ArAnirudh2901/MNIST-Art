"use client";

import { motion, useReducedMotion } from "framer-motion";

export default function GlassSlider({
  id,
  min,
  max,
  step,
  value,
  onChange,
  className = "",
  disabled = false,
  ...props
}) {
  const prefersReducedMotion = useReducedMotion();
  const numericMin = Number(min);
  const numericMax = Number(max);
  const numericValue = Number(value);
  const progress =
    numericMax <= numericMin
      ? 0
      : Math.max(
        0,
        Math.min(100, ((numericValue - numericMin) / (numericMax - numericMin)) * 100),
      );

  const springTransition = prefersReducedMotion
    ? { duration: 0 }
    : { type: "spring", stiffness: 380, damping: 34, mass: 0.34 };

  return (
    <div className={`glass-slider-shell ${disabled ? "is-disabled" : ""} ${className}`}>
      <div aria-hidden="true" className="glass-slider-visual">
        <div className="glass-slider-track">
          <motion.div
            className="glass-slider-fill"
            animate={{ width: `${progress}%` }}
            transition={springTransition}
          />
        </div>
        <motion.div
          className="glass-slider-thumb"
          animate={{ left: `${progress}%` }}
          transition={springTransition}
        />
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={onChange}
        disabled={disabled}
        className="glass-slider-input"
        {...props}
      />
    </div>
  );
}
