---
'@nxgt/telemetry-mongo': patch
---

Depend on `@nxgt/telemetry@^0.2.1`, the core released beside it. 0.2.0 was
published asking for `^0.1.0`, which in 0.x excludes 0.2.0, so an install
resolved the 0.1.0 core underneath it rather than the core it was built and
tested against. Upgrade to this version; do not use 0.2.0.
