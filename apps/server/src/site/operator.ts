/** Who runs hosted Glasstrack (glasstrack.dev). Shown in the footer, legal pages and contact page. */
export const OPERATOR = {
  name: "Glasstrack",
  place: "London, United Kingdom",
  email: "transparent-ai-businesses@proton.me",
  /** Published in /.well-known/security.txt and SECURITY.md (forwards to the email above). */
  securityEmail: "security@glasstrack.dev",
  /** Date the terms, privacy policy and DPA were last changed. */
  legalUpdated: "16 October 2026",
} as const;
