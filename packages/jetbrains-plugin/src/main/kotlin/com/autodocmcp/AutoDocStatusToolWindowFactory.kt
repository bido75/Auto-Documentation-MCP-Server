package com.autodocmcp

import com.intellij.openapi.components.service
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.content.ContentFactory
import java.awt.datatransfer.StringSelection
import java.awt.BorderLayout
import java.awt.FlowLayout
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.JScrollPane

class AutoDocStatusToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val root = JPanel(BorderLayout())
        val statusLabel = JBLabel("Status: loading...")
        val configLabel = JBLabel("Config: checking...")
        val serverLabel = JBLabel("Server: unresolved")
        val traceLabel = JBLabel("Trace ID: pending")
        val healthLabel = JBLabel("Health: unknown")
        val lastActionLabel = JBLabel("Last action: none")
        val detailsArea = JBTextArea().apply {
            isEditable = false
            lineWrap = true
            wrapStyleWord = true
            rows = 7
        }
        val actions = JPanel(FlowLayout(FlowLayout.LEFT))

        val setupButton = JButton("Setup")
        val toggleButton = JButton("Start/Stop")
        val refreshButton = JButton("Refresh")
        val copyTraceButton = JButton("Copy Trace")
        val openSettingsButton = JButton("Open Settings")
        val clearTokenButton = JButton("Clear Token")

        actions.add(setupButton)
        actions.add(toggleButton)
        actions.add(refreshButton)
        actions.add(copyTraceButton)
        actions.add(openSettingsButton)
        actions.add(clearTokenButton)

        var currentTraceId = UUID.randomUUID().toString()

        val center = JPanel(BorderLayout())
        val summary = JPanel()
        summary.layout = javax.swing.BoxLayout(summary, javax.swing.BoxLayout.Y_AXIS)
        summary.add(statusLabel)
        summary.add(configLabel)
        summary.add(serverLabel)
        summary.add(healthLabel)
        summary.add(traceLabel)
        summary.add(lastActionLabel)

        center.add(summary, BorderLayout.NORTH)
        center.add(JScrollPane(detailsArea), BorderLayout.CENTER)

        root.add(center, BorderLayout.CENTER)
        root.add(actions, BorderLayout.SOUTH)

        fun markAction(action: String) {
            val now = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss"))
            lastActionLabel.text = "Last action: $action at $now"
        }

        val refresh = {
            val service = project.service<McpServerService>()
            val props = PropertiesComponent.getInstance(project)
            val tokenConfigured = !CredentialStore.getToken().isNullOrBlank()
            val configuredServerPath = props.getValue("autoDocMcp.serverPath")
            val state = if (service.isRunning()) "Running" else "Stopped"
            val configState = if (tokenConfigured) "Configured" else "Missing token"
            val serverState = if (configuredServerPath.isNullOrBlank()) "Auto-detected" else configuredServerPath

            statusLabel.text = "Status: $state"
            configLabel.text = "Setup: $configState"
            serverLabel.text = "Server: $serverState"
            healthLabel.text = if (service.isRunning()) "Health: online" else "Health: offline"
            currentTraceId = UUID.randomUUID().toString()
            traceLabel.text = "Trace ID: $currentTraceId"

            detailsArea.text = buildString {
                appendLine("Auto-Doc MCP control panel")
                appendLine()
                appendLine("- Server process: $state")
                appendLine("- Notion token: ${if (tokenConfigured) "stored in PasswordSafe" else "missing"}")
                appendLine("- Notion database ID: ${props.getValue("autoDocMcp.notionDatabaseId", "not set")}")
                appendLine("- Project name: ${props.getValue("autoDocMcp.projectName", project.name)}")
                appendLine("- Effective server path: $serverState")
                appendLine()
                appendLine("Use Refresh after setup changes or after rebuilding the TypeScript server artifact.")
            }
        }

        setupButton.addActionListener {
            SetupWizard(project).run()
            markAction("setup")
            refresh()
        }

        toggleButton.addActionListener {
            val service = project.service<McpServerService>()
            if (service.isRunning()) {
                service.stop()
                AutoDocNotifications.info(project, "Auto-Doc MCP server stopped.")
                markAction("stop")
            } else {
                val token = CredentialStore.getToken()
                if (token.isNullOrBlank()) {
                    SetupWizard(project).run()
                    markAction("setup")
                } else {
                    service.start(project, token)
                    markAction("start")
                }
            }
            refresh()
        }

        refreshButton.addActionListener {
            markAction("refresh")
            refresh()
        }

        copyTraceButton.addActionListener {
            CopyPasteManager.getInstance().setContents(StringSelection(currentTraceId))
            AutoDocNotifications.info(project, "Trace ID copied.")
            markAction("copy-trace")
        }

        openSettingsButton.addActionListener {
            com.intellij.openapi.options.ShowSettingsUtil.getInstance().showSettingsDialog(project, "Tools")
            markAction("open-settings")
        }

        clearTokenButton.addActionListener {
            CredentialStore.clearToken()
            AutoDocNotifications.warn(project, "Stored token cleared. Run setup to configure again.")
            markAction("clear-token")
            refresh()
        }

        refresh()

        val content = ContentFactory.getInstance().createContent(root, "", false)
        toolWindow.contentManager.addContent(content)
    }
}
