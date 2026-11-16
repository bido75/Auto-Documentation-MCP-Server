import { describe, expect, it } from "vitest";
import { selectProject } from "../../src/cli/post-commit.js";
import type { ProjectState } from "../../src/lib/state-store.js";

function project(projectId: string, repositoryUrl?: string): ProjectState {
  return { projectId, repositoryUrl } as ProjectState;
}

describe("post-commit project selection", () => {
  it("does not guess from a sole unrelated project", () => {
    expect(selectProject({ projects: [project("unrelated")] })).toBeNull();
  });

  it("selects an explicit binding or matching repository URL", () => {
    const projects = [
      project("first", "https://github.com/example/first"),
      project("second", "git@github.com:example/second.git"),
    ];
    expect(selectProject({ projects, preferredProjectId: "first" })?.projectId).toBe("first");
    expect(selectProject({ projects, remoteUrl: "https://github.com/example/second.git" })?.projectId).toBe("second");
  });
});
