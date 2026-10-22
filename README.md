# Polymarket market-state dashboard

## Local development with the remote recorder

```sh
bun run dev --host 0.0.0.0
```

The development command opens an SSH tunnel through the `polyviz` alias to the
remote recorder's `127.0.0.1:3001`, waits for its health endpoint, and starts the
local Vite server on port 3000. Open the Network URL printed by Vite from your
phone on the same LAN.

Requests to `/api/recorder/*` go through the local Vite proxy and SSH tunnel.
This uses the server's existing recording history without needing the public
HTTPS site's Basic authentication credentials. SSH must already work with
`ssh polyviz`. Stopping the development command also closes its tunnel.

To use a different SSH alias:

```sh
RECORDER_SSH_HOST=another-host bun run dev --host 0.0.0.0
```

To use a recorder directly, without SSH:

```sh
RECORDER_PROXY_TARGET=http://127.0.0.1:3001 bun run dev --host 0.0.0.0
```
