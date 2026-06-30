import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { QueryClientWrapper } from "./components/QueryClientProvider";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientWrapper>
      <App />
    </QueryClientWrapper>
  </StrictMode>,
);
