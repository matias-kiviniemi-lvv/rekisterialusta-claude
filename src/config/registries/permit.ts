/**
 * Permit registry — declarative config (config-as-code).
 * The same registry that earlier phases hardcoded, now expressed as data.
 */

import type { RegistryConfig } from "../registry-config.ts";

export const PERMIT_CONFIG: RegistryConfig = {
  registryId: "permit",
  name: "Permit Registry",
  database: "pool-a/permit",
  diary: { registryCode: "PERMIT", numberPadding: 5, separator: "/" },
  version: 1,
  fields: [
    { name: "applicant_name", type: "text", nullable: false },
    { name: "permit_kind", type: "text", nullable: false },
    { name: "site_address", type: "text", nullable: true },
    { name: "fee_paid", type: "boolean", nullable: false },
  ],
  states: [
    { id: "received", name: "Received", isOpen: true, isWaitingForCustomer: false },
    { id: "in_preparation", name: "In preparation", isOpen: true, isWaitingForCustomer: false },
    { id: "waiting_customer", name: "Waiting for customer", isOpen: true, isWaitingForCustomer: true },
    { id: "decided", name: "Decided", isOpen: true, isWaitingForCustomer: false },
    { id: "closed", name: "Closed", isOpen: false, isWaitingForCustomer: false },
  ],
  transitions: [
    ["received", "in_preparation"],
    ["in_preparation", "waiting_customer"],
    ["waiting_customer", "in_preparation"],
    ["in_preparation", "decided"],
    ["decided", "closed"],
  ],
  forms: [
    {
      formId: "update-site-address",
      kind: "case",
      audience: "customer",
      title: "Update site address",
      requiresApproval: true,
      fieldSubset: ["site_address"],
    },
    {
      formId: "submit-document",
      kind: "operation",
      audience: "customer",
      title: "Submit a supporting document",
      operationType: "document",
      allowAttachments: true,
      propertySchema: {
        type: "object",
        properties: { documentTitle: { type: "string" }, pages: { type: "integer" } },
        required: ["documentTitle"],
        additionalProperties: false,
      },
    },
  ],
  rules: [
    { ruleId: "notify-on-waiting", onToState: "waiting_customer", condition: null, actionType: "notify_customer", actionParams: { template: "action_required" } },
    { ruleId: "autoclose-paid-decisions", onToState: "decided", condition: { field: "fee_paid", equals: true }, actionType: "set_state", actionParams: { toState: "closed" } },
  ],
};
