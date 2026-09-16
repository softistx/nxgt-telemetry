---
'@nxgt/telemetry-otlp': patch
---

Depend on `@nxgt/telemetry@^0.2.0`. 0.2.0 was published asking for
`^0.1.0`, which in 0.x excludes 0.2.0, so an install resolved the 0.1.0 core
underneath it — a core without `span`, `createTelemetry` or the logger this
package is built on. Upgrade to this version; do not use 0.2.0.
