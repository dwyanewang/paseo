# Protocol Validation

The client validates inbound WebSocket messages with a zod-aot generated validator instead of runtime Zod on the hot path. Zod remains the authoring source of truth for schemas and TypeScript types.

The reason is mobile performance. A captured 353 KB provider snapshot cost about 10.9 ms and 5.9 MB allocated per message for `JSON.parse` plus Zod on Hermes. After moving provider-model normalization out of the schema so zod-aot could compile the hot subtree, the generated validator path measured about 2.5 ms and 1.2 MB allocated.

## Runtime Path

`packages/protocol/src/validation/ws-outbound.ts` is the shipped boundary. It calls the generated `WSOutboundMessageSchema.safeParse` and returns the validated data. It does not normalize, repair, or re-validate the generated result.

Generated validators preserve unknown keys where Zod object parsing strips them. The client dispatch path uses known `type` and payload fields, so this passthrough behavior is accepted for inbound messages. The wire format is unchanged.

Provider model normalization is a parser-side compatibility shim in the client consumers that need it. Newer daemons normalize at the provider registry source.

## Codegen Ownership

The protocol package owns generation.

- `packages/protocol/codegen/ws-outbound.compile.ts` is the build-time zod-aot discovery entry.
- `packages/protocol/scripts/generate-validation-aot.mjs` owns the generation entrypoint. `validation-aot-codegen.mjs` owns the exact-pinned compiler patches and session branch splitting.
- `packages/protocol/scripts/watch-validation-aot.mjs` reruns generation while editing protocol sources.
- `packages/protocol/src/generated/validation/ws-outbound.aot.ts` is generated runtime code and is gitignored.
- `packages/protocol/src/validation/ws-outbound-schema-metadata.ts` is runtime schema metadata for zod-aot fallback/default references.

Generation runs from protocol-owned lifecycle hooks: `prebuild`, `pretypecheck`, `pretest`, and `watch`. Installs do not run generation: published packages consume protocol from prebuilt `dist`, and local build/typecheck/test flows generate the source file at the point it is actually needed.

### Hermes compilation budget

Keep the session message union split when upgrading the compiler. In October 2026, its inline validator produced an approximately 12 MB JavaScript function. Hermes `-O` compilation repeatedly exhausted host memory. Optimization works per function, so splitting the message branches reduces compiler demand while retaining `-O`.

The adapter locates `type=session` and its `message.type` union in the schema IR. Generated temporary names and branch counts are not stable identifiers. A missing target or incomplete mapping must fail generation. Each branch returns its validated output; dropping that writeback loses nested defaults. Reference indices and shared regex/enum helpers must stay in the original compiler context.

The `ws-outbound.compile.ts` discovery entry is dedicated to the outbound envelope validator. Every discovered schema must contain the session message union; adding an unrelated `compile()` export here intentionally fails generation. Give unrelated validators their own generation entry and budget checks rather than silently bypassing splitting in this entry.

Generation enforces a 1 MiB budget per function in the emitted JavaScript. It excludes nested function bodies from their parent's size because Hermes optimizes them separately. When a branch exceeds the budget, split that subtree before raising the limit. The generation log records the discovered branch count, entry size, largest function and output SHA. Repeated generation on the same inputs must produce the same SHA.

The 1 MiB budget is an empirical growth guard, not a Hermes limit or a guarantee about total build memory. The initial prototype's largest branch was about 842 KB; the implemented generator's largest branch is 670,728 bytes, leaving about 36% below this budget. The check measures transpiled module functions including the emitted IIFE indentation, before Metro processes the module. Continue measuring the actual release bundle with Hermes and the whole build phase separately when schemas or the toolchain change.

The patches are specific to zod-aot 0.20.4 and apply before importing its compiler modules. On an upgrade, review the context and union hooks alongside the existing output-propagation and `.js` import patches, then rerun the targeted codegen and outbound-validation tests. A version or emitter-shape mismatch must stop the build.

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

All four bundle tasks succeeded with zero cgroup swap. Each configuration was measured once: the 2.7% map-only difference does not establish a repeatable improvement, and neither module-split sample reduced the peak. None met the 6 GiB target. These experiments were not adopted; retain the function split and existing build settings. The earlier 7.35 GiB result included cold Gradle/plugin work and is a different measurement cohort.

The baseline peak preceded final map serialization and consisted mostly of anonymous process memory (about 6.10 GiB), with about 0.14 GiB of file cache. Skipping the approximately 76.7 MB final map does not skip worker transformations or their intermediate maps. Module splitting changes concurrent worker and serializer allocations, so measure the whole cgroup instead of inferring savings from individual file sizes. Extracted branches must retain shared metadata, regex/enum and error-formatting context; the initial prototype omitted the locale formatter and changed nested union errors before it was corrected.

Verify cache isolation through the configuration Metro actually loads and populated cache stores. In the tested Expo export implementation, accepting `--config` did not mean the path reached Metro initialization; the first warm-cache probe was excluded after its private caches remained absent. The map-off probe appended a second, empty `--sourcemap-output` value, relying on this parser's last-value behavior; artifact checks verified the resulting map absence and bytecode equivalence. Package exports resolve to protocol `dist`, so source-only experiments do not exercise a changed validator in the app. The reproducible scripts, four raw profiles, artifact checks and restoration receipt are retained in the source worktree's `.dev/metro-memory-20261014/` directory. This bundle-stage experiment does not establish APK behavior or Hermes runtime performance.

## Regression Tests

zod-aot is exact-pinned and young enough that compiler patches are treated as part of this package. `packages/protocol/tests/validation/ws-outbound.test.ts` keeps small regression tests for the patched cases:

- discriminated-union branch output must propagate `.default()` fields
- current sequential item routing must accept `tool_call`-like status branches
- generated runtime imports must keep `.js` extensions for packaged Node ESM
- the generated WebSocket envelope accepts a minimal valid message and rejects a corrupted one

`validation-aot-codegen.test.ts` also checks split defaults and input mutation, nested error ordering, shared regex/enum references, new branches, discriminator routing, deterministic output and generation failures. Provider snapshot tests exercise default writeback through the shipped validation boundary. AOT preserves unknown fields, so compare output semantics with the original AOT rather than requiring Zod's object stripping behavior.

## Schema Purity

Message schemas are structural declarations. Do not put `.transform()`, `.catch()`, or `.preprocess()` on WebSocket message schemas. If parsed data needs normalization, put it in an explicit consumer or post-validation pass.

Use `z.discriminatedUnion()` when every branch has a shared literal tag. Plain `z.union()` is acceptable only when there is no shared literal discriminator or when a generated-code regression test proves that specific shape is miscompiled.

Defaults are allowed only on primitive leaves. Do not place `.default()` on large arrays, item schemas, or big containers in inbound message schemas.
