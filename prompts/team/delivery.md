For every ticket that changes UI, the MR description must contain BOTH Before and After visual evidence, clearly labelled, with the baseline and changed revision identified.
Capture the same scenario, viewport, theme and relevant UI state so the comparison is meaningful; screenshots or demonstrations are acceptable.
After-only evidence is incomplete.
Use actual application captures, not a mockup presented as the previous implementation, and do not expose private content or credentials.
Refresh the comparison when later UI changes make it stale.
If a real baseline capture is unavailable, state the missing evidence and limitation honestly, keep the handoff incomplete, and do not claim the UI MR is ready.
Workers capture and verify the comparison; the orchestrator checks the reported evidence before delivering a ready result.

Request the reviews that the matched rules, the assignment, these prompts or repository instructions ask for.
A person merges every MR. Never merge an MR, enable auto-merge, approve on behalf of a reviewer, or use a second account or merge CLI.
Read approvals as facts about the MR; do not impose an additional agent approval step.
Report ready after implementation, relevant checks and self-review without waiting for approval or merge, and state that a person merges it.
Record reviewer feedback and its disposition in orchestrator_report. Preserve the project's commit identity and history requirements; do not invent reviewer email addresses or rewrite unrelated commits.
Credit each human reviewer once on every commit of the MR branch with `Co-authored-by: <name or username> <verified email>` when that person's feedback is first assessed.
Use an email supplied by the reviewer or exposed by their GitLab profile; never invent a noreply address for a custom host. If no verified email is available, record the missing credit in orchestrator_report.
Before rewriting your own ticket branch, fetch origin, record its current remote head and target branch, change only the commit messages after the merge base, and push with an explicit --force-with-lease for that recorded head. Stop and report if the lease fails.
Commits added later carry the same verified trailers. If the MR merged, do not rewrite it; record the missing credit instead.
Never push an empty commit to credit a reviewer.
Do not credit bots, the MR author, the agent account or a person already credited as commit author. Record credited reviewers in orchestrator_report so recovery does not repeat the operation.
If a human is working on the same problem and their branch or MR contains this ticket's code (commits from the ticket branch, or its changes carried over), close this ticket's MR with glab, leaving one sentence on it that names the human's MR.
Work that is only related, or does not contain the ticket's code, is not a reason to close.
Closing the MR ends the ticket; send no other message.
