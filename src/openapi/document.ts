import type { OpenAPIV3_1 } from "openapi-types";
import { readVersion } from "../version";

// OpenAPI 3.1 embeds full JSON Schema 2020-12. openapi-types currently leaks
// a few OpenAPI 3.0 schema types through ParameterObject and PathItemObject,
// which rejects valid 3.1 constructs such as `type: ["string", "null"]`.
// Keep authoring values structurally typed here and validate the finished
// document against the official schema in tests.
type JsonObject = Record<string, any>;
type Operation = JsonObject;
type Schema = JsonObject;
const OpenAPIV3_1 = {
  HttpMethods: { GET: "get", PUT: "put", POST: "post", DELETE: "delete", PATCH: "patch" },
} as const;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const array = (items: Schema): Schema => ({ type: "array", items });
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
const json = (schema: Schema, description = "Success"): JsonObject => ({
  description,
  content: { "application/json": { schema } },
});
const body = (schema: Schema, required = true): JsonObject => ({
  required,
  content: { "application/json": { schema } },
});
const empty = (description: string): JsonObject => ({ description });
const errorResponses = (...statuses: number[]): JsonObject => Object.fromEntries(
  statuses.map((status) => [status, json(ref("Error"), "Request failed")])
);
const pathParameter = (name: string, schema: Schema = { type: "string" }): JsonObject => ({
  name,
  in: "path",
  required: true,
  schema,
});
const queryParameter = (name: string, schema: Schema, description?: string): JsonObject => ({
  name,
  in: "query",
  required: false,
  schema,
  ...(description ? { description } : {}),
});

const authenticated: Pick<Operation, "security"> = {
  security: [{ bearerAuth: [] }, { orgTokenQuery: [] }, { sessionCookie: [] }],
};
const sessionOnly: Pick<Operation, "security"> = { security: [{ sessionCookie: [] }] };
const publicOperation: Pick<Operation, "security"> = { security: [] };

function op(
  operationId: string,
  tag: string,
  summary: string,
  responses: JsonObject,
  extra: Partial<Operation> = {},
): Operation {
  const defaultSecurity = tag === "Administration" ? sessionOnly : authenticated;
  return { operationId, tags: [tag], summary, responses, ...defaultSecurity, ...extra };
}

const schemas: Record<string, Schema> = {
  MaintenanceStatus: object({ requested: { type: 'boolean' }, state: { type: 'string', enum: ['normal', 'draining', 'ready'] },
    runningJobs: { type: 'integer', minimum: 0 }, activeOperations: { type: 'integer', minimum: 0 }, activeStreams: { type: 'integer', minimum: 0 } },
    ['requested', 'state', 'runningJobs', 'activeOperations', 'activeStreams']),
  Error: object({ error: { type: "string" }, code: { type: "string" } }, ["error"]),
  Ok: object({ ok: { type: "boolean", const: true } }, ["ok"]),
  Org: object({
    id: { type: "integer" }, name: { type: "string" }, archivedAt: { type: ["integer", "null"] },
  }, ["id", "name"]),
  User: object({
    id: { type: "integer" }, username: { type: "string" }, email: { type: "string", format: "email" },
    isAdmin: { type: "boolean" }, deactivatedAt: { type: ["integer", "null"] },
  }, ["id", "username", "email", "isAdmin"]),
  Token: object({
    id: { type: "integer" }, label: { type: "string" }, value: { type: "string", writeOnly: true },
    createdAt: { type: "integer" }, lastUsedAt: { type: ["integer", "null"] },
    userId: { type: "integer" }, orgId: { type: "integer" }, createdBy: { type: "integer" },
  }, ["id", "label", "value", "createdAt"]),
  Session: object({ user: ref("User"), orgs: array(ref("Org")) }, ["user", "orgs"]),
  Artifact: object({
    id: { type: "integer" }, flowRunId: { type: "integer" }, kind: { type: "string" },
    relPath: { type: "string" }, bytes: { type: "integer" }, createdAt: { type: "integer" },
  }, ["id", "flowRunId", "kind", "relPath", "bytes", "createdAt"]),
  Step: object({
    id: { type: "integer" }, jobId: { type: "string" }, ordinal: { type: "integer" },
    kind: { type: "string", enum: ["setup", "flow"] }, name: { type: "string" },
    status: { type: "string", enum: ["queued", "running", "passed", "failed", "skipped"] },
    exitCode: { type: ["integer", "null"] }, profileMs: { type: ["integer", "null"], description: "Milliseconds spent creating the work profile for this step, when isolated" }, startedAt: { type: ["integer", "null"] },
    finishedAt: { type: ["integer", "null"] }, resolvedPath: { type: ["string", "null"] },
    artifactDir: { type: ["string", "null"] }, warnings: array({ type: "string" }),
    stdoutPreview: { type: ["string", "null"] }, stderrPreview: { type: ["string", "null"] },
    artifacts: array(ref("Artifact")),
  }, ["id", "jobId", "ordinal", "kind", "name", "status"]),
  Job: object({
    isolation: { type: 'string', enum: ['disabled', 'per-job', 'per-flow'] },
    requiredDeviceTags: { type: 'array', maxItems: 16, uniqueItems: true, items: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,31}$' } },
    waitingReason: { type: ['string', 'null'], description: 'Current queue eligibility reason, included in job details' },
    id: { type: "string" }, org: { type: "string" },
    status: { type: "string", enum: ["queued", "running", "done", "failed"] },
    error: { type: ["string", "null"] }, createdAt: { type: "integer" },
    startedAt: { type: ["integer", "null"] }, finishedAt: { type: ["integer", "null"] },
    envJson: { type: ["string", "null"], description: "JSON with secret values masked" },
    deviceId: { type: ["string", "null"] },
  }, ["id", "org", "status", "createdAt"]),
  JobSummary: {
    allOf: [ref("Job"), object({
      flowCount: { type: "integer" }, passed: { type: "integer" }, failed: { type: "integer" }, running: { type: "integer" },
    }, ["flowCount", "passed", "failed", "running"])],
  },
  LegacyResult: object({
    flow: { type: "string" }, passed: { type: "boolean" }, stdout: { type: "string" }, stderr: { type: "string" },
  }, ["flow", "passed", "stdout", "stderr"]),
  LegacyJob: object({
    id: { type: "string" }, org: { type: "string" }, flows: array({ type: "string" }),
    status: { type: "string", enum: ["queued", "running", "done", "failed"] },
    results: array(ref("LegacyResult")), error: { type: "string" }, createdAt: { type: "integer" },
  }, ["id", "org", "flows", "status", "results", "createdAt"]),
  Device: object({
    tags: { type: 'array', maxItems: 16, uniqueItems: true, items: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,31}$' } },
    id: { type: "string" }, label: { type: ["string", "null"] }, model: { type: ["string", "null"] },
    isActive: { type: "boolean" }, state: { type: "string" }, createdAt: { type: "integer" },
    resetPolicy: { type: "string", enum: ["app-only", "app-and-browser"], description: "How thoroughly the device resets itself before each job. Set per device, never per job, so flows stay portable." },
    setupChecks: array(object({
      id: { type: "string" }, title: { type: "string" }, detail: { type: "string" },
      ok: { type: ["boolean", "null"], description: "null = could not be read (device not online, or the read failed)." },
    }, ["id", "title", "detail", "ok"])),
  }, ["id", "isActive"]),
  DeviceEvent: object({
    id: { type: "integer" }, deviceId: { type: "string" }, kind: { type: "string" },
    detail: { type: ["string", "null"] }, createdAt: { type: "integer" },
  }, ["id", "deviceId", "kind", "createdAt"]),
  Invitation: object({
    id: { type: "string" }, email: { type: "string", format: "email" }, expiresAt: { type: "integer" },
    createdAt: { type: "integer" }, status: { type: "string", enum: ["pending", "expired", "closed"] },
  }, ["id", "email", "expiresAt", "createdAt", "status"]),
  NotificationPreferences: object({
    email: { type: "string", format: "email" }, verified: { type: "boolean" }, isAdmin: { type: "boolean" },
    available: { type: "boolean" }, deviceHealth: { type: "boolean" },
    orgs: array(object({ orgId: { type: "integer" }, orgName: { type: "string" }, run: { type: "string", enum: ["off", "failures", "all"] } }, ["orgId", "orgName", "run"])),
  }, ["email", "verified", "isAdmin", "available", "orgs", "deviceHealth"]),
};

const paths: Record<string, Record<string, Operation>> = {};
function add(path: string, method: string, operation: Operation): void {
  const item = (paths[path] ??= {});
  item[method] = operation;
}

add("/openapi.json", OpenAPIV3_1.HttpMethods.GET, op("getOpenApiDocument", "OpenAPI", "Get this instance's OpenAPI document", {
  200: { description: "OpenAPI 3.1 document", content: { "application/json": { schema: { type: "object" } } } },
}, publicOperation));

add("/run", OpenAPIV3_1.HttpMethods.POST, op("submitRun", "CI", "Queue a test run", {
  202: json(object({ id: { type: "string" }, status: { type: "string", const: "queued" }, warnings: array({ type: "string" }) }, ["id", "status"]), "Run queued"),
  ...errorResponses(400, 401, 403, 413, 500, 503),
}, { requestBody: { required: true, content: { "multipart/form-data": { schema: object({
  apk: { type: "string", format: "binary" }, flowsArchive: { type: "string", format: "binary" },
  flows: { type: "string", description: "JSON array of flow identifiers" },
  env: { type: "string", description: "Optional JSON object of string environment values" },
  requiredDeviceTags: { type: 'string', description: 'Optional JSON array of up to 16 unique lowercase device tags, 1–32 letters/digits/hyphens with an alphanumeric first character. Nonempty requirements need active Pro routing. All tags must match; never silently ignored.' },
  isolation: { type: 'string', enum: ['disabled', 'per-job', 'per-flow'], description: 'Optional work-profile isolation mode (default disabled; non-disabled needs active Pro isolation). `per-job` costs about 15–40 s and about 1.5 GB of device writes per job; `per-flow` costs that for every flow (a 27-flow suite writes about 40 GB). per-flow submissions also return a warning.' },
}, ["apk", "flowsArchive", "flows"]) } } } }));
add("/run/{id}", OpenAPIV3_1.HttpMethods.GET, op("getRun", "CI", "Get a test run", { 200: json(ref("LegacyJob")), ...errorResponses(401, 403, 404) }, { parameters: [pathParameter("id")] }));
add("/jobs", OpenAPIV3_1.HttpMethods.GET, op("listRuns", "CI", "List the latest test runs", { 200: json(array(ref("LegacyJob"))), ...errorResponses(401, 403) }));
add("/status", OpenAPIV3_1.HttpMethods.GET, op("getStatusPage", "CI", "Get the legacy HTML status page", {
  200: { description: "Status page", content: { "text/html": { schema: { type: "string" } } } }, ...errorResponses(401, 403),
}));

add("/api/session", OpenAPIV3_1.HttpMethods.POST, op("createSession", "Session", "Sign in", { 200: json(ref("Session")), ...errorResponses(400, 403) }, {
  ...publicOperation, requestBody: body(object({ username: { type: "string" }, password: { type: "string", format: "password", writeOnly: true } }, ["username", "password"])),
}));
add("/api/session", OpenAPIV3_1.HttpMethods.GET, op("getSession", "Session", "Get the current session", { 200: json(ref("Session")), ...errorResponses(401) }, sessionOnly));
add("/api/session/password", OpenAPIV3_1.HttpMethods.PATCH, op("changePassword", "Session", "Change the signed-in user's password", { 200: json(ref("Ok")), ...errorResponses(400, 401, 403) }, {
  ...sessionOnly, requestBody: body(object({ currentPassword: { type: "string", format: "password", writeOnly: true }, newPassword: { type: "string", format: "password", writeOnly: true } }, ["currentPassword", "newPassword"])),
}));
add("/api/session", OpenAPIV3_1.HttpMethods.DELETE, op("deleteSession", "Session", "Sign out", { 204: empty("Signed out") }, sessionOnly));

add("/api/me/orgs", OpenAPIV3_1.HttpMethods.GET, op("listMyOrganisations", "Identity", "List organisations available to the current identity", { 200: json(object({ orgs: array(ref("Org")) }, ["orgs"])), ...errorResponses(401) }));
add("/api/me/tokens", OpenAPIV3_1.HttpMethods.GET, op("listPersonalTokens", "Identity", "List personal access tokens", { 200: json(object({ tokens: array(ref("Token")) }, ["tokens"])), ...errorResponses(401) }, sessionOnly));
add("/api/me/tokens", OpenAPIV3_1.HttpMethods.POST, op("createPersonalToken", "Identity", "Create a personal access token", { 201: json(object({ token: ref("Token") }, ["token"])), ...errorResponses(400, 401) }, { ...sessionOnly, requestBody: body(object({ label: { type: "string" } }, ["label"])) }));
add("/api/me/tokens/{tokenId}", OpenAPIV3_1.HttpMethods.DELETE, op("deletePersonalToken", "Identity", "Revoke a personal access token", { 204: empty("Token revoked"), ...errorResponses(401) }, { ...sessionOnly, parameters: [pathParameter("tokenId", { type: "integer" })] }));

add("/api/me/notifications", OpenAPIV3_1.HttpMethods.GET, op("getNotificationPreferences", "Notifications", "Get notification preferences", { 200: json(ref("NotificationPreferences")), ...errorResponses(401) }, sessionOnly));
add("/api/me/notifications", OpenAPIV3_1.HttpMethods.PUT, op("updateNotificationPreferences", "Notifications", "Replace notification preferences", { 200: json(ref("NotificationPreferences")), ...errorResponses(400, 401, 403, 409) }, { ...sessionOnly, requestBody: body(object({
  orgs: array(object({ orgId: { type: "integer" }, run: { type: "string", enum: ["off", "failures", "all"] } }, ["orgId", "run"])), deviceHealth: { type: "boolean" },
}, ["orgs", "deviceHealth"])) }));
add("/api/notifications/templates/{kind}", OpenAPIV3_1.HttpMethods.GET, op("previewNotificationTemplate", "Notifications", "Preview an email template", { 200: json({ type: "object", additionalProperties: true }), ...errorResponses(401, 404) }, { ...sessionOnly, parameters: [pathParameter("kind")] }));
add("/api/admin/notifications", OpenAPIV3_1.HttpMethods.GET, op("getNotificationStatus", "Administration", "Get notification delivery status", { 200: json({ type: "object", additionalProperties: true }), ...errorResponses(401, 403) }, sessionOnly));
add("/api/admin/notifications/history", OpenAPIV3_1.HttpMethods.GET, op("getNotificationHistory", "Administration", "List notification delivery history", { 200: json({ type: "object", additionalProperties: true }), ...errorResponses(400, 401, 403) }, { ...sessionOnly, parameters: [queryParameter("offset", { type: "integer", minimum: 0, maximum: 100000 })] }));
add("/api/admin/notifications/test", OpenAPIV3_1.HttpMethods.POST, op("sendTestNotification", "Administration", "Queue a test notification", { 202: json(ref("Ok")), ...errorResponses(401, 403, 409, 429, 503) }, sessionOnly));

add("/api/account/password-reset", OpenAPIV3_1.HttpMethods.POST, op("requestPasswordReset", "Account actions", "Request a password reset email", { 202: json(object({ message: { type: "string" } }, ["message"])), ...errorResponses(429, 500, 503) }, { ...publicOperation, requestBody: body(object({ email: { type: "string", format: "email" } }, ["email"])) }));
add("/api/account/verify-email", OpenAPIV3_1.HttpMethods.POST, op("requestEmailVerification", "Account actions", "Request an email verification email", { 202: json(ref("Ok")), ...errorResponses(401, 429, 500, 503) }, sessionOnly));
add("/api/account/actions/inspect", OpenAPIV3_1.HttpMethods.POST, op("inspectAccountAction", "Account actions", "Inspect an account-action token", { 200: json({ type: "object", additionalProperties: true }), ...errorResponses(400, 410, 429, 500) }, { ...publicOperation, requestBody: body(object({ token: { type: "string", writeOnly: true } }, ["token"])) }));
add("/api/account/actions/redeem", OpenAPIV3_1.HttpMethods.POST, op("redeemAccountAction", "Account actions", "Redeem an account-action token", { 200: json(ref("Ok")), ...errorResponses(400, 409, 410, 429, 500) }, { ...publicOperation, requestBody: body(object({
  token: { type: "string", writeOnly: true }, kind: { type: "string", enum: ["invitation", "password-reset", "email-verification"] },
  password: { type: "string", format: "password", writeOnly: true }, username: { type: "string" },
}, ["token", "kind"])) }));
add("/api/orgs/{id}/invitations", OpenAPIV3_1.HttpMethods.GET, op("listInvitations", "Organisations", "List organisation invitations", { 200: json(object({ invitations: array(ref("Invitation")) }, ["invitations"])), ...errorResponses(401, 404) }, { ...sessionOnly, parameters: [pathParameter("id", { type: "integer" })] }));
add("/api/orgs/{id}/invitations", OpenAPIV3_1.HttpMethods.POST, op("createInvitation", "Organisations", "Invite a user to an organisation", { 202: json(object({ id: { type: "string" } }, ["id"])), ...errorResponses(400, 401, 404, 429, 500, 503) }, { ...sessionOnly, parameters: [pathParameter("id", { type: "integer" })], requestBody: body(object({ email: { type: "string", format: "email" } }, ["email"])) }));
add("/api/orgs/{id}/invitations/{actionId}/resend", OpenAPIV3_1.HttpMethods.POST, op("resendInvitation", "Organisations", "Resend an organisation invitation", { 202: json(object({ id: { type: "string" } }, ["id"])), ...errorResponses(401, 404, 429, 500, 503) }, { ...sessionOnly, parameters: [pathParameter("id", { type: "integer" }), pathParameter("actionId")] }));
add("/api/orgs/{id}/invitations/{actionId}", OpenAPIV3_1.HttpMethods.DELETE, op("cancelInvitation", "Organisations", "Cancel an organisation invitation", { 204: empty("Invitation cancelled"), ...errorResponses(401, 404, 500) }, { ...sessionOnly, parameters: [pathParameter("id", { type: "integer" }), pathParameter("actionId")] }));

add("/api/orgs/{id}/members", OpenAPIV3_1.HttpMethods.GET, op("listOrganisationMembers", "Organisations", "List organisation members", { 200: json(object({ members: array(ref("User")) }, ["members"])), ...errorResponses(401, 404) }, { ...sessionOnly, parameters: [pathParameter("id", { type: "integer" })] }));
add("/api/orgs/{id}/members", OpenAPIV3_1.HttpMethods.POST, op("addOrganisationMember", "Organisations", "Add an organisation member", { 201: json(ref("Ok")), ...errorResponses(400, 401, 404) }, { ...sessionOnly, parameters: [pathParameter("id", { type: "integer" })], requestBody: body(object({ userId: { type: "integer" } }, ["userId"])) }));
add("/api/orgs/{id}/members/{userId}", OpenAPIV3_1.HttpMethods.DELETE, op("removeOrganisationMember", "Organisations", "Remove an organisation member", { 204: empty("Member removed"), ...errorResponses(401, 404, 409) }, { ...sessionOnly, parameters: [pathParameter("id", { type: "integer" }), pathParameter("userId", { type: "integer" })] }));
add("/api/orgs/{id}/tokens", OpenAPIV3_1.HttpMethods.GET, op("listOrganisationTokens", "Organisations", "List organisation access tokens", { 200: json(object({ tokens: array(ref("Token")) }, ["tokens"])), ...errorResponses(401, 404) }, { ...sessionOnly, parameters: [pathParameter("id", { type: "integer" })] }));
add("/api/orgs/{id}/tokens", OpenAPIV3_1.HttpMethods.POST, op("createOrganisationToken", "Organisations", "Create an organisation access token", { 201: json(object({ token: ref("Token") }, ["token"])), ...errorResponses(400, 401, 404) }, { ...sessionOnly, parameters: [pathParameter("id", { type: "integer" })], requestBody: body(object({ label: { type: "string" } }, ["label"])) }));
add("/api/orgs/{id}/tokens/{tokenId}", OpenAPIV3_1.HttpMethods.DELETE, op("deleteOrganisationToken", "Organisations", "Revoke an organisation access token", { 204: empty("Token revoked"), ...errorResponses(401, 404) }, { ...sessionOnly, parameters: [pathParameter("id", { type: "integer" }), pathParameter("tokenId", { type: "integer" })] }));

const adminCollection = (resource: "orgs" | "users", schemaName: "Org" | "User") => {
  add(`/api/admin/${resource}`, OpenAPIV3_1.HttpMethods.GET, op(`listAdmin${resource === "orgs" ? "Organisations" : "Users"}`, "Administration", `List all ${resource === "orgs" ? "organisations" : "users"}`, { 200: json(object({ [resource]: array(ref(schemaName)) }, [resource])), ...errorResponses(401, 403) }));
};
adminCollection("orgs", "Org");
adminCollection("users", "User");
add("/api/admin/orgs", OpenAPIV3_1.HttpMethods.POST, op("createOrganisation", "Administration", "Create an organisation", { 201: json(object({ org: ref("Org") }, ["org"])), ...errorResponses(400, 401, 403, 409) }, { requestBody: body(object({ name: { type: "string" }, initialMemberUserIds: array({ type: "integer" }) }, ["name"])) }));
add("/api/admin/orgs/{id}", OpenAPIV3_1.HttpMethods.PATCH, op("updateOrganisation", "Administration", "Rename an organisation", { 200: json(object({ org: ref("Org") }, ["org"])), ...errorResponses(400, 401, 403, 404, 409) }, { parameters: [pathParameter("id", { type: "integer" })], requestBody: body(object({ name: { type: "string" } }, ["name"])) }));
add("/api/admin/orgs/{id}", OpenAPIV3_1.HttpMethods.DELETE, op("archiveOrganisation", "Administration", "Archive an organisation", { 204: empty("Organisation archived"), ...errorResponses(401, 403, 404) }, { parameters: [pathParameter("id", { type: "integer" })] }));
add("/api/admin/users", OpenAPIV3_1.HttpMethods.POST, op("createUser", "Administration", "Create a user", { 201: json(object({ user: ref("User") }, ["user"])), ...errorResponses(400, 401, 403, 409) }, { requestBody: body(object({ username: { type: "string" }, email: { type: "string", format: "email" }, password: { type: "string", format: "password", writeOnly: true }, isAdmin: { type: "boolean" } }, ["username", "email", "password"])) }));
add("/api/admin/users/{id}", OpenAPIV3_1.HttpMethods.PATCH, op("updateUser", "Administration", "Update a user", { 200: json(object({ user: ref("User") }, ["user"])), ...errorResponses(400, 401, 403, 404) }, { parameters: [pathParameter("id", { type: "integer" })], requestBody: body(object({ isAdmin: { type: "boolean" }, password: { type: "string", format: "password", writeOnly: true } }), false) }));
add("/api/admin/users/{id}", OpenAPIV3_1.HttpMethods.DELETE, op("deactivateUser", "Administration", "Deactivate a user", { 204: empty("User deactivated"), ...errorResponses(401, 403, 404) }, { parameters: [pathParameter("id", { type: "integer" })] }));

const nullablePositiveInteger = { type: ["integer", "null"], minimum: 1 } as Schema;
add("/api/admin/retention", OpenAPIV3_1.HttpMethods.GET, op("getRetentionSettings", "Administration", "Get retention settings", { 200: json({ type: "object", additionalProperties: true }), ...errorResponses(401, 403) }));
add("/api/admin/retention", OpenAPIV3_1.HttpMethods.PUT, op("updateRetentionSettings", "Administration", "Replace retention settings", { 200: json({ type: "object", additionalProperties: true }), ...errorResponses(400, 401, 403) }, { requestBody: body(object({ maxAgeDays: { type: ["integer", "null"], minimum: 0 }, maxTotalBytes: { type: ["integer", "null"], minimum: 0 }, maxJobs: { type: ["integer", "null"], minimum: 0 } }, ["maxAgeDays", "maxTotalBytes", "maxJobs"])) }));
add("/api/admin/upload", OpenAPIV3_1.HttpMethods.GET, op("getUploadSettings", "Administration", "Get upload settings", { 200: json({ type: "object", additionalProperties: true }), ...errorResponses(401, 403) }));
add("/api/admin/upload", OpenAPIV3_1.HttpMethods.PUT, op("updateUploadSettings", "Administration", "Replace upload settings", { 200: json({ type: "object", additionalProperties: true }), ...errorResponses(400, 401, 403) }, { requestBody: body(object({ maxUploadBytes: nullablePositiveInteger }, ["maxUploadBytes"])) }));
add('/api/maintenance', OpenAPIV3_1.HttpMethods.GET, op('getMaintenance', 'Administration', 'Get maintenance status', { 200: json(ref('MaintenanceStatus')), ...errorResponses(401) }, authenticated));
add('/api/admin/maintenance', OpenAPIV3_1.HttpMethods.PUT, op('setMaintenance', 'Administration', 'Enable or resume maintenance (administrator only)', { 200: json(ref('MaintenanceStatus')), ...errorResponses(400, 401, 403) }, { requestBody: body(object({ requested: { type: 'boolean' } }, ['requested'])) }));
add("/api/admin/scheduler", OpenAPIV3_1.HttpMethods.GET, op("getSchedulerSettings", "Administration", "Get scheduler settings", { 200: json(object({ maxConcurrentJobs: nullablePositiveInteger }, ["maxConcurrentJobs"])), ...errorResponses(401, 403) }));
add("/api/admin/scheduler", OpenAPIV3_1.HttpMethods.PUT, op("updateSchedulerSettings", "Administration", "Replace scheduler settings", { 200: json(object({ maxConcurrentJobs: nullablePositiveInteger }, ["maxConcurrentJobs"])), ...errorResponses(400, 401, 403) }, { requestBody: body(object({ maxConcurrentJobs: nullablePositiveInteger }, ["maxConcurrentJobs"])) }));

add("/api/jobs", OpenAPIV3_1.HttpMethods.GET, op("listJobs", "Jobs", "List job summaries", { 200: json(object({ jobs: array(ref("JobSummary")) }, ["jobs"])), ...errorResponses(401, 403) }, { parameters: [queryParameter("limit", { type: "integer", minimum: 1, maximum: 200, default: 50 })] }));
add("/api/jobs/{id}", OpenAPIV3_1.HttpMethods.GET, op("getJob", "Jobs", "Get job details", { 200: json(object({ job: ref("Job"), steps: array(ref("Step")) }, ["job", "steps"])), ...errorResponses(401, 403, 404) }, { parameters: [pathParameter("id")] }));
add("/api/jobs/{id}/events", OpenAPIV3_1.HttpMethods.GET, op("streamJobEvents", "Jobs", "Stream job state using server-sent events", { 200: { description: "Server-sent job snapshots", content: { "text/event-stream": { schema: { type: "string" } } } }, ...errorResponses(401, 403, 404) }, { parameters: [pathParameter("id")] }));

add("/api/flow-runs/{id}/log", OpenAPIV3_1.HttpMethods.GET, op("getFlowRunLog", "Files", "Download a flow-run log", { 200: { description: "Log content", content: { "text/plain": { schema: { type: "string" } } } }, ...errorResponses(401, 403, 404) }, { parameters: [pathParameter("id", { type: "integer" }), queryParameter("stream", { type: "string", enum: ["stdout", "stderr"], default: "stdout" })] }));
add("/api/artifacts/{id}", OpenAPIV3_1.HttpMethods.GET, op("getArtifact", "Files", "Download an artifact", { 200: { description: "Artifact bytes", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } }, 206: { description: "Partial artifact bytes" }, 416: empty("Requested range is unsatisfiable"), ...errorResponses(401, 403, 404) }, { parameters: [pathParameter("id", { type: "integer" })] }));

add("/api/devices", OpenAPIV3_1.HttpMethods.GET, op("listDevices", "Devices", "List registered devices and live state", { 200: json(object({ devices: array(ref("Device")), runnerVersion: { type: "string" }, artifactBytes: { type: "integer" }, stale: { type: "boolean" }, maintenance: ref("MaintenanceStatus") }, ["devices", "runnerVersion", "artifactBytes"])), ...errorResponses(401, 403, 502) }));
add("/api/devices", OpenAPIV3_1.HttpMethods.POST, op("createDevice", "Devices", "Register a device", { 201: json(object({ device: ref("Device"), setupInstructions: array({ type: "string" }) }, ["device", "setupInstructions"])), ...errorResponses(400, 401, 403, 409) }, { requestBody: body(object({ id: { type: "string" }, label: { type: "string" } }, ["id"])) }));
for (const action of ["enable", "disable", "activate"] as const) {
  add(`/api/devices/{id}/${action}`, OpenAPIV3_1.HttpMethods.POST, op(`${action}Device`, "Devices", `${action[0].toUpperCase()}${action.slice(1)} a device`, { 200: json(object({ device: ref("Device") }, ["device"])), ...errorResponses(401, 403, 404) }, { parameters: [pathParameter("id")], ...(action === "activate" ? { deprecated: true } : {}) }));
}
add("/api/devices/{id}", OpenAPIV3_1.HttpMethods.PATCH, op("renameDevice", "Devices", "Rename a device", { 200: json(object({ device: ref("Device") }, ["device"])), ...errorResponses(400, 401, 403, 404) }, { parameters: [pathParameter("id")], requestBody: body(object({ label: { type: "string", minLength: 1, maxLength: 100 } }, ["label"])) }));
add("/api/devices/{id}/reset-policy", OpenAPIV3_1.HttpMethods.POST, op("setDeviceResetPolicy", "Devices", "Set how thoroughly a device resets before each job", { 200: json(object({ device: ref("Device") }, ["device"])), ...errorResponses(400, 401, 403, 404, 503) }, { parameters: [pathParameter("id")], requestBody: body(object({ resetPolicy: { type: "string", enum: ["app-only", "app-and-browser"] } }, ["resetPolicy"])) }));
add("/api/devices/{id}", OpenAPIV3_1.HttpMethods.DELETE, op("deleteDevice", "Devices", "Remove a device", { 204: empty("Device removed"), ...errorResponses(401, 403, 404, 409) }, { parameters: [pathParameter("id")] }));
add("/api/devices/{id}/events", OpenAPIV3_1.HttpMethods.GET, op("listDeviceEvents", "Devices", "List device events", { 200: json(object({ events: array(ref("DeviceEvent")) }, ["events"])), ...errorResponses(401, 403, 404) }, { parameters: [pathParameter("id"), queryParameter("limit", { type: "integer", minimum: 1, maximum: 100, default: 30 })] }));
add("/api/devices/{id}/reboot", OpenAPIV3_1.HttpMethods.POST, op("rebootDevice", "Devices", "Reboot a device", { 202: json(ref("Ok")), ...errorResponses(401, 403, 404, 409, 502, 503) }, { parameters: [pathParameter("id")] }));
add("/api/devices/{id}/setup-checks/{checkId}/fix", OpenAPIV3_1.HttpMethods.POST, op("fixDeviceSetupCheck", "Devices", "Apply a device setup check's fix (admin)", { 200: json(object({ check: object({ id: { type: "string" }, title: { type: "string" }, detail: { type: "string" }, ok: { type: "boolean" } }, ["id", "title", "detail", "ok"]) }, ["check"])), ...errorResponses(401, 403, 404, 409, 502, 503) }, { parameters: [pathParameter("id"), pathParameter("checkId")] }));
add("/api/devices/{id}/screenshot", OpenAPIV3_1.HttpMethods.GET, op("captureDeviceScreenshot", "Devices", "Capture a live screenshot", { 200: { description: "PNG screenshot", content: { "image/png": { schema: { type: "string", format: "binary" } } } }, ...errorResponses(401, 403, 404, 502, 503) }, { parameters: [pathParameter("id")] }));
add("/api/version", OpenAPIV3_1.HttpMethods.GET, { ...op("getVersion", "Devices", "Get DeviceYard and Maestro versions", { 200: json(object({ version: { type: "string" }, maestroVersion: { type: "string" }, maestroPending: { type: "boolean" } }, ["version", "maestroVersion"])), ...errorResponses(401, 403) }), parameters: [{ name: "waitForMaestro", in: "query", schema: { type: "boolean", default: true }, description: "Set false to return immediately while the Maestro version is checked in the background. Poll until maestroPending is false. Results are cached for five minutes." }] });
add("/api/mcp-client", OpenAPIV3_1.HttpMethods.GET, op("downloadMcpClient", "MCP", "Download the bundled MCP client", { 200: { description: "ES module", content: { "text/javascript": { schema: { type: "string" } } } }, ...errorResponses(401, 403, 503) }));

export function buildOpenApiDocument(version = readVersion()): OpenAPIV3_1.Document {
  return {
    openapi: "3.1.0",
    info: {
      title: "DeviceYard HTTP API",
      version,
      description: "HTTP API exposed by this DeviceYard instance. Timestamps are epoch milliseconds.",
    },
    tags: ["OpenAPI", "CI", "Session", "Identity", "Account actions", "Organisations", "Jobs", "Files", "Devices", "Notifications", "Administration", "MCP"].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Organisation or personal access token. Personal tokens also require X-Org-Id." },
        orgTokenQuery: { type: "apiKey", in: "query", name: "token", description: "Organisation-token fallback for clients that cannot set headers." },
        sessionCookie: { type: "apiKey", in: "cookie", name: "mobile_farm_session" },
      },
      schemas,
    },
  } as OpenAPIV3_1.Document;
}
