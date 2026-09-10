import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

// Inter, because `--rt-font-ui` in tokens.css names it first. It was declared
// without ever being bundled, so on a machine that did not happen to have it
// installed the whole Theme C console silently fell back to Segoe UI. Bundling
// it is what makes the token tell the truth. See context.md §5.1 and §5.1.4.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";

import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/chunk-view.css";
import App from "./App";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element.");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
