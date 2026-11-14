// lalala.talk's host (src/main.tsx): the canvas with the page's own cards, in this browser only.
import "./site.css";
import "../voice/extrasImages";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import Landing from "./Landing";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Landing />
  </StrictMode>,
);
