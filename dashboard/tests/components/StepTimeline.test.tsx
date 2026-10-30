import "@testing-library/jest-dom";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { StepTimeline } from "../../src/components/StepTimeline";
import type { StepWithArtifacts } from "../../src/lib/api";
import { setActiveOrgId } from "../../src/lib/activeOrg";

beforeEach(() => {
  sessionStorage.clear();
});

const baseStep: StepWithArtifacts = {
  id: 1, jobId: "job-1", ordinal: 0, kind: "flow", name: "map/map", status: "failed",
  exitCode: 1, startedAt: 0, finishedAt: 1000, resolvedPath: null, artifactDir: "job-1/0",
  warnings: [], stdoutPreview: "out", stderrPreview: "err", artifacts: [
    { id: 5, flowRunId: 1, kind: "screenshot", relPath: "job-1/0/final.png", bytes: 100, createdAt: 0 },
  ],
};

test("renders a flow step with its screenshot and status", () => {
  render(<StepTimeline steps={[baseStep]} />);
  expect(screen.getByText("map/map")).toBeInTheDocument();
  expect(screen.getByText("Failed")).toBeInTheDocument();
  expect(screen.getByAltText(/map\/map screenshot/i)).toBeInTheDocument();
});

test("shows the latest screenshot when a flow collected several", () => {
  const multiShot: StepWithArtifacts = {
    ...baseStep,
    artifacts: [
      { id: 5, flowRunId: 1, kind: "screenshot", relPath: "job-1/0/1-shared-setup.png", bytes: 100, createdAt: 0 },
      { id: 6, flowRunId: 1, kind: "screenshot", relPath: "job-1/0/2-final.png", bytes: 100, createdAt: 1 },
    ],
  };
  render(<StepTimeline steps={[multiShot]} />);
  const img = screen.getByAltText(/map\/map screenshot/i) as HTMLImageElement;
  expect(img.src).toContain("/api/artifacts/6");
});

test("labels a failed setup step with honest copy, not as a flow", () => {
  const setupStep: StepWithArtifacts = { ...baseStep, kind: "setup", name: "install", artifacts: [] };
  render(<StepTimeline steps={[setupStep]} />);
  expect(screen.getByText(/app install failed/i)).toBeInTheDocument();
  expect(screen.queryByText("install")).not.toBeInTheDocument();
});

test("labels a failed device setup step distinctly", () => {
  const setupStep: StepWithArtifacts = { ...baseStep, kind: "setup", name: "device", artifacts: [] };
  render(<StepTimeline steps={[setupStep]} />);
  expect(screen.getByText(/device preparation failed/i)).toBeInTheDocument();
});

test("renders warnings when present", () => {
  const withWarning: StepWithArtifacts = { ...baseStep, warnings: ["could not collect hierarchy dump"] };
  render(<StepTimeline steps={[withWarning]} />);
  expect(screen.getByText("could not collect hierarchy dump")).toBeInTheDocument();
});

test("a failed step starts expanded", () => {
  render(<StepTimeline steps={[baseStep]} />);
  const details = screen.getByText("map/map").closest("details") as HTMLDetailsElement;
  expect(details.open).toBe(true);
});

test("a passed step starts collapsed, and clicking its summary expands it", () => {
  const passedStep: StepWithArtifacts = { ...baseStep, status: "passed" };
  render(<StepTimeline steps={[passedStep]} />);
  const summary = screen.getByText("map/map").closest("summary") as HTMLElement;
  const details = summary.closest("details") as HTMLDetailsElement;
  expect(details.open).toBe(false);

  fireEvent.click(summary);
  expect(details.open).toBe(true);
});

test("a running step starts expanded", () => {
  const runningStep: StepWithArtifacts = { ...baseStep, status: "running" };
  render(<StepTimeline steps={[runningStep]} />);
  const details = screen.getByText("map/map").closest("details") as HTMLDetailsElement;
  expect(details.open).toBe(true);
});

test("a skipped step starts collapsed", () => {
  const skippedStep: StepWithArtifacts = { ...baseStep, status: "skipped" };
  render(<StepTimeline steps={[skippedStep]} />);
  const details = screen.getByText("map/map").closest("details") as HTMLDetailsElement;
  expect(details.open).toBe(false);
});

test("appends ?orgId= to the hierarchy dump link when an active org is set - <a> can't set headers", () => {
  setActiveOrgId(7);
  const stepWithHierarchy: StepWithArtifacts = {
    ...baseStep,
    artifacts: [{ id: 9, flowRunId: 1, kind: "hierarchy", relPath: "job-1/0/hierarchy.xml", bytes: 50, createdAt: 0 }],
  };
  render(<StepTimeline steps={[stepWithHierarchy]} />);
  const link = screen.getByText(/view hierarchy dump/i) as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe("/api/artifacts/9?orgId=7");
});

test("does not render a LogViewer for a queued step with no log previews", () => {
  const queuedStep: StepWithArtifacts = {
    ...baseStep, status: "queued", stdoutPreview: null, stderrPreview: null, artifacts: [],
  };
  render(<StepTimeline steps={[queuedStep]} />);
  expect(screen.queryByRole("button", { name: /view full log/i })).not.toBeInTheDocument();
});

test("renders a recording video below the screenshot when the step has one", () => {
  const withVideo: StepWithArtifacts = {
    ...baseStep,
    artifacts: [
      ...baseStep.artifacts,
      { id: 11, flowRunId: 1, kind: "recording", relPath: "job-1/0/recording.mp4", bytes: 5000, createdAt: 0 },
    ],
  };
  render(<StepTimeline steps={[withVideo]} />);
  const video = screen.getByLabelText(/map\/map recording/i) as HTMLVideoElement;
  expect(video.src).toContain("/api/artifacts/11");
});

test("renders no video element when the step has no recording artifact", () => {
  render(<StepTimeline steps={[baseStep]} />);
  expect(screen.queryByLabelText(/recording/i)).not.toBeInTheDocument();
});

test("separates preparation from flows and orders flows by ordinal", () => {
  render(<StepTimeline steps={[
    { ...baseStep, id: 3, ordinal: 3, name: "last" },
    { ...baseStep, id: 2, ordinal: 0, kind: "setup", name: "install", artifacts: [] },
    { ...baseStep, id: 1, ordinal: 1, name: "first" },
  ]} />);
  expect(within(screen.getByRole("region", { name: "Preparation" })).getByText("App install failed")).toBeInTheDocument();
  const flows = within(screen.getByRole("region", { name: "Flows" }));
  expect(flows.queryByText("App install failed")).not.toBeInTheDocument();
  const items = flows.getAllByRole("listitem");
  expect(items[0]).toHaveTextContent("first");
  expect(items[1]).toHaveTextContent("last");
});

test("live updates do not reopen a flow the visitor collapsed", () => {
  const { rerender } = render(<StepTimeline steps={[{ ...baseStep, status: "running" }]} />);
  const details = screen.getByText("map/map").closest("details") as HTMLDetailsElement;
  details.open = false;
  fireEvent(details, new Event("toggle"));
  rerender(<StepTimeline steps={[{ ...baseStep, status: "failed" }]} />);
  expect(details.open).toBe(false);
});

test("a step with profileMs shows the work profile time", () => {
  render(<StepTimeline steps={[{ ...baseStep, profileMs: 18400 }]} />);
  expect(screen.getByText("Work profile: 18.4 s")).toBeInTheDocument();
});

test("a step without profileMs shows no work profile time", () => {
  render(<StepTimeline steps={[{ ...baseStep, profileMs: null }, { ...baseStep, id: 2, ordinal: 1 }]} />);
  expect(screen.queryByText(/Work profile/)).not.toBeInTheDocument();
});
