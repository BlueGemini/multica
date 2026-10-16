/** The actionable card of a draft, as opposed to the one-line rows older
 *  revisions collapse to. */
export function liveAgentDraftCardSelector(draftId: string): string {
  return `[data-agent-draft-live="${CSS.escape(draftId)}"]`;
}
