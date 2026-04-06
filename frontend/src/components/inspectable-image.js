"use client";
/* eslint-disable @next/next/no-img-element */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export default function InspectableImage({
  src,
  alt,
  title,
  previewLabel = "Click to preview",
  className = "",
  imageClassName = "",
}) {
  const prefersReducedMotion = useReducedMotion();
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  if (!src) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className={`image-inspector-trigger group relative h-full w-full ${className}`}
        aria-label={`${title}: open image preview`}
      >
        <img
          src={src}
          alt={alt}
          className={`micro-image-reveal h-full w-full object-cover ${imageClassName}`}
          draggable="false"
        />
        <span className="image-inspector-trigger-chip">Preview</span>
        <span className="image-inspector-trigger-copy">{previewLabel}</span>
      </button>

      {isOpen && typeof document !== "undefined"
        ? createPortal(
          <AnimatePresence>
            <motion.div
              className="image-inspector-backdrop"
              initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              onClick={() => setIsOpen(false)}
            >
              <motion.div
                className="image-inspector-dialog"
                role="dialog"
                aria-modal="true"
                aria-label={`${title} preview`}
                initial={
                  prefersReducedMotion
                    ? { opacity: 1 }
                    : { opacity: 0, y: 18, scale: 0.985 }
                }
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={
                  prefersReducedMotion
                    ? { opacity: 0 }
                    : { opacity: 0, y: 12, scale: 0.985 }
                }
                transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                onClick={(event) => event.stopPropagation()}
              >
                <img
                  src={src}
                  alt={alt}
                  className="image-inspector-image"
                  draggable="false"
                />
              </motion.div>
            </motion.div>
          </AnimatePresence>,
          document.body,
        )
        : null}
    </>
  );
}
