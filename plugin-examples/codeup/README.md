# Codeup Forge plugin

This local plugin adds Codeup as a native Paseo Forge provider. Its separate client and server
entries share one provider definition. It uses Alibaba Cloud CLI for authentication and Codeup
DevOps API calls.

Everything in `server/codeup-service.ts` that is not a Codeup endpoint shape comes from
`@getpaseo/plugin/server/forge-toolkit`: process execution, CLI error classification, JSON output
parsing, argument redaction, Git remote parsing, and pagination guards. Copy the layout, not the
plumbing.

The Forge plugin API is not in a published SDK release yet. This repository example depends on the
SDK from the same checkout. Build that package before installing the example dependencies.

```bash
# From the Paseo repository root:
npm install
npm run build:plugin
cd plugin-examples/codeup

aliyun configure
npm install
npm run typecheck
paseo plugin install /absolute/path/to/plugin-examples/codeup
```

Source changes require `paseo plugin reload codeup`. The real integration test requires
`CODEUP_E2E_REPOSITORY_URL` and `CODEUP_E2E_BASE_BRANCH` and creates, checks out, then merges a
temporary merge request.
