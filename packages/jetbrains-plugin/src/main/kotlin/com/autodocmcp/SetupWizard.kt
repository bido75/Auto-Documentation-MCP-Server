package com.autodocmcp

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import java.nio.file.Path

class SetupWizard(private val project: Project) {
    fun run() {
        val token = Messages.showPasswordDialog(
            project,
            "Paste your Notion integration token (secret_...).",
            "Auto-Doc Setup (1/3) - Notion Token",
        )?.trim() ?: return

        if (!token.startsWith("secret_")) {
            AutoDocNotifications.warn(project, "Token must start with 'secret_'.")
            return
        }

        val notionDatabaseId = Messages.showInputDialog(
            project,
            "Paste your Notion database ID (optional, used by Open Manual).",
            "Auto-Doc Setup (2/3) - Notion Database ID",
            Messages.getQuestionIcon(),
            PropertiesComponent.getInstance(project).getValue("autoDocMcp.notionDatabaseId", ""),
            null,
        )

        val projectName = Messages.showInputDialog(
            project,
            "Project display name for setup metadata.",
            "Auto-Doc Setup (3/3) - Project Name",
            Messages.getQuestionIcon(),
            project.name,
            null,
        )

        val serverPath = Messages.showInputDialog(
            project,
            "Optional path to built MCP server script. Leave empty to auto-detect build/index.js.",
            "Auto-Doc Setup - Server Script Path",
            Messages.getQuestionIcon(),
            PropertiesComponent.getInstance(project).getValue(
                "autoDocMcp.serverPath",
                project.basePath?.let { Path.of(it).resolve("build").resolve("index.js").toString() } ?: "",
            ),
            null,
        )

        CredentialStore.saveToken(token)

        val props = PropertiesComponent.getInstance(project)
        if (!notionDatabaseId.isNullOrBlank()) {
            props.setValue("autoDocMcp.notionDatabaseId", notionDatabaseId)
        }
        if (!projectName.isNullOrBlank()) {
            props.setValue("autoDocMcp.projectName", projectName)
        }
        if (!serverPath.isNullOrBlank()) {
            props.setValue("autoDocMcp.serverPath", serverPath)
        }

        project.service<McpServerService>().start(project, token)
        AutoDocNotifications.info(project, "Auto-Doc setup complete.")
    }
}
