```markdown
# Auto-Documentation-MCP-Server Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill teaches you the core development patterns, coding conventions, and common workflows for contributing to the **Auto-Documentation-MCP-Server** project. The codebase is a TypeScript backend built on the Express framework, focused on modularity, provider/tool extensibility, and robust testing. You'll learn how to implement features, extend providers/tools, harden production, and follow the project's established conventions.

## Coding Conventions

**File Naming**
- Use **kebab-case** for all filenames.
  - Example: `my-feature-handler.ts`

**Import Style**
- Use **relative imports** for internal modules.
  ```typescript
  import { myUtil } from '../lib/my-util';
  ```

**Export Style**
- Use **named exports** throughout the codebase.
  ```typescript
  // Good
  export function myFunction() { ... }

  // Good
  export const MY_CONSTANT = 42;

  // Avoid default exports
  ```

**Commit Patterns**
- Prefix commits with `feat` for features, `docs` for documentation, etc.
  - Example: `feat: add OpenAI provider support`
- Keep commit messages concise (~44 characters on average).

## Workflows

### Feature Implementation with Tests and Docs
**Trigger:** When adding a significant new feature or capability  
**Command:** `/new-feature`

1. Update or add core implementation files in:
   - `src/lib/`
   - `src/orchestrator/`
   - `src/providers/`
   - `src/tools/`
2. Add or update integration tests in `tests/integration/` and/or unit tests in `tests/unit/`.
   ```typescript
   // Example: tests/unit/my-feature.test.ts
   import { myFeature } from '../../src/lib/my-feature';

   test('should perform expected action', () => {
     expect(myFeature()).toBe(true);
   });
   ```
3. Update documentation files such as `README.md`, `QUICKSTART.md`, or `.env.example`.

### Security or Production Hardening
**Trigger:** When improving security, reliability, or production readiness  
**Command:** `/harden-production`

1. Update configuration files:
   - `.env.example`, `.gitignore`, `.dockerignore`
   - `docker-compose.yml`, `Dockerfile`
   - `.github/workflows/ci.yml`
2. Patch or update core code for security or reliability:
   - `src/lib/`, `src/http-bridge/`, `src/config.ts`, etc.
3. Update or add relevant integration/unit tests to verify hardening.
   ```typescript
   // Example: tests/integration/security.test.ts
   import { secureFunction } from '../../src/lib/security';

   test('should reject invalid input', () => {
     expect(() => secureFunction('bad')).toThrow();
   });
   ```
4. Update documentation as needed (`README.md`, `QUICKSTART.md`).

### Provider or Tooling Extension
**Trigger:** When adding support for a new AI provider or tool/utility  
**Command:** `/add-provider`

1. Add or update provider files in `src/providers/` and update `src/providers/factory.ts`.
   ```typescript
   // Example: src/providers/my-new-provider.ts
   export function myNewProvider(config) { ... }
   ```
2. Add or update tool files in `src/tools/`.
3. Update or add tests for the new provider/tool in `tests/integration/` and/or `tests/unit/`.
4. Update documentation if necessary (`README.md`).

## Testing Patterns

- **Framework:** [vitest](https://vitest.dev/)
- **File Pattern:** All test files use the `.test.ts` suffix.
  - Example: `my-feature.test.ts`
- **Test Organization:**
  - Unit tests: `tests/unit/`
  - Integration tests: `tests/integration/`
- **Example Test:**
  ```typescript
  // tests/unit/example.test.ts
  import { exampleFunc } from '../../src/lib/example-func';

  test('should return expected value', () => {
    expect(exampleFunc(2)).toBe(4);
  });
  ```

## Commands

| Command           | Purpose                                                      |
|-------------------|--------------------------------------------------------------|
| /new-feature      | Start a new feature with implementation, tests, and docs     |
| /harden-production| Apply security or production hardening changes               |
| /add-provider     | Add or extend an AI provider or tool with tests and docs     |
```
