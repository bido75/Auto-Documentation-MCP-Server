"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitWatcher = void 0;
const vscode = __importStar(require("vscode"));
class GitWatcher {
    disposables = [];
    lastHeadSha = null;
    start() {
        const gitExtension = vscode.extensions.getExtension("vscode.git");
        if (!gitExtension?.isActive) {
            return;
        }
        const gitApi = gitExtension.exports.getAPI(1);
        for (const repository of gitApi.repositories) {
            this.watchRepository(repository);
        }
        this.disposables.push(gitApi.onDidOpenRepository((repository) => this.watchRepository(repository)));
    }
    stop() {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
    }
    watchRepository(repository) {
        const repo = repository;
        this.disposables.push(repo.state.onDidChange(() => {
            const captureOnCommit = vscode.workspace.getConfiguration("autoDocMcp").get("captureOnCommit", true) ?? true;
            if (!captureOnCommit) {
                return;
            }
            const currentHead = repo.state.HEAD?.commit ?? null;
            if (!currentHead || currentHead === this.lastHeadSha) {
                return;
            }
            this.lastHeadSha = currentHead;
            void vscode.commands.executeCommand("autoDocMcp.captureNow");
        }));
    }
}
exports.GitWatcher = GitWatcher;
