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
      icons={{
        loading: <span aria-hidden="true" className="sonner-inline-spinner" />,
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: "sonner-toast",
          loader: "sonner-toast-loader",
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
