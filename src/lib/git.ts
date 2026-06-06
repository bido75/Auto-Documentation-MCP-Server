import { simpleGit } from "simple-git";

export function getSimpleGit(repoPath: string) {
  return simpleGit(repoPath);
}