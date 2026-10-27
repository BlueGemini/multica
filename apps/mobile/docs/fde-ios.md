# Enterprise AI discovery on iOS

This fork adds an Enterprise AI tab to Multica's existing iOS client. Its first
vertical slice is a real discovery conversation, not a simulated employee
deployment system.

## User flow

1. Sign in to the configured Multica backend and select a workspace.
2. Open **Enterprise AI → Start discovery**.
3. Enter the company or initiative name. Industry defaults to biopharmaceuticals
   and messaging to Feishu; both are editable. Other information is optional.
4. Explicitly select a permitted agent with a configured runtime.
5. **Prepare conversation** creates a real chat session. The app opens Chat with
   an editable FDE briefing. Review it and press Send to invoke the agent.
6. Continue using the existing chat attachment, execution status, stop, retry and
   conversation history controls. The Enterprise AI tab lists the five most
   recently updated active workspace conversations.

The briefing asks the agent to lead discovery, request missing evidence, compare
opportunities, propose digital employees and define tests and human ownership.
It does not require the user to predetermine the first employee's job.

## Integration and boundaries

- Reuses mobile-owned query keys, validated session creation, permission helpers,
  runtime binding checks and the existing chat session selection channel.
- Session creation is awaited before navigation. The authoritative session is
  cached before Chat resolves its agent. No message is sent by the intake form.
- A conversation is a discovery record, not an enterprise record or a deployment.
  No new backend endpoint or database table is introduced.
- Recent conversations include ordinary chats. Titles are not a durable type
  marker: the server may generate a semantic title after the first message.
  Archived conversations remain in the existing history UI.
- The form and unsent message are in-memory drafts; closing the app loses them.
  Sent messages use existing backend persistence. The UI discloses this boundary.
- Feishu/DingTalk/WeCom fields describe the company, not installed integrations.
  Attachments reuse chat upload; operation-video understanding and workflow
  execution are not implemented by this change.
- The selected agent's configured permissions and tools remain authoritative.
  A prompt is not an approval engine or a security boundary. Employee onboarding,
  formal approvals, versioned workflows, budgets and business metrics need
  server-side contracts before they can become reliable mobile controls.
- Desktop/web behavior is preserved. The mobile intake is an additional entry
  into the same chat service, not a new authorization model.

## Parallel implementation boundaries

This branch owns the iOS entry, intake, localized FDE briefing and existing-chat
handoff. Other work can define the server records for enterprises, sourced
evidence, opportunities, employees, workflow versions and approvals, and the
runtime/IM execution adapters. These are suggested boundaries; no other thread
has been assigned or assumed to own them.

Before adding approval controls, agree on resource IDs, revision binding,
permitted approvers, rejection/expiry states and audit receipts. Before adding
employee status, agree on the difference between a proposed role, a configured
agent and an approved operating employee.

## Validation

Run from the repository root using the packageManager version in package.json:

```sh
pnpm --filter @multica/mobile typecheck
pnpm --filter @multica/mobile lint
pnpm --filter @multica/mobile test
```

Native acceptance still requires Xcode and an iOS simulator or device:

- Check all three UI languages, both themes, long company/agent names and VoiceOver.
- Open the intake sheet, show the keyboard, scroll every field and dismiss it.
- Verify loading, retry, no permitted agents, revoked permissions and unbound runtime.
- Prepare a conversation; verify the selected agent and the unsent briefing.
  Sending once should invoke that agent once. A failed create stays on the form.
- Continue after a server-generated title, navigate between tabs, and confirm
  another workspace's conversations and form input are not shown.
- Send an attachment, disconnect/reconnect, and compare new replies with web.
- Cold launch after sending: history must remain; unsent drafts are intentionally lost.

Native build scripts remain those in the mobile README. Configure your backend
with the existing ignored local environment file; no private endpoint or account
is committed. This change does not distribute an IPA or submit to the App Store.

## License

The original Multica brand and complete LICENSE are retained. The repository
license includes additional conditions for third-party hosted services,
commercially distributed embedded products, and branding. Review the current
[upstream license](https://github.com/multica-ai/multica/blob/main/LICENSE)
before turning this internal development branch into a customer service.
