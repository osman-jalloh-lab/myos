"use client";

import React from "react";

export default function GlobalError({ error, reset }: { error?: Error; reset?: () => void }) {
  return (
    <div style={{ padding: 40, fontFamily: "Arial, sans-serif" }}>
      <h1>Something went wrong</h1>
      <p>An unexpected error occurred while rendering the page.</p>
      {error && (
        <pre style={{ whiteSpace: "pre-wrap", background: "#f5f5f5", padding: 12 }}>{String(error?.message ?? "")}</pre>
      )}
      {typeof reset === "function" && (
        <button onClick={reset} style={{ marginTop: 12 }}>Try again</button>
      )}
    </div>
  );
}
