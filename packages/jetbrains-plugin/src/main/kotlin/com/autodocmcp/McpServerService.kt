package com.autodocmcp

import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.thisLogger
import com.intellij.openapi.project.Project
import java.io.BufferedReader
import java.io.File
import java.nio.file.Files
import java.nio.file.Path

@Service
class McpServerService : Disposable {
    private var process: Process? = null

    fun start(project: Project, notionToken: String) {
        if (notionToken.isBlank()) {
            AutoDocNotifications.warn(project, "Notion token is missing. Run setup first.")
            return
        }

        if (process?.isAlive == true) {
            return
        }

        val serverPath = try {
            resolveServerPath(project)
        } catch (error: Exception) {
            AutoDocNotifications.warn(project, error.message ?: "Auto-Doc MCP server artifact is missing.")
            thisLogger().warn("Failed to resolve server path", error)
            return
        }

        val nodePath = findNodeExecutable()
        if (nodePath == null) {
            AutoDocNotifications.warn(project, "Node.js was not found. Install Node.js and restart the IDE.")
            return
        }

        val builder = ProcessBuilder(nodePath, serverPath)
        builder.redirectErrorStream(false)
        builder.environment()["NOTION_TOKEN"] = notionToken
        builder.environment()["AUTO_DOC_MCP_SERVER_PATH"] = serverPath

        val basePath = project.basePath
        if (!basePath.isNullOrBlank()) {
            builder.directory(File(basePath))
            builder.environment()["AUTO_DOC_MCP_PROJECT_PATH"] = basePath
        }

        process = try {
            builder.start().also { started ->
                startStreamLogger(started.errorStream.bufferedReader())
            }
        } catch (error: Exception) {
            AutoDocNotifications.warn(project, "Failed to start bundled MCP server: ${error.message}")
            thisLogger().warn("Failed to start MCP server", error)
            null
        }

        if (process != null) {
            AutoDocNotifications.info(project, "Auto-Doc MCP server started.")
        }
    }

    fun stop() {
        process?.destroy()
        process = null
    }

    fun isRunning(): Boolean {
        return process?.isAlive == true
    }

    private fun resolveServerPath(project: Project): String {
        val projectProps = com.intellij.ide.util.PropertiesComponent.getInstance(project)
        val configuredPath = projectProps.getValue("autoDocMcp.serverPath")
        if (!configuredPath.isNullOrBlank() && Files.exists(Path.of(configuredPath))) {
            return Path.of(configuredPath).toAbsolutePath().toString()
        }

        val projectBuildCandidate = project.basePath?.let { Path.of(it).resolve("build").resolve("index.js") }
        if (projectBuildCandidate != null && Files.exists(projectBuildCandidate)) {
            return projectBuildCandidate.toAbsolutePath().toString()
        }

        val pluginBundleCandidate = javaClass.getResource("/bundled/mcp-server.js")
        if (pluginBundleCandidate != null) {
            return Path.of(pluginBundleCandidate.toURI()).toAbsolutePath().toString()
        }

        throw IllegalStateException(
            "Auto-Doc MCP server artifact is missing. Build the root project first (npm run build) or configure a server path in setup."
        )
    }

    private fun findNodeExecutable(): String? {
        val candidates = listOf(
            "node",
            "node.exe",
            "C:/Program Files/nodejs/node.exe",
            "C:/Program Files (x86)/nodejs/node.exe",
            "/usr/local/bin/node",
            "/opt/homebrew/bin/node",
        )

        for (candidate in candidates) {
            try {
                val check = ProcessBuilder(candidate, "--version")
                    .redirectErrorStream(true)
                    .start()
                val exitCode = check.waitFor()
                if (exitCode == 0) {
                    return candidate
                }
            } catch (_: Exception) {
                continue
            }
        }

        return null
    }

    private fun startStreamLogger(reader: BufferedReader) {
        Thread {
            try {
                reader.useLines { lines ->
                    lines.forEach { line ->
                        thisLogger().warn("[Auto-Doc MCP] $line")
                    }
                }
            } catch (_: Exception) {
            }
        }.start()
    }

    override fun dispose() {
        stop()
    }
}
