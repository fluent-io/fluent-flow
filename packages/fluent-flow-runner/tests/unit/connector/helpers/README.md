# External SDK fixture

[Connector tests](../README.md)

`fake-paseo.js` implements the pinned public SDK's workspace, agent, timeline and permission boundary for tests. It validates workspace creation, agent UUIDs, timeline requests, sends and permission replies using the actual pinned `@getpaseo/protocol@0.12.0` schemas. The journal, executor, HTTP control plane and database remain real in the composition suite. The fixture accepts only SDK permission behavior `allow` or `deny` and requires a current pending request.
