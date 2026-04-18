"use client";

import { Toaster } from "@Poneglyph/ui/components/sonner";

import { ThemeProvider } from "./theme-provider";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      forcedTheme="light"
      disableTransitionOnChange
    >
      {children}
      <Toaster richColors />
    </ThemeProvider>
  );
}
