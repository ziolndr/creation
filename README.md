# CREATION

Deterministic infrastructure for searching, measuring, and
composing biological possibility.

## Render environment

Required:

- `CREATION_BACKEND_URL`
- `CREATION_BACKEND_TOKEN` when the local field requires a token

Optional:

- `CREATION_PROXY_TIMEOUT_MS=120000`

The deployed browser calls the Render service through
`/field/v1/*`. Render proxies those requests to the public
endpoint exposing the locally hosted CREATION field.
