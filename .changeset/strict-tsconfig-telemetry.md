---
'@nxgt/telemetry': patch
---

Compiled with the strict base config (`exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `useDefineForClassFields` and the rest). The emitted declarations are unchanged; the JavaScript now declares class fields instead of assigning them in the constructor, with identical behaviour.
