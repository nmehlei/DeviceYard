import { artifactLevel, AMBER_BYTES, RED_BYTES } from "../../src/lib/artifactThreshold";

test("named thresholds match the spec: amber >= 2GB, red >= 5GB", () => {
  expect(AMBER_BYTES).toBe(2 * 1024 ** 3);
  expect(RED_BYTES).toBe(5 * 1024 ** 3);
});

test("below amber threshold is ok", () => {
  expect(artifactLevel(1 * 1024 ** 3)).toBe("ok");
});

test("at or above amber but below red is amber", () => {
  expect(artifactLevel(AMBER_BYTES)).toBe("amber");
  expect(artifactLevel(3 * 1024 ** 3)).toBe("amber");
});

test("at or above red is red", () => {
  expect(artifactLevel(RED_BYTES)).toBe("red");
});
