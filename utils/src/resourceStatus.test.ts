import { describe, expect, it } from "vitest";
import { resolveResourceStatus, STALE_AFTER_MS } from "./resourceStatus.js";

const NOW = Date.parse("2026-08-18T12:00:00.000Z");
const fresh = new Date(NOW - 1_000).toISOString();
const tooOld = new Date(NOW - STALE_AFTER_MS - 1).toISOString();

describe("resolveResourceStatus", () => {
  it("treats an ARN the Brain never reported as unscanned", () => {
    expect(resolveResourceStatus(undefined, NOW)).toBe("unscanned");
    expect(resolveResourceStatus({}, NOW)).toBe("unscanned");
  });

  it("reads valid and error verdicts with fresh evaluatedAt", () => {
    expect(resolveResourceStatus({ read: { status: "valid", evaluatedAt: fresh } }, NOW)).toBe(
      "healthy",
    );
    expect(resolveResourceStatus({ read: { status: "error", evaluatedAt: fresh } }, NOW)).toBe(
      "blocked",
    );
  });

  it("lets one blocked action outrank its healthy siblings", () => {
    const entry = {
      read: { status: "valid", evaluatedAt: fresh },
      write: { status: "error", evaluatedAt: fresh },
    };
    expect(resolveResourceStatus(entry, NOW)).toBe("blocked");
  });

  it("lets stale outrank blocked", () => {
    expect(resolveResourceStatus({ read: { status: "error", evaluatedAt: tooOld } }, NOW)).toBe(
      "stale",
    );
  });

  it("counts a missing or unparseable evaluatedAt as stale", () => {
    expect(resolveResourceStatus({ read: { status: "valid" } }, NOW)).toBe("stale");
    expect(resolveResourceStatus({ read: { status: "valid", evaluatedAt: "nonsense" } }, NOW)).toBe(
      "stale",
    );
  });

  it("goes stale the instant the threshold is passed, not before", () => {
    const exactlyAtLimit = new Date(NOW - STALE_AFTER_MS).toISOString();
    expect(resolveResourceStatus({ read: { status: "valid", evaluatedAt: exactlyAtLimit } }, NOW)).toBe(
      "healthy",
    );
    expect(resolveResourceStatus({ read: { status: "valid", evaluatedAt: tooOld } }, NOW)).toBe(
      "stale",
    );
  });

  it("accepts a single top-level verdict as well as a per-action map", () => {
    expect(resolveResourceStatus({ status: "error", evaluatedAt: fresh }, NOW)).toBe("blocked");
  });

  it("uses evaluatedAt as the source of truth for stale even if timestamp is fresh", () => {
    expect(
      resolveResourceStatus(
        { read: { status: "valid", timestamp: fresh, evaluatedAt: tooOld } },
        NOW,
      ),
    ).toBe("stale");

    expect(
      resolveResourceStatus(
        { read: { status: "valid", timestamp: tooOld, evaluatedAt: fresh } },
        NOW,
      ),
    ).toBe("healthy");
  });

  it("treats missing or null evaluatedAt as stale even if update timestamp is fresh", () => {
    expect(
      resolveResourceStatus(
        { read: { status: "valid", timestamp: fresh, evaluatedAt: null } },
        NOW,
      ),
    ).toBe("stale");

    expect(
      resolveResourceStatus(
        { read: { status: "valid", timestamp: fresh } },
        NOW,
      ),
    ).toBe("stale");
  });
});
