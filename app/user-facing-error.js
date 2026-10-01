// An error whose message is written for merchants and safe to show in the
// Admin. Any other error's message may contain Shopify or database details, so
// routes show a generic message for it and report it instead.
export class UserFacingError extends Error {
  name = "UserFacingError";
}
