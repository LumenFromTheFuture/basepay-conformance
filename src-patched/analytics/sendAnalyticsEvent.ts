// HARNESS-SIDE SUBSTITUTION (documented in PROVENANCE.md)
// Upstream sendAnalyticsEvent POSTs to Coinbase's telemetry endpoint on every
// action invocation. The conformance fixture must not phone out; the event
// surface (called by the verbatim decorator wrapper) is preserved as a no-op.
export async function sendAnalyticsEvent(_event: Record<string, unknown>): Promise<void> {
  // no-op: analytics is out of scope for the conformance target
}
