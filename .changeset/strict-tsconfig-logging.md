---
'@nxgt/telemetry-logging': patch
---

`TelemetryTransport.level` is now declared `readonly level?: string` rather than `readonly level: string | undefined`, so the class is assignable to winston's `TransportStream` for a consumer compiled with `exactOptionalPropertyTypes`. Reading it is unchanged. The package is now compiled with the strict base config (`exactOptionalPropertyTypes`, `useDefineForClassFields` and the rest); class fields are emitted as declarations, with identical behaviour.
