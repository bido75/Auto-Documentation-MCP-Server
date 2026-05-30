package com.autodocmcp

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.ide.passwordSafe.PasswordSafe

object CredentialStore {
    private fun attrs() = CredentialAttributes("AutoDocMcp", "notionToken")

    fun saveToken(token: String) {
        PasswordSafe.instance.set(attrs(), Credentials("notionToken", token))
    }

    fun getToken(): String? {
        return PasswordSafe.instance.getPassword(attrs())
    }

    fun clearToken() {
        PasswordSafe.instance.set(attrs(), null)
    }
}
