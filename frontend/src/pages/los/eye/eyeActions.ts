// Action shims for the ported Phoenix credit-report panel.
//
// The panel is rendered here verbatim so staff read exactly the report Phoenix
// shows. Its RENDERING needs only the decision detail, which the workspace fetches
// through /api/los/:id/eye-decision. Its ACTIONS are a different matter: send,
// override, rescore, record-outcome and score-history all call /v1/portal/*, which
// answers 401 to the workspace's machine API key. Wiring them to a live call would
// produce buttons that fail at the moment someone relies on them.
//
// They are therefore inert and say so. That is also the correct division of labour:
// overriding or rescoring a credit decision is a Risk action performed in Phoenix,
// not something Sales does from an origination screen. If Risk later needs them
// here, each one needs a machine-auth twin in Phoenix the way the decision detail
// itself got one — see getEyeDecisionDetail in portal_extended_handlers.go.

import { toast } from "sonner";
import type { EyeScoreItem, ShadowScoreResult, SendDecisionBody, DecisionOutcome, DecisionExplanation } from "./eyeTypes";

// Re-exported so the ported panel's import list stays byte-identical to Phoenix's.
export type {
  EyeDecisionDetail, EyeDecisionStatement, EyeScoreItem, FeatureContribution,
  SendDecisionBody, ShadowScoreResult, ScoringRecord, BureauQuery,
  ShapFactor, DecisionOutcome,
} from "./eyeTypes";

const PHOENIX_ONLY = "This action is performed in Phoenix, not the workspace.";

function unavailable(what: string): never {
  toast.error(`${what} is not available here`, { description: PHOENIX_ONLY });
  throw new Error(`${what} unavailable: portal-only endpoint`);
}

// Score history for the customer. Portal-only, so the panel's history sparkline
// simply stays empty — it already tolerates that (the fetch is .catch()-swallowed).
export async function getScores(_params?: {
  page?: number; per_page?: number; band?: string; customer_id?: string; source?: string;
}): Promise<{ items: EyeScoreItem[]; total: number; page: number; per_page: number }> {
  return { items: [], total: 0, page: 1, per_page: 0 };
}

export async function sendDecisionReport(_id: string, _body: SendDecisionBody): Promise<void> {
  unavailable("Sending the decision notice");
}

export async function overrideDecision(
  _id: string,
  _body: { outcome: DecisionOutcome; reason: string; max_loan_amount_minor?: number },
): Promise<void> {
  unavailable("Overriding the decision");
}

export async function rescoreDecision(_id: string): Promise<void> {
  unavailable("Rescoring");
}

export async function recordOutcome(_scoreId: string, _outcome: string): Promise<void> {
  unavailable("Recording the outcome");
}

export function exportCreditDecisionReport(_detail: unknown): void {
  toast.error("Export is not available here", { description: PHOENIX_ONLY });
}

// ── Hook shims ───────────────────────────────────────────────────────────────
// Phoenix builds these on @tanstack/react-query, which the workspace does not use.
// Rather than pull in a query client for three call sites, these return the exact
// surface the panel consumes: { data } for the query, { mutateAsync, isPending }
// for the mutations.

// Live SHAP attribution — a portal endpoint, and one the panel already treats as
// optional (`explanation && …`), because not every deployment configures an
// explainer. Returning undefined is a state it renders correctly, not a break.
export function useDecisionExplain(_id?: string): { data: DecisionExplanation | undefined } {
  return { data: undefined };
}

export function useShadowScore(): {
  mutateAsync: (scoreId: string) => Promise<ShadowScoreResult>;
  isPending: boolean;
} {
  return { mutateAsync: async () => unavailable("The challenger model"), isPending: false };
}

export function useRecordDecisionExport(): {
  mutateAsync: (args: { id: string; format?: string }) => Promise<void>;
  isPending: boolean;
} {
  return { mutateAsync: async () => unavailable("Export"), isPending: false };
}
