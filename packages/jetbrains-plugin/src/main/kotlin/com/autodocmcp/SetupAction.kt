package com.autodocmcp

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

class SetupAction : AnAction("Auto-Doc MCP Setup") {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        SetupWizard(project).run()
    }
}
