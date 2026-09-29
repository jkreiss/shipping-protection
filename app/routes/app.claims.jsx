import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { readClaimsOverview } from "../claims/claims.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  return readClaimsOverview(session.shop);
};

const CLAIM_TYPE_LABELS = { LOST: "Lost", STOLEN: "Stolen", DAMAGED: "Damaged" };
const CLAIM_STATUS = {
  SUBMITTED: ["Submitted", "info"],
  VALIDATING: ["Checking", "info"],
  AUTO_APPROVED: ["Approved", "success"],
  REVIEW_REQUIRED: ["Needs review", "warning"],
  MERCHANT_APPROVED: ["Approved", "success"],
  MERCHANT_REJECTED: ["Rejected", "neutral"],
  RESOLUTION_PENDING: ["Resolving", "info"],
  RESOLVED: ["Resolved", "success"],
};

export default function ClaimsAndReturns() {
  const { claims, claimIntakeEnabled, returnsEnabled } = useLoaderData();

  return (
    <s-page heading="Claims & Returns">
      <s-section heading="Claims">
        {claims.length === 0 ? (
          <s-stack direction="block" gap="small-200" alignItems="center">
            <s-icon type="clipboard-checklist" />
            <s-heading>No claims yet</s-heading>
            <s-paragraph color="subdued">
              {claimIntakeEnabled
                ? "Claims from protected orders will appear here for review."
                : "Claim submission isn't available yet. When it is, claims from protected orders will appear here for review."}
            </s-paragraph>
          </s-stack>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Order</s-table-header>
              <s-table-header listSlot="secondary">Type</s-table-header>
              <s-table-header listSlot="inline">Status</s-table-header>
              <s-table-header listSlot="labeled">Submitted</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {claims.map((claim) => {
                const [label, tone] = CLAIM_STATUS[claim.status] ?? [claim.status, "neutral"];
                return (
                  <s-table-row key={claim.id}>
                    <s-table-cell>
                      <s-link href={`shopify:admin/orders/${claim.shopifyOrderId.split("/").pop()}`}>
                        {claim.orderName}
                      </s-link>
                    </s-table-cell>
                    <s-table-cell>{CLAIM_TYPE_LABELS[claim.type] ?? claim.type}</s-table-cell>
                    <s-table-cell><s-badge tone={tone}>{label}</s-badge></s-table-cell>
                    <s-table-cell>{new Date(claim.submittedAt).toLocaleDateString()}</s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Returns">
        <s-paragraph color="subdued">
          {returnsEnabled
            ? "Returns are turned on for this store."
            : "Returns aren't available yet. Return requests and free-return options will be managed here."}
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
