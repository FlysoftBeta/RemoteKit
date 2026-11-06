package app.remotekit.importer.account

import app.remotekit.importer.R
import app.remotekit.importer.requireMessage

class Account(val username: String, val password: String)

fun validateAccount(username: String, password: String) {
    requireMessage(username.codePointCount(0, username.length) in 1..64) {
        R.string.username_limit
    }
    requireMessage(password.codePointCount(0, password.length) in 1..256) {
        R.string.password_limit
    }
}
