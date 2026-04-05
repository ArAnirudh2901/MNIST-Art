import { Geist_Mono, Inter } from "next/font/google";

import AppToaster from "@/components/app-toaster";
import "./globals.css";

const appSans = Inter({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "MNIST Mosaic Studio",
  description:
    "Upload a portrait and render it as a high-resolution photomosaic built from MNIST digits.",
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`${appSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <AppToaster />
      </body>
    </html>
  );
}
