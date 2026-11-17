import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app";
import { ThemeProvider, applyStoredTheme } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/styles/globals.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("index.html has no #root");

// Before the first render, so a dark-mode visit doesn't flash white.
applyStoredTheme();

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
