import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import App from "./App";
import "./styles.css";

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Editor render failed", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="center-message center-message--error">
          <div>
            <strong>에디터를 표시하지 못했습니다.</strong>
            <pre>{this.state.error.message}</pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// HocuspocusProvider opens a WebSocket during construction. React StrictMode's
// development-only double mount would create an extra provider/socket, which
// can race the live Yjs document. Keep the root single-mounted instead.
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
