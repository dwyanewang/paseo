#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

function fail(message) {
  console.error(`refresh-expo-router-types: ${message}`);
  process.exit(1);
}

function usage() {
  console.log("Usage: node dwyanewang/refresh-expo-router-types.mjs --root PATH");
}

let rootArgument;
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--root") {
    if (rootArgument !== undefined || index + 1 >= process.argv.length) {
      fail("--root must be specified exactly once with a value");
    }
    rootArgument = process.argv[index + 1];
    index += 1;
  } else if (argument === "--help" || argument === "-h") {
    usage();
    process.exit(0);
  } else {
    fail(`unknown argument: ${argument}`);
  }
}

if (rootArgument === undefined) {
  fail("--root is required");
}

let buildRoot;
try {
  buildRoot = realpathSync(rootArgument);
} catch {
  fail(`root does not exist: ${rootArgument}`);
}

const appRoot = path.join(buildRoot, "packages", "app");
const packagePath = path.join(appRoot, "package.json");
const routerRoot = path.join(appRoot, "src", "app");
if (!existsSync(packagePath) || !existsSync(routerRoot)) {
  console.log("Expo Router types: skipped (packages/app/src/app is absent).");
  process.exit(0);
}

const typesDirectory = path.join(appRoot, ".expo", "types");
const declarationPath = path.join(typesDirectory, "router.d.ts");
mkdirSync(typesDirectory, { recursive: true });
rmSync(declarationPath, { force: true });

process.env.EXPO_ROUTER_APP_ROOT = routerRoot;
const requireFromApp = createRequire(packagePath);
let regenerateDeclarations;
try {
  ({ regenerateDeclarations } = requireFromApp("expo-router/build/typed-routes"));
} catch (error) {
  fail(`could not load expo-router typed-routes generator: ${error.message}`);
}
if (typeof regenerateDeclarations !== "function") {
  fail("expo-router does not export regenerateDeclarations");
}

regenerateDeclarations(typesDirectory);
await new Promise((resolve) => setTimeout(resolve, 1_200));

if (!existsSync(declarationPath)) {
  fail(`generator did not create ${declarationPath}`);
}
const declaration = readFileSync(declarationPath, "utf8");
if (
  !declaration.includes("declare module 'expo-router'") &&
  !declaration.includes('declare module "expo-router"')
) {
  fail(`generated declaration is malformed: ${declarationPath}`);
}

console.log(`Expo Router types: refreshed ${declarationPath}.`);
