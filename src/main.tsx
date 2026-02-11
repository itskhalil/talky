import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { RecordingPill } from "./components/RecordingPill";

// Initialize i18n
import "./i18n";

// Initialize model store (loads models and sets up event listeners)
import { useModelStore } from "./stores/modelStore";
useModelStore.getState().initialize();

const isPill = window.location.hash === "#/pill";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isPill ? <RecordingPill /> : <App />}</React.StrictMode>,
);
