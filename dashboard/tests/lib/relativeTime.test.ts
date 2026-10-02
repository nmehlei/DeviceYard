import { formatRelativeTime } from "../../src/lib/relativeTime";

const NOW = Date.parse("2026-08-25T12:00:00Z");

test("just under a minute ago reads as 'just now'", () => {
  expect(formatRelativeTime(NOW - 30 * 1000, NOW)).toBe("just now");
});

test("a few minutes ago", () => {
  expect(formatRelativeTime(NOW - 5 * 60 * 1000, NOW)).toBe("5 minutes ago");
});

test("one hour ago", () => {
  expect(formatRelativeTime(NOW - 60 * 60 * 1000, NOW)).toBe("1 hour ago");
});

test("two hours ago", () => {
  expect(formatRelativeTime(NOW - 2 * 60 * 60 * 1000, NOW)).toBe("2 hours ago");
});

test("yesterday reads in days", () => {
  expect(formatRelativeTime(NOW - 25 * 60 * 60 * 1000, NOW)).toBe("yesterday");
});

test("a week ago", () => {
  expect(formatRelativeTime(NOW - 8 * 24 * 60 * 60 * 1000, NOW)).toBe("last week");
});

test("a future timestamp reads as \"in\"", () => {
  expect(formatRelativeTime(NOW + 10 * 60 * 1000, NOW)).toBe("in 10 minutes");
});
