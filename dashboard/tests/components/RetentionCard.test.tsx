import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RetentionCard } from "../../src/components/RetentionCard";
import * as api from "../../src/lib/api";

jest.mock("../../src/lib/api", () => ({
  ...jest.requireActual("../../src/lib/api"),
  fetchRetentionSettings: jest.fn(),
  updateRetentionSettings: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  (api.fetchRetentionSettings as jest.Mock).mockResolvedValue({
    maxAgeDays: null,
    maxTotalBytes: null,
    maxJobs: null,
    totalArtifactBytes: 2 * 1024 * 1024,
  });
});

test("loads and displays current settings and disk usage", async () => {
  render(<RetentionCard />);
  expect(await screen.findByText(/2\.0 MB/)).toBeInTheDocument();
  expect(screen.getByLabelText(/max age/i)).toHaveValue("");
});

test("saving calls updateRetentionSettings with the entered values", async () => {
  (api.updateRetentionSettings as jest.Mock).mockResolvedValue({
    maxAgeDays: 30,
    maxTotalBytes: null,
    maxJobs: null,
    totalArtifactBytes: 2 * 1024 * 1024,
  });
  render(<RetentionCard />);
  await screen.findByText(/2\.0 MB/);

  fireEvent.change(screen.getByLabelText(/max age/i), { target: { value: "30" } });
  fireEvent.click(screen.getByRole("button", { name: /save/i }));

  await waitFor(() =>
    expect(api.updateRetentionSettings).toHaveBeenCalledWith({ maxAgeDays: 30, maxTotalBytes: null, maxJobs: null })
  );
  expect(await screen.findByText(/saved/i)).toBeInTheDocument();
});

test("an empty field means disabled (null), not zero", async () => {
  (api.updateRetentionSettings as jest.Mock).mockResolvedValue({
    maxAgeDays: null,
    maxTotalBytes: null,
    maxJobs: null,
    totalArtifactBytes: 0,
  });
  render(<RetentionCard />);
  await screen.findByText(/2\.0 MB/);

  fireEvent.click(screen.getByRole("button", { name: /save/i }));

  await waitFor(() =>
    expect(api.updateRetentionSettings).toHaveBeenCalledWith({ maxAgeDays: null, maxTotalBytes: null, maxJobs: null })
  );
});

test("a negative value shows a validation error instead of saving", async () => {
  render(<RetentionCard />);
  await screen.findByText(/2\.0 MB/);

  fireEvent.change(screen.getByLabelText(/max age/i), { target: { value: "-1" } });
  fireEvent.click(screen.getByRole("button", { name: /save/i }));

  expect(await screen.findByText(/non-negative whole number/i)).toBeInTheDocument();
  expect(api.updateRetentionSettings).not.toHaveBeenCalled();
});

test("shows an error instead of a stuck Loading state when the initial load fails", async () => {
  (api.fetchRetentionSettings as jest.Mock).mockRejectedValue(new Error("network down"));
  render(<RetentionCard />);

  expect(await screen.findByText(/failed to load retention settings/i)).toBeInTheDocument();
  expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
});
