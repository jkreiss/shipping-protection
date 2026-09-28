export async function adminGraphql(admin, query, variables = {}) {
  const response = await admin.graphql(query, { variables });
  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors.map(({ message }) => message).join("; "));
  }
  const searchWarnings = Array.isArray(payload.extensions?.search)
    ? payload.extensions.search.flatMap(({ warnings }) => warnings ?? [])
    : [];
  if (searchWarnings.length) {
    throw new Error(`Shopify search warning: ${searchWarnings.map(({ message }) => message).join("; ")}`);
  }
  if (!payload.data) throw new Error("Shopify returned no GraphQL data.");
  return payload.data;
}

export function assertUserErrors(payload, operation) {
  const errors = payload?.userErrors ?? [];
  if (errors.length) {
    throw new Error(errors.map(({ field, message }) =>
      `${field?.join(".") || operation}: ${message}`).join("; "));
  }
}
