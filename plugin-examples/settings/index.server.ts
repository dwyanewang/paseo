import type { PluginServerContext } from "@getpaseo/plugin/server";
import { preferences } from "./shared/preferences";
import { incrementPreferenceCount } from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const document = server.registerSettings(preferences);

  // Startup recovery can read the same document before any RPC or lifecycle hook fires.
  void document.read().then((result) => {
    if (result.status === "invalid") {
      console.warn("Settings need explicit recovery", { code: result.error.code });
    }
    return null;
  });

  server.handle(incrementPreferenceCount, ({ amount }) =>
    document
      .update((current) => ({
        status: "commit",
        values: { ...current, count: current.count + amount },
        result: null,
      }))
      .then((result) =>
        result.status === "invalid"
          ? { status: "invalid" as const, code: result.error.code }
          : { status: "saved" as const, count: result.snapshot.values.count },
      ),
  );

  const removeLifecycleListener = server.on("agent.created", async () => {
    await document.update((current) => ({
      status: "commit",
      values: { ...current, count: current.count + 1 },
      result: null,
    }));
  });
  return removeLifecycleListener;
}
