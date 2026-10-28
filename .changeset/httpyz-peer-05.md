---
'@nxgt/telemetry-httpyz': patch
---

Admit `@nxgt/httpyz` 0.4 and 0.5 as the peer: the range is `>=0.3.0 <0.6.0` where it was `^0.3.0`, which a project on 0.4 or 0.5 met as an incorrect-peer warning. The middleware is unchanged and is tested against 0.5.0.
