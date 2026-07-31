# Workline Dashboard

Independent React/Vite operations UI for Background Jobs Framework.

## Development

Start the backend on port 3000, then:

~~~bash
npm install
npm run dev
~~~

Vite proxies `/api` and `/health` to the backend, avoiding a development CORS dependency.

## Build and test

~~~bash
npm test
npm run build
~~~

The production bundle is written to `dashboard/dist`. Keep it on the same origin as the API where possible. Cross-origin deployments must set `VITE_API_BASE_URL` and include that exact origin in the backend `CORS_ALLOWED_ORIGINS` list.

Set `VITE_API_BASE_URL` at build time only when the API is intentionally hosted on another origin.

The dashboard never stores session or API tokens in browser storage. Login uses the backend's `HttpOnly` session cookie, mutating requests attach the CSRF cookie value as `X-CSRF-Token`, and live execution streams send the same credentials. Viewer, operator, and admin roles determine which controls are shown. Administrators can manage users, roles, encrypted-secret metadata, rotations, and audit history from the Security panel.
