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

The production bundle is written to `dashboard/dist`. Keep it on the same origin as the API until cross-origin access is explicitly configured alongside authentication.

Set `VITE_API_BASE_URL` at build time only when the API is intentionally hosted on another origin.
