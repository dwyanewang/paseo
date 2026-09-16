/**
 * Shared machinery for CLI-backed Forge plugins. `@getpaseo/plugin/server` owns
 * the provider contract; this entry owns what a Forge plugin would otherwise
 * copy out of another one: process execution, CLI error classification, JSON
 * output parsing, remote URL parsing, and pagination guards.
 *
 * Nothing here is vendor-specific. A plugin supplies the binary name, the
 * strings that mean "not signed in", and the command shapes; the toolkit
 * supplies everything between that and the classified errors the daemon reads
 * back to derive auth state.
 */
export {
  createExternalProcessEnv,
  execCommand,
  findExecutable,
  quoteWindowsArgument,
  quoteWindowsCommand,
  runGitCommand,
  shouldUseWindowsShell,
  type ExecCommandOptions,
  type ExecCommandResult,
} from "./forge-toolkit/process.js";
export {
  createCachedCliPathResolver,
  createForgeCliRunner,
  defaultResolveRemoteUrl,
  parseCliJsonOutput,
  redactCommandArgs,
  type CliCommandErrorShape,
  type CreateForgeCliRunnerOptions,
  type ForgeCliRunnerOptions,
  type ForgeCliRunnerResult,
} from "./forge-toolkit/cli.js";
export { parseGitRemoteLocation, type GitRemoteLocation } from "./forge-toolkit/git-remote.js";
export {
  createForgePageGuard,
  type CreateForgePageGuardOptions,
  type ForgePageGuard,
} from "./forge-toolkit/paging.js";
