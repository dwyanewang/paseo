import { z } from "zod";
import {
  defineForgeFacts,
  type ClientForgeLogicModule,
  type MergeCapability,
} from "@/git/client-forge-module";
import type { CheckoutPrMergeMethod } from "@getpaseo/protocol/messages";

const CodeupRequirementChecksSchema = z
  .object({
    mergeConflict: z.boolean().nullable().optional().default(null),
    comments: z.boolean().nullable().optional().default(null),
    ci: z.boolean().nullable().optional().default(null),
    reviewerApproved: z.boolean().nullable().optional().default(null),
  })
  .passthrough();

export const CodeupMergeFactsSchema = z
  .object({
    forge: z.literal("codeup"),
    status: z.string().optional().default(""),
    allRequirementsPass: z.boolean().optional().default(false),
    requirementChecks: CodeupRequirementChecksSchema.optional().default({
      mergeConflict: null,
      comments: null,
      ci: null,
      reviewerApproved: null,
    }),
  })
  .passthrough();

export type CodeupMergeFacts = z.infer<typeof CodeupMergeFactsSchema>;

const CODEUP_MERGE_METHODS: CheckoutPrMergeMethod[] = ["merge", "squash", "rebase"];

function deriveCodeupMergeCapability(codeup: CodeupMergeFacts): MergeCapability {
  return {
    directMergeReady:
      codeup.status === "TO_BE_MERGED" &&
      codeup.allRequirementsPass &&
      Object.values(codeup.requirementChecks).every((check) => check !== false),
    canEnableAutoMerge: false,
    autoMergeEnabled: false,
    canDisableAutoMerge: false,
    mergeBlockedByQueue: false,
    allowedMethods: CODEUP_MERGE_METHODS,
    preferredMethod: null,
  };
}

export const codeupForgeLogic = {
  id: "codeup",
  facts: defineForgeFacts({
    family: "codeup",
    schema: CodeupMergeFactsSchema,
    deriveMergeCapability: deriveCodeupMergeCapability,
  }),
} satisfies ClientForgeLogicModule<CodeupMergeFacts>;
