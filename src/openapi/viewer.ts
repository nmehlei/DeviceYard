import { getAbsoluteFSPath } from "swagger-ui-dist";

export const swaggerUiAssetPath = getAbsoluteFSPath();

/** A tiny host page around Swagger UI. Assets ship with the runner so the
 * deployed documentation remains usable without access to a public CDN. */
export function renderOpenApiViewer(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>DeviceYard API documentation</title>
    <link rel="icon" href="/favicon.ico">
    <link rel="stylesheet" href="/api-docs/assets/swagger-ui.css">
    <style>
      body { margin: 0; background: #fafafa; }
      .api-header { align-items: center; background: #111827; color: #fff; display: flex; font: 14px system-ui, sans-serif; justify-content: space-between; padding: 12px 24px; }
      .api-header strong { font-size: 16px; }
      .api-header a { color: #bfdbfe; text-decoration: none; }
      .api-header a:hover { text-decoration: underline; }
      .swagger-ui .topbar { display: none; }
    </style>
  </head>
  <body>
    <header class="api-header">
      <strong>DeviceYard API</strong>
      <nav aria-label="API documentation links"><a href="/">Dashboard</a> · <a href="/openapi.json">Raw OpenAPI JSON</a></nav>
    </header>
    <div id="swagger-ui"></div>
    <script src="/api-docs/assets/swagger-ui-bundle.js"></script>
    <script src="/api-docs/assets/swagger-ui-standalone-preset.js"></script>
    <script>
      SwaggerUIBundle({
        url: "/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        displayRequestDuration: true,
        persistAuthorization: false,
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: "StandaloneLayout"
      });
    </script>
  </body>
</html>`;
}
