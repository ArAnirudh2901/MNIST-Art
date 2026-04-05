"use client";

import { Toaster } from "sonner";

export default function AppToaster() {
  return (
    <Toaster
      position="top-center"
      expand
      richColors={false}
      visibleToasts={4}
      closeButton
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: "sonner-toast",
          title: "sonner-toast-title",
          description: "sonner-toast-description",
          closeButton: "sonner-toast-close",
          success: "sonner-toast-success",
          error: "sonner-toast-error",
          loading: "sonner-toast-loading",
        },
      }}
    />
  );
}
