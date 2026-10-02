import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { ArtifactVideo } from "../../src/components/ArtifactVideo";
import { setActiveOrgId } from "../../src/lib/activeOrg";

beforeEach(() => {
  sessionStorage.clear();
});

test("renders a video pointing at the artifact endpoint", () => {
  render(<ArtifactVideo artifactId={42} label="map/map recording" />);
  const video = screen.getByLabelText("map/map recording") as HTMLVideoElement;
  expect(video.src).toContain("/api/artifacts/42");
});

test("does not preload - StepCard auto-expands failed/running steps, so fetching should wait for the user to press play", () => {
  render(<ArtifactVideo artifactId={42} label="map/map recording" />);
  const video = screen.getByLabelText("map/map recording") as HTMLVideoElement;
  expect(video.preload).toBe("none");
});

test("appends ?orgId= to the video src when an active org is set - <video> can't set headers", () => {
  setActiveOrgId(7);
  render(<ArtifactVideo artifactId={42} label="map/map recording" />);
  const video = screen.getByLabelText("map/map recording") as HTMLVideoElement;
  expect(video.src).toContain("/api/artifacts/42?orgId=7");
});

test("shows an inline unavailable placeholder if the video fails to load, not a broken player", () => {
  render(<ArtifactVideo artifactId={42} label="map/map recording" />);
  const video = screen.getByLabelText("map/map recording");
  fireEvent.error(video);
  expect(screen.getByText(/recording unavailable/i)).toBeInTheDocument();
  expect(screen.queryByLabelText("map/map recording")).not.toBeInTheDocument();
});
