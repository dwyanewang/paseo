import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  loadValidationCompiler,
  compileSplitSchemas,
} from "../../scripts/validation-aot-codegen.mjs";

function envelope(message: z.ZodType) {
  return z.discriminatedUnion("type", [
    z.object({ type: z.literal("pong") }),
    z.object({ type: z.literal("session"), message }),
  ]);
}

function validator(
  result: {
    refEntries: { accessPath: string }[];
    codegenResult: { code: string; functionDef: string };
  },
  schema: z.ZodType,
) {
  const references = result.refEntries.map(({ accessPath }) =>
    new Function("schema", `return schema${accessPath}`)(schema),
  );
  return new Function(
    "__rf",
    "__fin",
    `${result.codegenResult.code}\nreturn ${result.codegenResult.functionDef};`,
  )(references, (issues: unknown[], data: unknown) =>
    issues.length ? { success: false, issues } : { success: true, data },
  );
}

function legacyValidator(
  schema: z.ZodType,
  compiler: Awaited<ReturnType<typeof loadValidationCompiler>>,
) {
  const refEntries: { accessPath: string }[] = [];
  const ir = compiler.extractSchema(schema, refEntries);
  return validator(
    {
      refEntries,
      codegenResult: compiler.generateValidator(ir, "Schema", {
        mode: "inline",
        refCount: refEntries.length,
      }),
    },
    schema,
  );
}

describe("split session validator code generation", () => {
  it("writes branch defaults back without mutating inputs or dropping unknown keys", async () => {
    const compiler = await loadValidationCompiler();
    const schema = envelope(
      z.discriminatedUnion("type", [
        z.object({
          type: z.literal("snapshot"),
          payload: z.object({
            entries: z.array(z.object({ enabled: z.boolean().default(true) })),
          }),
        }),
        z.object({ type: z.literal("ping"), label: z.string() }),
      ]),
    );
    const { compiled, summaries } = compileSplitSchemas(
      [{ exportName: "Schema", schema }],
      compiler,
    );
    const parse = validator(compiled[0], schema);
    const input = {
      type: "session",
      extra: "envelope",
      message: {
        type: "snapshot",
        extra: "message",
        payload: { entries: [{ extra: "entry" }, { enabled: false }] },
      },
    };
    expect(parse(input)).toEqual({
      success: true,
      data: {
        ...input,
        message: {
          ...input.message,
          payload: { entries: [{ extra: "entry", enabled: true }, { enabled: false }] },
        },
      },
    });
    expect(input.message.payload.entries).toEqual([{ extra: "entry" }, { enabled: false }]);
    expect(summaries[0].branches.map(({ type }: { type: string }) => type)).toEqual([
      "snapshot",
      "ping",
    ]);
  });

  it("preserves nested array error paths and error ordering against the original AOT", async () => {
    const compiler = await loadValidationCompiler();
    const schema = envelope(
      z.discriminatedUnion("type", [
        z.object({
          type: z.literal("snapshot"),
          payload: z.object({
            entries: z.array(
              z.object({
                enabled: z.boolean().default(true),
                label: z.string().regex(/^ok/),
                kind: z.enum(["a", "b", "c", "d", "e"]),
              }),
            ),
          }),
        }),
        z.object({ type: z.literal("ping"), value: z.string() }),
      ]),
    );
    const { compiled } = compileSplitSchemas([{ exportName: "Schema", schema }], compiler);
    const parse = validator(compiled[0], schema);
    const original = legacyValidator(schema, compiler);
    const input = {
      type: "session",
      message: {
        type: "snapshot",
        payload: {
          entries: [
            { enabled: "bad", label: 4, kind: "bad" },
            { label: "wrong", kind: "a" },
          ],
        },
      },
    };
    expect(parse(structuredClone(input))).toEqual(original(structuredClone(input)));
    expect(
      parse(input).issues.map(({ code, path }: { code: string; path: unknown[] }) => ({
        code,
        path,
      })),
    ).toEqual([
      { code: "invalid_type", path: ["message", "payload", "entries", 0, "enabled"] },
      { code: "invalid_type", path: ["message", "payload", "entries", 0, "label"] },
      { code: "invalid_value", path: ["message", "payload", "entries", 0, "kind"] },
      { code: "invalid_format", path: ["message", "payload", "entries", 1, "label"] },
    ]);
    const valid = {
      type: "session",
      message: { type: "snapshot", payload: { entries: [{ label: "okay", kind: "e" }] } },
    };
    expect(parse(structuredClone(valid))).toEqual(original(structuredClone(valid)));
  });

  it("splits pure schemas too, discovers new branches, and generates deterministically", async () => {
    const compiler = await loadValidationCompiler();
    const first = z.object({ type: z.literal("first"), label: z.string() });
    const added = z.object({ type: z.literal("added"), value: z.number() });
    const schema = envelope(z.discriminatedUnion("type", [first, added]));
    const sources = [{ exportName: "RenamedSchema", schema }];
    const a = compileSplitSchemas(sources, compiler);
    const b = compileSplitSchemas(sources, compiler);
    expect(a).toEqual(b);
    expect(a.summaries[0].branches.map(({ type }: { type: string }) => type)).toEqual([
      "first",
      "added",
    ]);
    const input = { type: "session", message: { type: "added", value: 3 } };
    expect(validator(a.compiled[0], schema)(input)).toEqual({ success: true, data: input });
  });

  it("matches switch behavior for unknown, prototype, and non-string discriminators", async () => {
    const compiler = await loadValidationCompiler();
    const schema = envelope(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("ping"), enabled: z.boolean().default(true) }),
        z.object({ type: z.literal("constructor"), value: z.string() }),
      ]),
    );
    const { compiled } = compileSplitSchemas([{ exportName: "Schema", schema }], compiler);
    const parse = validator(compiled[0], schema);
    const original = legacyValidator(schema, compiler);
    const valid = { type: "session", message: { type: "constructor", value: "valid" } };
    expect(parse(valid)).toEqual({ success: true, data: valid });
    for (const message of [
      null,
      [],
      {},
      { type: "missing" },
      { type: "toString" },
      { type: "__proto__" },
      { type: 0 },
      { type: ["ping"] },
    ]) {
      const input = { type: "session", message };
      expect(parse(input)).toEqual(original(input));
      expect(parse(input).success).toBe(false);
    }
  });

  it("fails generation with the offending message when a function exceeds its budget", async () => {
    const compiler = await loadValidationCompiler();
    const fields = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`field${i}`, z.string().default("value")]),
    );
    const schema = envelope(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("large"), ...fields }),
        z.object({ type: z.literal("small") }),
      ]),
    );
    expect(() =>
      compileSplitSchemas([{ exportName: "Schema", schema }], compiler, { maxFunctionBytes: 2000 }),
    ).toThrow(/session.message.type large: function \d+ bytes exceeds 2000/);
  });

  it("fails clearly instead of silently reverting to an inline union after schema changes", async () => {
    const compiler = await loadValidationCompiler();
    expect(() =>
      compileSplitSchemas(
        [{ exportName: "Schema", schema: envelope(z.object({ type: z.literal("ping") })) }],
        compiler,
      ),
    ).toThrow("expected type=session.message.type discriminated union");
  });
});
