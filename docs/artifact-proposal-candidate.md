# M3b Proposal-to-Artifact candidate boundary

Status: implemented and verified in the Proposal, Agent tool, and Inbox boundaries.

## Decision

An automation Proposal may carry one optional `artifactCandidate` containing
only the closed neutral `ArtifactContent` shape from
[`neutral-artifact-contract.md`](neutral-artifact-contract.md). The field is
optional in the persisted v1 envelope so existing rows remain readable, but
the production `HomeProposalService.createDraft` path requires it for every new
`automation-draft` and rejects it for non-automation proposals.

The candidate is Agent-authored intent under review. It is not an Artifact
revision and contains no artifact ID, source Proposal reference, content hash,
assessment, watermark, risk class, authority candidate, bridge route, native
identifier, approval nonce, compile result, or execution state.

## Hub admission

Before persistence, the Hub must:

1. validate the complete candidate with the one neutral Artifact schema and
   its resource budgets;
2. resolve every trigger, condition, action, rollback, and postcondition
   capability reference against the selected current HomeWorld devices;
3. require every referenced capability to be covered by the Proposal's
   Hub-produced current or temporal evidence selection;
4. reject safety-sensitive target families and unknown/stale selected devices;
5. preserve the candidate exactly in the reviewed Proposal revision; it may
   not silently normalize, enrich, or substitute a target after review.

Device names and ecosystem payloads remain untrusted input and never enter the
candidate. Schema compatibility and action authority are deliberately not
inferred from a semantic label; M3c compiler and Hub-owned authority assessment
must still prove them later.

## Review and production

The Inbox renders the candidate's exact trigger, conditions, actions,
rollback, and postconditions before accepting a household decision. It clearly
states that approval records the reviewed intent only and cannot install,
enable, or execute anything.

After an exact automation Proposal revision is approved, a future Hub-owned
producer may consume it only through `withApprovedProposalAtRevision`. The
producer supplies the Hub-generated artifact ID and timestamps, copies the
approved title/summary/content without reinterpretation, creates revision one,
and appends fresh Hub evidence/risk/authority assessments separately. The Agent,
Inbox, Skill, bridge, and plugin surfaces receive no Registry mutation method.

## Acceptance gates

- Legacy Proposal rows without a candidate remain readable but cannot become
  Artifact sources.
- New production automation drafts without a candidate fail closed.
- Non-automation proposals carrying a candidate fail closed.
- Unknown, unselected, stale, or evidence-uncovered capability references fail
  before Proposal persistence.
- Candidate mutation changes the Proposal revision under review; an approval
  of another revision cannot authorize it.
- Inbox output escapes all untrusted text and exposes no native ecosystem
  identifier or action button.
- Creating or approving a Proposal performs zero Registry or device writes.
