---
'@nxgt/telemetry-hono': patch
---

Fix the README's opening example, which dropped the promise `close()` returns
on `SIGTERM` and so could lose the last batch. It now awaits it.
