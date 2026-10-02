import { renderHook, act, waitFor } from "@testing-library/react";
import { usePolledJobs } from "../../src/lib/usePolledJobs";
import type { JobListEntry } from "../../src/lib/api";

jest.useFakeTimers();

const jobs: JobListEntry[] = [
  { id: "1", org: "donable", status: "done", error: null, createdAt: 0, startedAt: 0, finishedAt: 1, deviceId: null, appId: null, appVersion: null, flowCount: 3, passed: 3, failed: 0, running: 0 },
];

test("fetches immediately on mount", async () => {
  const fetchJobs = jest.fn().mockResolvedValue(jobs);
  const { result } = renderHook(() => usePolledJobs({ fetchJobs, intervalMs: 12000, isVisible: () => true }));

  await waitFor(() => expect(result.current.jobs).toEqual(jobs));
  expect(result.current.loaded).toBe(true);
  expect(fetchJobs).toHaveBeenCalledTimes(1);
});

test("loaded is false until the first fetch resolves", async () => {
  let resolveFetch: (value: JobListEntry[]) => void = () => {};
  const fetchJobs = jest.fn().mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));
  const { result } = renderHook(() => usePolledJobs({ fetchJobs, intervalMs: 12000, isVisible: () => true }));

  expect(result.current.loaded).toBe(false);

  await act(async () => {
    resolveFetch(jobs);
  });

  await waitFor(() => expect(result.current.loaded).toBe(true));
});

test("polls again after the interval elapses while visible", async () => {
  const fetchJobs = jest.fn().mockResolvedValue(jobs);
  renderHook(() => usePolledJobs({ fetchJobs, intervalMs: 12000, isVisible: () => true }));

  await waitFor(() => expect(fetchJobs).toHaveBeenCalledTimes(1));
  act(() => jest.advanceTimersByTime(12000));
  await waitFor(() => expect(fetchJobs).toHaveBeenCalledTimes(2));
});

test("skips a poll tick while the tab is hidden", async () => {
  const fetchJobs = jest.fn().mockResolvedValue(jobs);
  let visible = false;
  renderHook(() => usePolledJobs({ fetchJobs, intervalMs: 12000, isVisible: () => visible }));

  await waitFor(() => expect(fetchJobs).toHaveBeenCalledTimes(1)); // initial fetch always happens
  act(() => jest.advanceTimersByTime(12000));
  expect(fetchJobs).toHaveBeenCalledTimes(1); // second tick skipped - tab hidden

  visible = true;
  act(() => jest.advanceTimersByTime(12000));
  await waitFor(() => expect(fetchJobs).toHaveBeenCalledTimes(2));
});

test("a rejected poll does not throw an unhandled rejection and the next tick still runs", async () => {
  const fetchJobs = jest.fn().mockRejectedValueOnce(new Error("network blip")).mockResolvedValueOnce(jobs);
  const { result } = renderHook(() => usePolledJobs({ fetchJobs, intervalMs: 12000, isVisible: () => true }));

  await waitFor(() => expect(fetchJobs).toHaveBeenCalledTimes(1));
  act(() => jest.advanceTimersByTime(12000));
  await waitFor(() => expect(result.current.jobs).toEqual(jobs));
});
