package app.remotekit.importer.ui

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

private val Light =
    lightColorScheme(
        primary = Color(0xFF285EA7),
        onPrimary = Color.White,
        primaryContainer = Color(0xFFD7E3FF),
        onPrimaryContainer = Color(0xFF001B3F),
        secondary = Color(0xFF555F71),
        secondaryContainer = Color(0xFFD9E3F8),
        tertiary = Color(0xFF6E5676),
        tertiaryContainer = Color(0xFFF8D8FF),
    )
private val Dark =
    darkColorScheme(
        primary = Color(0xFFA9C7FF),
        onPrimary = Color(0xFF003063),
        primaryContainer = Color(0xFF00468C),
        onPrimaryContainer = Color(0xFFD7E3FF),
        secondary = Color(0xFFBDC7DC),
        secondaryContainer = Color(0xFF3E4759),
        tertiary = Color(0xFFDBBCE2),
        tertiaryContainer = Color(0xFF553F5D),
    )

@Composable
fun ImporterTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val context = LocalContext.current
    val colors =
        if (Build.VERSION.SDK_INT >= 31) {
            if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        } else if (dark) Dark else Light
    MaterialTheme(colorScheme = colors, content = content)
}
