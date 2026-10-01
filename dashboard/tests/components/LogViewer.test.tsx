import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LogViewer } from "../../src/components/LogViewer";
import { setActiveOrgId } from "../../src/lib/activeOrg";

beforeEach(() => {
  sessionStorage.clear();
});

test("shows the stdout preview immediately, fetches full log on request", async () => {
  const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "full stdout here" });
  render(<LogViewer stepId={7} preview="short preview" fetchImpl={fetchImpl} />);

  expect(screen.getByText("short preview")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /view full log/i }));

  await waitFor(() => expect(screen.getByText("full stdout here")).toBeInTheDocument());
  expect(fetchImpl).toHaveBeenCalledWith("/api/flow-runs/7/log?stream=stdout", expect.objectContaining({ credentials: "include" }));
});

test("shows log unavailable and re-enables the button when the fetch rejects", async () => {
  const fetchImpl = jest.fn().mockRejectedValue(new Error("network down"));
  render(<LogViewer stepId={7} preview="short preview" fetchImpl={fetchImpl} />);

  fireEvent.click(screen.getByRole("button", { name: /view full log/i }));

  await waitFor(() => expect(screen.getByText("log unavailable")).toBeInTheDocument());
  const button = screen.getByRole("button", { name: /view full log/i });
  expect(button).not.toBeDisabled();
});

test("with no fetchImpl provided, defaults to orgScopedFetch - the request carries X-Org-Id when an active org is set", async () => {
  setActiveOrgId(7);
  const originalFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "full stdout here" });
  try {
    render(<LogViewer stepId={7} preview="short preview" />);
    fireEvent.click(screen.getByRole("button", { name: /view full log/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(new Headers(init.headers).get("X-Org-Id")).toBe("7");
  } finally {
    global.fetch = originalFetch;
  }
});

test("switches stream via the stderr tab", async () => {
  const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "stderr text" });
  render(<LogViewer stepId={7} preview="preview" stderrPreview="stderr preview" fetchImpl={fetchImpl} />);

  fireEvent.click(screen.getByRole("button", { name: /^stderr$/i }));
  fireEvent.click(screen.getByRole("button", { name: /view full log/i }));

  await waitFor(() =>
    expect(fetchImpl).toHaveBeenCalledWith("/api/flow-runs/7/log?stream=stderr", expect.objectContaining({ credentials: "include" }))
  );
});
