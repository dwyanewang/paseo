# Protocol Validation

The client validates inbound WebSocket messages with a zod-aot generated validator instead of runtime Zod on the hot path. Zod remains the authoring source of truth for schemas and TypeScript types.

The reason is mobile performance. A captured 353 KB provider snapshot cost about 10.9 ms and 5.9 MB allocated per message for `JSON.parse` plus Zod on Hermes. After moving provider-model normalization out of the schema so zod-aot could compile the hot subtree, the generated validator path measured about 2.5 ms and 1.2 MB allocated.

## Runtime Path

`packages/protocol/src/validation/ws-outbound.ts` is the shipped boundary. It validates the envelope with a generated validator that checks only each session message's `type` tag, then runs the generated validator for that one message type and returns the validated data. Issue paths from the message validator, including nested union branches, are prefixed with `message`, so callers see the same issues as when one validator covered the whole envelope. It does not normalize, repair, or re-validate the generated result.

Keep one generated function per message type. zod-aot inlines every nested schema into the function it compiles, so compiling `WSOutboundMessageSchema` as a whole produced one 11 MB function. On V8 (daemon clients, plugin hosts, the CLI, and Electron), the Maglev tier compiled that function once it was hot, allocating about 800 MB and stalling for seconds, and compiled it again after each deoptimization. Hermes has no JIT, so mobile does not have this runtime JIT stall. Its release compilation has a separate function-size cost, described below. `packages/protocol/tests/validation/ws-outbound.test.ts` fails if a generated function grows past 1 MB.

Generated validators preserve unknown keys where Zod object parsing strips them. The client dispatch path uses known `type` and payload fields, so this passthrough behavior is accepted for inbound messages. The wire format is unchanged.

Provider model normalization is a parser-side compatibility shim in the client consumers that need it. Newer daemons normalize at the provider registry source.

## Codegen Ownership

The protocol package owns generation.

- `packages/protocol/src/validation/ws-outbound-envelope.ts` defines the tag-only envelope schema and exposes the session message schemas that get their own validators.
- `packages/protocol/scripts/generate-validation-aot.mjs` writes the zod-aot discovery entry and the runtime schema metadata, runs the exact-pinned compiler, and applies the small local compiler patches before generation. It also emits the `type` → validator map the boundary dispatches through.
- `packages/protocol/scripts/watch-validation-aot.mjs` reruns generation while editing protocol sources.
- `packages/protocol/codegen/generated/ws-outbound.compile.ts`, `packages/protocol/src/generated/validation/ws-outbound.aot.ts`, and `packages/protocol/src/generated/validation/ws-outbound-schema-metadata.ts` are generated and gitignored. The metadata module lets generated code reach schema fallback/default values.

Generation runs from protocol-owned lifecycle hooks: `prebuild`, `pretypecheck`, `pretest`, and `watch`. Installs do not run generation: published packages consume protocol from prebuilt `dist`, and local build/typecheck/test flows generate the source file at the point it is actually needed.

### Hermes compilation budget

The upstream per-message generator replaces the earlier local IR adapter that located and split the monolithic `session.message.type` union. Do not feed its per-message discovery entry to `compileSplitSchemas`: each export now represents one message, not the whole union. The retained adapter and its fixtures provide regression coverage for the historical compiler hooks; production generation uses upstream `compileSchemas` and the shared `checkFunctionBudget` only.

In October 2026 the old inline validator produced an approximately 12 MB JavaScript function, and Hermes `-O` release compilation repeatedly exhausted host memory. Optimization works per function. Preserve one generated validator per message and keep `-O` enabled. Generation checks the complete emitted module before writing it and enforces a 1 MiB budget per function, excluding nested function bodies because Hermes optimizes them separately. When a message exceeds the budget, split its schema subtree before raising the limit.

The generation log records the message count, total bytes, largest function and output SHA. Identical inputs must produce the same SHA. This budget is an empirical growth guard, not a Hermes limit or a guarantee about total build memory. The historical adapter's largest function was 670,728 bytes; that figure is not a measurement of the current per-message generator. The guard measures transpiled JavaScript before Metro processes it. Continue measuring the release bundle and the whole build phase separately when schemas or the toolchain change.

The compiler is exact-pinned to zod-aot 0.20.4. Production generation retains the `.js` import and discriminated-union output-propagation patches. On upgrades, review emitter shapes and rerun outbound-validation and codegen tests; historical adapter fixtures also require their context/union hooks to match.

Measure a fixed Android release JavaScript bundle with the compiler used by React Native:

```bash
npm run benchmark:hermes --workspace=@getpaseo/protocol -- \
  --bundle /absolute/path/index.android.js \
  --out /absolute/path/new-hermes-results \
  --cache-note 'Android dev=false minify=false; Metro cold; fixed compiler input'
```

This Linux command runs three independent `-O` compilations and records compiler/input hashes, versions, maximum process RSS, elapsed time and bytecode size. Use a new output directory each time. The cache note describes how you produced the input; the runner does not clear Metro caches. Compare process RSS with process RSS. Full Gradle/Metro/Hermes cgroup peaks include other processes and file cache, and need their own measurement. Compiler timings do not establish runtime performance: provider snapshots, streams and timeline payloads still need a warmed Android Hermes comparison and APK smoke validation.

### Metro memory follow-up

Splitting functions addresses Hermes's per-function optimization cost; splitting those functions into separate files does not guarantee a lower Metro peak. A 2026-10-14 screening experiment on `60337b9b6` compared four configurations with the function split already present. Each used a fresh dedicated Metro transform cache, Node 22.22.3, eight Metro workers, one Gradle worker, warm Gradle caches and Hermes `-O`. The configured file-map cache directories were absent and each run logged an `ENOENT` cache-write error; file-map snapshots remained cold and were not populated. This shared limitation must be included when interpreting or repeating the experiment:

| Configuration                                                              | Full Gradle/Metro/Hermes cgroup peak |
| -------------------------------------------------------------------------- | ------------------------------------ |
| Function split, one source module, final Metro Source Map enabled          | 6.41 GiB                             |
| Same, final Metro Source Map disabled                                      | 6.24 GiB                             |
| Branches distributed across 20 modules plus one shared module, map enabled | 7.06 GiB                             |
| Same module split, map disabled                                            | 6.95 GiB                             |

All four bundle tasks succeeded with zero cgroup swap. Each configuration was measured once: the 2.7% map-only difference does not establish a repeatable improvement, and neither module-split sample reduced the peak. None met the 6 GiB target. These experiments were not adopted. They predate the upstream per-message generator; keep that generator and the existing build settings, and measure its bundle separately. The earlier 7.35 GiB result included cold Gradle/plugin work and is a different measurement cohort.

The baseline peak preceded final map serialization and consisted mostly of anonymous process memory (about 6.10 GiB), with about 0.14 GiB of file cache. Skipping the approximately 76.7 MB final map does not skip worker transformations or their intermediate maps. Module splitting changes concurrent worker and serializer allocations, so measure the whole cgroup instead of inferring savings from individual file sizes. Extracted branches must retain shared metadata, regex/enum and error-formatting context; the initial prototype omitted the locale formatter and changed nested union errors before it was corrected.

Verify cache isolation through the configuration Metro actually loads and populated cache stores. In the tested Expo export implementation, accepting `--config` did not mean the path reached Metro initialization; the first warm-cache probe was excluded after its private caches remained absent. The map-off probe appended a second, empty `--sourcemap-output` value, relying on this parser's last-value behavior; artifact checks verified the resulting map absence and bytecode equivalence. Package exports resolve to protocol `dist`, so source-only experiments do not exercise a changed validator in the app. The reproducible scripts, four raw profiles, artifact checks and restoration receipt are retained in the source worktree's `.dev/metro-memory-20261014/` directory. This bundle-stage experiment does not establish APK behavior or Hermes runtime performance.

## Regression Tests

zod-aot is exact-pinned and young enough that compiler patches are treated as part of this package. `packages/protocol/tests/validation/ws-outbound.test.ts` keeps small regression tests for the patched cases:

- discriminated-union branch output must propagate `.default()` fields
- current sequential item routing must accept `tool_call`-like status branches
- generated runtime imports must keep `.js` extensions for packaged Node ESM
- the generated WebSocket envelope accepts a minimal valid message and rejects a corrupted one

`validation-aot-codegen.test.ts` checks the retained adapter fixtures for split defaults, input mutation, nested error ordering, shared helpers, discriminator routing, deterministic output and generation failures. Production outbound tests exercise the per-message dispatch, issue paths, defaults and function-size limit. AOT preserves unknown fields, so compare output semantics with the original AOT rather than requiring Zod object stripping.

## Schema Purity

Message schemas are structural declarations. Do not put `.transform()`, `.catch()`, or `.preprocess()` on WebSocket message schemas. If parsed data needs normalization, put it in an explicit consumer or post-validation pass.

Use `z.discriminatedUnion()` when every branch has a shared literal tag. Plain `z.union()` is acceptable only when there is no shared literal discriminator or when a generated-code regression test proves that specific shape is miscompiled.

Defaults are allowed only on primitive leaves. Do not place `.default()` on large arrays, item schemas, or big containers in inbound message schemas.
