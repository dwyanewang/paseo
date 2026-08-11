import type { QueryClient } from "@tanstack/react-query";
import type { CheckoutStatusResponse, CheckoutStatusUpdate } from "@getpaseo/protocol/messages";
import equal from "fast-deep-equal/es6";
import {
  checkoutCommitsQueryKey,
  checkoutPrStatusQueryKey,
  checkoutStatusQueryKey,
  invalidatePrPaneTimelineForCheckout,
} from "@/git/query-keys";
import { invalidateDraftAgentCommandsForCwd } from "@/hooks/agent-commands-query";
import { type CheckoutPrStatusPayload, normalizeCheckoutPrStatusPayload } from "@/git/pr-status";
import { expireStaleDiffModeOverrides } from "@/review/store";

export type CheckoutStatusPayload = CheckoutStatusResponse["payload"];
export type { CheckoutPrStatusPayload } from "@/git/pr-status";

export interface CheckoutStatusClient {
  getCheckoutStatus: (cwd: string) => Promise<CheckoutStatusPayload>;
}

// Checkout status enters the app through exactly two doors: daemon pushes
// (applyCheckoutStatusUpdateFromEvent) and query fetches (fetchCheckoutStatus). Both run
// the dirty-state reactions, so they hold regardless of which screens are mounted.

export async function fetchCheckoutStatus({
  client,
  serverId,
  cwd,
}: {
  client: CheckoutStatusClient;
  serverId: string;
  cwd: string;
}): Promise<CheckoutStatusPayload> {
  const payload = await client.getCheckoutStatus(cwd);
  expireStaleDiffModeOverrides({ serverId, cwd, isDirty: payload.isGit && payload.isDirty });
  return payload;
}

export async function ensureCheckoutStatus({
  queryClient,
  client,
  serverId,
  cwd,
}: {
  queryClient: QueryClient;
  client: CheckoutStatusClient;
  serverId: string;
  cwd: string;
}): Promise<CheckoutStatusPayload> {
  return await queryClient.fetchQuery({
    queryKey: checkoutStatusQueryKey(serverId, cwd),
    queryFn: () => fetchCheckoutStatus({ client, serverId, cwd }),
    staleTime: Infinity,
  });
}

export function applyCheckoutStatusUpdateFromEvent({
  queryClient,
  serverId,
  message,
}: {
  queryClient: QueryClient;
  serverId: string;
  message: CheckoutStatusUpdate;
}): void {
  const { payload } = message;
  const prStatus = payload.prStatus
    ? normalizeCheckoutPrStatusPayload(payload.prStatus)
    : undefined;
  const cachePayload = prStatus ? { ...payload, prStatus } : payload;
  const statusQueryKey = checkoutStatusQueryKey(serverId, payload.cwd);
  const previousStatus = queryClient.getQueryData<CheckoutStatusPayload>(statusQueryKey);
  const checkoutIdentityChanged =
    previousStatus !== undefined &&
    (previousStatus.isGit !== payload.isGit ||
      previousStatus.currentBranch !== payload.currentBranch ||
      previousStatus.headOid !== payload.headOid);
  queryClient.setQueryData(statusQueryKey, cachePayload);
  void queryClient.invalidateQueries({
    queryKey: checkoutCommitsQueryKey(serverId, payload.cwd),
  });
  // Draft command results are long-lived, but project skills are checkout-scoped and an external
  // tool can add or remove an uncommitted one without moving Git identity. Every push therefore
  // marks the cache stale; only an identity change refetches on the spot, so working-tree churn
  // cannot make active autocomplete rediscover skills mid-typing.
  void invalidateDraftAgentCommandsForCwd({
    queryClient,
    serverId,
    cwd: payload.cwd,
    timing: checkoutIdentityChanged ? "now" : "next-open",
  });
  expireStaleDiffModeOverrides({
    serverId,
    cwd: payload.cwd,
    isDirty: payload.isGit && payload.isDirty,
  });

  if (!prStatus) {
    return;
  }

  const previous = queryClient.getQueryData<CheckoutPrStatusPayload>(
    checkoutPrStatusQueryKey(serverId, prStatus.cwd),
  );
  queryClient.setQueryData(checkoutPrStatusQueryKey(serverId, prStatus.cwd), prStatus);

  // The PR activity timeline has no push channel; mark it stale when the pushed PR status
  // meaningfully changed. Active panes refetch immediately, evicted ones on next mount.
  if (hasPrStatusChanged(previous, prStatus)) {
    void invalidatePrPaneTimelineForCheckout(queryClient, { serverId, cwd: prStatus.cwd });
  }
}

// requestId changes on every emission and carries no PR state.
function prStatusWithoutVolatileFields(
  prStatus: CheckoutPrStatusPayload,
): Omit<CheckoutPrStatusPayload, "requestId"> {
  const { requestId: _requestId, ...rest } = prStatus;
  return rest;
}

function hasPrStatusChanged(
  previous: CheckoutPrStatusPayload | undefined,
  next: CheckoutPrStatusPayload,
): boolean {
  if (!previous) {
    return true;
  }
  return !equal(prStatusWithoutVolatileFields(previous), prStatusWithoutVolatileFields(next));
}
