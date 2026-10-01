import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { ArtifactImage } from "../../src/components/ArtifactImage";
import { setActiveOrgId } from "../../src/lib/activeOrg";

beforeEach(() => {
  sessionStorage.clear();
});

test("renders an img pointing at the artifact endpoint", () => {
  render(<ArtifactImage artifactId={42} alt="step screenshot" />);
  const img = screen.getByAltText("step screenshot") as HTMLImageElement;
  expect(img.src).toContain("/api/artifacts/42");
});

test("appends ?orgId= to the img src when an active org is set - <img> can't set headers", () => {
  setActiveOrgId(7);
  render(<ArtifactImage artifactId={42} alt="step screenshot" />);
  const img = screen.getByAltText("step screenshot") as HTMLImageElement;
  expect(img.src).toContain("/api/artifacts/42?orgId=7");
});

test("shows an inline unavailable placeholder if the image fails to load, not a broken-image icon", () => {
  render(<ArtifactImage artifactId={42} alt="step screenshot" />);
  const img = screen.getByAltText("step screenshot");
  fireEvent.error(img);
  expect(screen.getByText(/screenshot unavailable/i)).toBeInTheDocument();
  expect(screen.queryByAltText("step screenshot")).not.toBeInTheDocument();
});
