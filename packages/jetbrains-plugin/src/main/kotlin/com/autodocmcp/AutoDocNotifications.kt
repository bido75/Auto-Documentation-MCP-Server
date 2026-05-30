package com.autodocmcp

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project

object AutoDocNotifications {
    private const val GROUP_ID = "Auto-Doc MCP"

    fun info(project: Project?, message: String) {
        notify(project, message, NotificationType.INFORMATION)
    }

    fun warn(project: Project?, message: String) {
        notify(project, message, NotificationType.WARNING)
    }

    private fun notify(project: Project?, message: String, type: NotificationType) {
        NotificationGroupManager
            .getInstance()
            .getNotificationGroup(GROUP_ID)
            .createNotification("Auto-Doc MCP", message, type)
            .notify(project)
    }
}
