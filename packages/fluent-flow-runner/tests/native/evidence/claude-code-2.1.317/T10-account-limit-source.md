# Claude Code 2.1.317: account-limit signals (Task 10, source evidence)

[Claude Code 2.1.317 evidence](README.md)

Read from the pinned program only, never auth or home files. Binary: `~/.local/share/claude/versions/2.1.317` (the
target of `~/.local/bin/claude`), sha256 `eb224419e344575faa4a1f39b290b649425a10cd5ee2ef1d003480cd9ae57eb0`. The
snippets below are minified program text found with `strings`; identifiers are the bundle's own short names.

## 1. Terminal refusal (what FF maps)

The 429 mapping produces the synthetic assistant error. The quota branch needs `H = hSn(vt())`
(`function hSn(e){return e||Te()==="gateway"||POt()}`: subscriber, gateway or one more account predicate) and parsed
unified rate-limit headers (`G = fsi(e)`, which returns `{ status: "rejected", rateLimitType, resetsAt, ... }`):

```
if(e instanceof Mt&&e.status===429){let H=hSn(vt()),G=fsi(e),…;if(H&&G&&!ke){let Ae=J5o(G,n);if(Ae)return Us({content:Ae,
error:"rate_limit",…o$i(Ae)&&{apiError:"usage_limit_reached",apiErrorParams:{rate_limit_info:TQn(G)}},…});
return Us({content:jz,error:"rate_limit"})}
…let Me=H?b3o:"Request rejected (429)",…;return Us({content:`${fd}: ${Me} · ${Ee||De}`,error:"rate_limit",apiErrorIsTransient:H})}
```

stream-json carries those fields on the assistant message:

```
error:h.error,…,...h.isApiErrorMessage===!0&&{is_api_error_message:!0},...h.apiError!==void 0&&{api_error:h.apiError},
...h.apiErrorParams!==void 0&&{api_error_params:h.apiErrorParams}
```

So the positive account-quota signal is `error: "rate_limit"` + `api_error: "usage_limit_reached"` +
`api_error_params.rate_limit_info.status: "rejected"`. Every other 429 is a plain `rate_limit` (optionally
`apiErrorIsTransient`), or a credits case (`model_requires_usage_credits`, `long_context_credits_required`). FF maps
only the first to `account_limited` (`src/native/claude-normalize.js`, unit tests in
`tests/unit/native/claude-normalize.test.js`); the others stay `failed`.

With FF's synthetic API-key context (`ANTHROPIC_API_KEY`) the subscriber predicate is false, so the native never takes
this branch in the isolated harness. A native proof needs subscription auth, which is not authorized; this note and
the unit tests are the evidence.

## 2. Quota wait (not mapped)

A retry watchdog can wait through a rejected unified limit instead of failing:

```
if(hn instanceof Mt&&hn.status===429){if(Ws=Jwr(hn,y),Ws!==null&&hn.headers?.get?.("anthropic-ratelimit-unified-status")==="rejected"){
let Wi=(i.CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS??1/0)-ke.usageLimitSpentMs;if(Ws>Wi){…
throw m("api_request","api_request_usage_limit_wait_too_long"),new rf(hn,S);…}fs=hn}}
…if(fs&&!r.signal?.aborted)try{Ei=r.onQuotaWindowWait?.(fs,{retryAtMs:y.now()+Fr,attempt:Es,maxRetries:h})}
```

It sits on the watchdog path (`qs`), configured by the `CLAUDE_CODE_RETRY_WATCHDOG*` variables. `buildNativeEnv`
passes none of them, and FF neither enables nor changes it. The stream-json schema has a `rate_limit_event`
(`function mVs(e,n,s={}){…return{type:"rate_limit_event",rate_limit_info:y,uuid:jo(),session_id:n}}`), built from
the unified rate-limit status mirror. The program text alone does not show that 2.1.317 emits it before such a wait
in `-p` stream-json mode, and FF does not project `rate_limit_event` (the normalizer drops unknown top-level types).
So if a wait happened, it would show only as a long active turn that keeps its slot, with no FF retry and no
fabricated terminal. That is the stated limit.

## 3. Fix round 1: exact enablement and emission

- The wait runs only when `qs` holds: `let qs=kxe()&&BZe(hn)`, where `function kxe(){return i.CLAUDE_CODE_RETRY_WATCHDOG}`
  (the typed environment registry, `CLAUDE_CODE_RETRY_WATCHDOG:()=>GN`) and
  `function BZe(e){return uV(e)||e instanceof Mt&&e.status===429||F5e(e)?.status===529}`. Its usage-limit budget is
  `CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS`.
- FF's `buildNativeEnv` is an allowlist (`INHERITED_ENV_KEYS` plus fixed backend keys) and never sets or passes
  `CLAUDE_CODE_RETRY_WATCHDOG*`. A FF worker can therefore enter the wait only if the owner's own Claude settings for
  that profile's context (a settings `env` entry, which Claude applies to its environment) enable it. FF neither
  enables nor alters that native policy, and its readiness does not inspect it.
- While waiting, the callback (`QI=(bn,jo)=>{…lrr(bn,ds,Se.now(),nb,Z.storageV5),Asi({…retryAtMs:jo.retryAtMs,…})}`)
  records quota status internally (`lrr` → `extractQuotaStatusFromError`, `Asi` → `beginUsageLimitWait`). Nothing in it
  writes stream-json. A `rate_limit_event` is built from the rate-limit status mirror
  (`function PNt(e,n,r){…return mVs(…)}`), and the program text does not prove that the mirror emits one during this
  wait in `-p` stream-json mode.
- FF therefore now keeps any well-formed `rate_limit_event` as nonterminal evidence (`phase: 'rate_limit'`, status and
  limit type only), rather than dropping it, and never treats it as a terminal or a reason to retry. Whether one appears
  before or during a real subscription quota wait is unproven without authorized subscription UAT.
