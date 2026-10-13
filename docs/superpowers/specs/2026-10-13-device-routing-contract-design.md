# Device routing contract

Approved by the user on 2026-10-13 as the shared portion of Pro device routing.

Persist device tags and job requirements in additive schema version 14. Validate at most 16 unique lowercase ASCII tags, 1–32 letters/digits/hyphens with an alphanumeric first character. Existing jobs receive empty requirements. Reject constrained submissions unless the edition explicitly enables routing; check again after asynchronous input preparation. Store requirements in the job-creation transaction.

Community claims only unconstrained jobs, including when opening a database previously used by Pro. Add ordered queued-job reads and atomic claim-by-ID for edition schedulers. Keep actual tag matching and administration in Pro. Add typed runtime/scheduler hooks for authenticated edition routes, waiting reasons and compatible remote-control handover.

Expose requirements in shared types, OpenAPI, CLI --device-tags and job details. Queue reasons refresh periodically on the authenticated event stream. Add a small typed dashboard device-settings slot; Community renders no extra controls. Pro replaces only that slot during assembly.

Verify validation, persistence/restart, atomic claims, Community fallback, upload rejection/cleanup, CLI serialization and UI states. Pro must separately verify matching, FIFO among compatible jobs, health/lease/maintenance/entitlement races. No infrastructure or production changes.
