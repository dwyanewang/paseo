import type { ForgeSpecificStatusFacts } from "./forge-service.js";

export interface CodeupRequirementChecks {
  mergeConflict: boolean | null;
  comments: boolean | null;
  ci: boolean | null;
  reviewerApproved: boolean | null;
}

export interface CodeupStatusFacts {
  status: string;
  allRequirementsPass: boolean;
  requirementChecks: CodeupRequirementChecks;
}

export type CodeupForgeSpecificStatusFacts = ForgeSpecificStatusFacts & {
  forge: "codeup";
} & CodeupStatusFacts;

export function isCodeupStatusFacts(
  facts: ForgeSpecificStatusFacts | null | undefined,
): facts is CodeupForgeSpecificStatusFacts {
  return facts?.forge === "codeup";
}

export function isCodeupDirectMergeReady(facts: CodeupStatusFacts): boolean {
  return (
    facts.status === "TO_BE_MERGED" &&
    facts.allRequirementsPass &&
    Object.values(facts.requirementChecks).every((check) => check !== false)
  );
}
