package com.autodocmcp

import com.intellij.openapi.application.invokeLater
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.StartupActivity
import com.intellij.openapi.ui.Messages

class AutoDocMcpPlugin : StartupActivity {
    override fun runActivity(project: Project) {
        invokeLater {
            val token = CredentialStore.getToken()
            if (token.isNullOrBlank()) {
                val answer = Messages.showYesNoDialog(
                    project,
                    "Auto-Doc MCP is not configured for this IDE yet. Run setup now?",
                    "Auto-Doc MCP",
                    "Run Setup",
                    "Later",
                    Messages.getQuestionIcon(),
                )
                if (answer == Messages.YES) {
                    SetupWizard(project).run()
                }
                return@invokeLater
            }

            project.service<McpServerService>().start(project, token)
        }
    }
}
