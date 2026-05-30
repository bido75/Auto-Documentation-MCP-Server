package com.autodocmcp

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.components.service

class ToggleServerAction : AnAction("Auto-Doc MCP Start or Stop") {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val service = project.service<McpServerService>()

        if (service.isRunning()) {
            service.stop()
            AutoDocNotifications.info(project, "Auto-Doc MCP server stopped.")
            return
        }

        val token = CredentialStore.getToken()
        if (token.isNullOrBlank()) {
            SetupWizard(project).run()
            return
        }

        service.start(project, token)
    }
}
