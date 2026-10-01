import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { ScreenshotGallery } from "../../src/components/ScreenshotGallery";
import { setActiveOrgId } from "../../src/lib/activeOrg";
import type { StepWithArtifacts } from "../../src/lib/api";

const step: StepWithArtifacts = {
  id: 1, jobId: "job", ordinal: 0, kind: "flow", name: "checkout", status: "passed", exitCode: 0,
  startedAt: 0, finishedAt: 1000, resolvedPath: null, artifactDir: null, warnings: [], stdoutPreview: null, stderrPreview: null,
  artifacts: [
    { id: 1, flowRunId: 1, kind: "screenshot", relPath: "job/0/final.png", bytes: 1, createdAt: 0 },
    { id: 2, flowRunId: 1, kind: "screenshot", relPath: "job/0/maestro/final.png", bytes: 1, createdAt: 0 },
  ],
};
beforeEach(() => sessionStorage.clear());
test("defaults to the reserved end-of-flow capture and retains selection across live updates", () => {
  setActiveOrgId(7);
  const { rerender } = render(<ScreenshotGallery step={step} />);
  expect(screen.getByAltText("checkout screenshot")).toHaveAttribute("src", "/api/artifacts/1?orgId=7");
  fireEvent.click(screen.getByRole("button", { name: "final.png" }));
  expect(screen.getByAltText("checkout screenshot")).toHaveAttribute("src", "/api/artifacts/2?orgId=7");
  rerender(<ScreenshotGallery step={{ ...step, artifacts: [...step.artifacts, { ...step.artifacts[1], id: 3 }] }} />);
  expect(screen.getByAltText("checkout screenshot")).toHaveAttribute("src", "/api/artifacts/2?orgId=7");
  expect(screen.getByRole("link", { name: /open full-size/i })).toHaveAttribute("href", "/api/artifacts/2?orgId=7");
});
test("falls back when a selected capture disappears and recovers from a missing image", () => {
  const { rerender } = render(<ScreenshotGallery step={step} />);
  fireEvent.error(screen.getByAltText("checkout screenshot"));
  expect(screen.getByText("Screenshot unavailable")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "final.png" }));
  expect(screen.getByAltText("checkout screenshot")).toHaveAttribute("src", "/api/artifacts/2");
  rerender(<ScreenshotGallery step={{ ...step, artifacts: [step.artifacts[0]] }} />);
  expect(screen.getByAltText("checkout screenshot")).toHaveAttribute("src", "/api/artifacts/1");
});
