package app.remotekit.importer

import androidx.annotation.StringRes

class UserMessage(@param:StringRes val textResource: Int) : IllegalArgumentException()

fun requireMessage(value: Boolean, message: () -> Int = { R.string.operation_failed }) {
    if (!value) throw UserMessage(message())
}

fun <T : Any> requireMessageNotNull(value: T?, message: () -> Int): T =
    value ?: throw UserMessage(message())
