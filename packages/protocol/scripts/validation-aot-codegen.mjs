import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const zodAotRoot = resolve(dirname(require.resolve("zod-aot")), "..");
const emitterPath = resolve(zodAotRoot, "dist/cli/emitter.js");
const discriminatedUnionPath = resolve(
  zodAotRoot,
  "dist/core/codegen/schemas/discriminated-union.js",
);
export const MAX_FUNCTION_BYTES = 1024 * 1024;

function patchSource(source, before, after, label) {
  if (source.includes(after)) return source;
  if (source.split(before).length !== 2) {
    throw new Error(`zod-aot ${label} shape changed; update the protocol compiler patch`);
  }
  return source.replace(before, after);
}

async function ensureSplitContextPatch() {
  const indexPath = resolve(zodAotRoot, "dist/core/codegen/index.js");
  const index = await readFile(indexPath, "utf8");
  const patchedIndex = patchSource(
    index,
    "        preamble: [],",
    "        paseoSplit: options?.paseoSplit,\n        preamble: [],",
    "context",
  );
  const union = await readFile(discriminatedUnionPath, "utf8");
  let patchedUnion = patchSource(
    union,
    "export function slowDiscriminatedUnion(ir, g) {",
    "export function slowDiscriminatedUnion(ir, g) {\n    if (g.ctx.paseoSplit?.target === ir) return g.ctx.paseoSplit.emit(ir, g);",
    "slow union",
  );
  patchedUnion = patchSource(
    patchedUnion,
    "export function fastDiscriminatedUnion(ir, g) {",
    "export function fastDiscriminatedUnion(ir, g) {\n    if (g.ctx.paseoSplit?.target === ir) return null;",
    "fast union",
  );
  if (patchedIndex !== index) await writeFile(indexPath, patchedIndex);
  if (patchedUnion !== union) await writeFile(discriminatedUnionPath, patchedUnion);
}

let compilerPromise;
export function loadValidationCompiler() {
  compilerPromise ??= (async () => {
    const { version } = JSON.parse(await readFile(resolve(zodAotRoot, "package.json"), "utf8"));
    if (version !== "0.20.4") {
      throw new Error(`Unsupported zod-aot ${version}; review protocol patches before upgrading`);
    }
    await ensureZodAotRuntimeImportExtensionPatch();
    await ensureZodAotDiscriminatedUnionOutputPatch();
    await ensureSplitContextPatch();
    const modules = await Promise.all([
      import(pathToFileURL(resolve(zodAotRoot, "dist/discovery.js")).href),
      import(pathToFileURL(resolve(zodAotRoot, "dist/core/extract/index.js")).href),
      import(pathToFileURL(resolve(zodAotRoot, "dist/core/codegen/index.js")).href),
      import(pathToFileURL(emitterPath).href),
      import(pathToFileURL(resolve(zodAotRoot, "dist/core/codegen/context.js")).href),
      import(pathToFileURL(resolve(zodAotRoot, "dist/core/codegen/emit-issue.js")).href),
    ]);
    return Object.assign({}, ...modules);
  })();
  return compilerPromise;
}

function sessionMessageUnion(ir, name) {
  const fail = () => {
    throw new Error(`${name}: expected type=session.message.type discriminated union`);
  };
  if (ir.type !== "discriminatedUnion" || ir.discriminator !== "type") fail();
  const index = ir.mapping.session;
  const session = ir.options[index];
  if (!session || session.type !== "object") fail();
  const target = session.properties.message;
  if (!target || target.type !== "discriminatedUnion" || target.discriminator !== "type") fail();
  const entries = Object.entries(target.mapping);
  if (!entries.length || new Set(entries.map(([, i]) => i)).size !== target.options.length) {
    throw new Error(`${name}: incomplete session.message.type mapping`);
  }
  return target;
}

function splitEmitter(compiler, branches) {
  const { escapeString, hasMutation, invalidType } = compiler;
  return (ir, g) => {
    const table = g.temp("session_dispatch");
    g.ctx.preamble.push(`var ${table}=Object.create(null);`);
    for (const [type, index] of Object.entries(ir.mapping)) {
      const name = g.temp("session_branch");
      // Independent expressions keep generated clones/default writes inside the branch.
      // Shared context retains the original __rf indices, regex cache and enum sets.
      const body = g.visit(ir.options[index], {
        input: "_v",
        output: "_v",
        path: "_p",
        issues: "_e",
      });
      const source = `function ${name}(_v,_e,_p){\n${body}return _v;\n}`;
      branches.push({ type, name });
      g.ctx.preamble.push(source, `${table}[${escapeString(type)}]=${name};`);
    }
    const object = g.temp("session_obj");
    const tag = g.temp("session_tag");
    const branch = g.temp("session_fn");
    const values = Object.keys(ir.mapping).map(escapeString).join(",");
    const discriminator = escapeString(ir.discriminator);
    const propagate = ir.options.some(hasMutation);
    // An indirect call prevents Hermes -O from inlining the entire union again.
    // Restrict lookup to strings: a switch does not coerce numeric/object tags.
    return `if(typeof ${g.input}!=="object"||${g.input}===null||Array.isArray(${g.input})){
${invalidType(g, "object")}
}else{
var ${object}=${g.input};
var ${tag}=${object}[${discriminator}];
var ${branch}=typeof ${tag}==="string"?${table}[${tag}]:undefined;
if(${branch}){
${object}=${branch}(${object},${g.issues},${g.path});
${propagate ? `${g.output}=${object};` : ""}
}else{
${g.issues}.push({code:"invalid_union",errors:[],note:"No matching discriminator",discriminator:${discriminator},options:[${values}],input:${g.input},path:${g.path}.concat(${discriminator})});
}
}\n`;
  };
}

// Count each function's own source, excluding nested function bodies. The module
// IIFE contains all branch declarations but Hermes optimizes their bodies separately.
export function checkFunctionBudget(source, branches, maxBytes = MAX_FUNCTION_BYTES) {
  // Check the formatted JavaScript consumed by Metro, not compact emitter text.
  source = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const ast = ts.createSourceFile("validator.ts", source, ts.ScriptTarget.Latest, true);
  if (ast.parseDiagnostics.length) throw new Error("zod-aot generated invalid validator syntax");
  const functions = [];
  const branchTypes = new Map(branches.map((branch) => [branch.name, branch.type]));
  function visit(node, parentFunction) {
    let current = parentFunction;
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    ) {
      const start = node.getStart(ast);
      const end = node.end;
      if (parentFunction) parentFunction.nested.push([start, end]);
      current = { name: node.name?.text ?? "<anonymous>", start, end, nested: [] };
      functions.push(current);
    }
    ts.forEachChild(node, (child) => visit(child, current));
  }
  visit(ast);
  const sizes = functions.map(({ name, start, end, nested }) => {
    let bytes = Buffer.byteLength(source.slice(start, end));
    for (const [a, b] of nested) bytes -= Buffer.byteLength(source.slice(a, b));
    return { name, type: branchTypes.get(name), bytes };
  });
  for (const fn of sizes) {
    if (fn.bytes > maxBytes) {
      throw new Error(
        `session.message.type ${fn.type ?? fn.name}: function ${fn.bytes} bytes exceeds ${maxBytes}; split its schema before building`,
      );
    }
  }
  return sizes.sort((a, b) => b.bytes - a.bytes);
}

export function compileSplitSchemas(
  schemas,
  compiler,
  { maxFunctionBytes = MAX_FUNCTION_BYTES } = {},
) {
  const compiled = [];
  const summaries = [];
  for (const { schema, exportName } of schemas) {
    const refEntries = [];
    const ir = compiler.extractSchema(schema, refEntries);
    const branches = [];
    const target = sessionMessageUnion(ir, exportName);
    const codegenResult = compiler.generateValidator(ir, exportName, {
      mode: "inline",
      refCount: refEntries.length,
      paseoSplit: { target, emit: splitEmitter(compiler, branches) },
    });
    if (branches.length !== Object.keys(target.mapping).length) {
      throw new Error(
        `${exportName}: session.message.type was not split; check compiler context patch`,
      );
    }
    const sizes = checkFunctionBudget(
      `(() => {\n${codegenResult.code}\n${codegenResult.functionDef}\n})()`,
      branches,
      maxFunctionBytes,
    );
    const byName = new Map(sizes.map((fn) => [fn.name, fn.bytes]));
    compiled.push({ exportName, refEntries, codegenResult });
    summaries.push({
      exportName,
      branches: branches.map(({ name, type }) => ({ name, type, bytes: byName.get(name) })),
      entryBytes: byName.get(`safeParse_${exportName}`),
      largestFunction: sizes[0],
    });
  }
  return { compiled, summaries };
}

async function ensureZodAotRuntimeImportExtensionPatch() {
  const emitter = await readFile(emitterPath, "utf8");
  if (emitter.includes('sourceRelPath.endsWith(".js")')) {
    return;
  }

  const before = 'let importPath = sourceRelPath.replace(/\\.[cm]?[jt]sx?$/, "");';
  const after =
    'let importPath = sourceRelPath.endsWith(".js")\n        ? sourceRelPath\n        : sourceRelPath.replace(/\\.[cm]?[jt]sx?$/, "");';
  if (!emitter.includes(before)) {
    throw new Error("zod-aot emitter shape changed; update the runtime import extension patch");
  }
  await writeFile(emitterPath, emitter.replace(before, after));
}

async function ensureZodAotDiscriminatedUnionOutputPatch() {
  let discriminatedUnionEmitter = await readFile(discriminatedUnionPath, "utf8");
  if (
    discriminatedUnionEmitter.includes(
      "const needsOutputPropagation = ir.options.some(hasMutation);",
    )
  ) {
    return;
  }

  const importBefore = 'import { escapeString } from "../context.js";';
  const importAfter = 'import { escapeString, hasMutation } from "../context.js";';
  const outputFlagBefore = "const discKey = escapeString(ir.discriminator);\n    let code = emit `";
  const outputFlagAfter =
    "const discKey = escapeString(ir.discriminator);\n    const needsOutputPropagation = ir.options.some(hasMutation);\n    let code = emit `";
  const propagationBefore =
    "        ${g.visit(option, { input: objVar, output: objVar })}\n        break;`;";
  const propagationAfter =
    '        ${g.visit(option, { input: objVar, output: objVar })}\n        ${needsOutputPropagation ? `${g.output}=${objVar};` : ""}\n        break;`;';

  if (
    !discriminatedUnionEmitter.includes(importBefore) ||
    !discriminatedUnionEmitter.includes(outputFlagBefore) ||
    !discriminatedUnionEmitter.includes(propagationBefore)
  ) {
    throw new Error("zod-aot discriminated-union emitter shape changed; update the output patch");
  }

  discriminatedUnionEmitter = discriminatedUnionEmitter
    .replace(importBefore, importAfter)
    .replace(outputFlagBefore, outputFlagAfter)
    .replace(propagationBefore, propagationAfter);
  await writeFile(discriminatedUnionPath, discriminatedUnionEmitter);
}
