# Auto-Documentation MCP Server

Production-ready TypeScript MCP server that captures development signals and continuously builds user/admin documentation in Notion.

## Quick Start

1. Install dependencies:

```bash
npm ci
```

2. Run checks:

```bash
npm run typecheck
npm test
npm run build
```

3. Run locally:

```bash
npm run dev
```

## Environment

- `NOTION_TOKEN` for Notion API access
- `NOTION_PARENT_PAGE_ID` for live integration tests
- `RUN_LIVE_NOTION_TESTS=true` to enable env-gated live tests

## CI

GitHub Actions runs typecheck, tests, and build on pushes and pull requests to `main`.
