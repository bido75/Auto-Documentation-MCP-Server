"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotionSetup = void 0;
class NotionSetup {
    serverManager;
    constructor(serverManager) {
        this.serverManager = serverManager;
    }
    async initializeProjectManual(projectName, parentPageId) {
        return this.serverManager.initializeProjectManual({
            projectName,
            parentPageId,
        });
    }
}
exports.NotionSetup = NotionSetup;
