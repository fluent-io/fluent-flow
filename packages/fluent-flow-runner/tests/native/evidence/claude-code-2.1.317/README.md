# Claude Code 2.1.317 evidence

[Evidence index](../README.md)

One sanitized JSON file per probe (`C2.json` … `C12.json`), written by `../../harness/evidence.js` during `npm run test:native`. C1 records nothing beyond the version assertion. See the index for what each file shows.

`T5-interrupt-race.json` is written by `../../claude-backend.native.test.js` (Task 5). It records an interrupt sent in the same tick as the prompt line, before any lifecycle for that prompt was read: the native's own result fields (`subtype`, `is_error`, `terminal_reason`; `aborted_streaming` for this abort), the outcome FF settled for the prompt, the interrupt receipt, the terminal and the model request count. Command ids are replaced with `<prompt>`.

`T10-account-limit-source.md` (Task 10) records, from the pinned program text and its sha256, the 2.1.317 account-quota refusal fields FF maps to `account_limited`, the generic 429 forms it does not, and the watchdog quota wait FF neither enables nor maps.
