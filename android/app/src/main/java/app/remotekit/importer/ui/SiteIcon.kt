package app.remotekit.importer.ui

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.sp

/** A site's favicon on a neutral disc, or its initial on a tinted disc when there is none. */
@Composable
fun SiteIcon(icon: ImageBitmap?, label: String, size: Dp) {
    val colors = MaterialTheme.colorScheme
    if (icon != null) {
        Surface(Modifier.size(size), shape = CircleShape, color = colors.surfaceContainerHighest) {
            Box(contentAlignment = Alignment.Center) {
                Image(icon, null, Modifier.size(size * 0.55f))
            }
        }
        return
    }
    val palette =
        listOf(
            colors.primaryContainer to colors.onPrimaryContainer,
            colors.secondaryContainer to colors.onSecondaryContainer,
            colors.tertiaryContainer to colors.onTertiaryContainer,
        )
    val (background, foreground) = palette[Math.floorMod(label.hashCode(), palette.size)]
    Surface(Modifier.size(size), shape = CircleShape, color = background) {
        Box(contentAlignment = Alignment.Center) {
            Text(
                label.take(1).uppercase(),
                color = foreground,
                fontSize = (size.value * 0.42f).sp,
            )
        }
    }
}

@Composable
fun rememberIcon(base64: String?): ImageBitmap? =
    remember(base64) {
        base64?.let {
            runCatching {
                    val bytes = Base64.decode(it, Base64.NO_WRAP)
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
                }
                .getOrNull()
        }
    }
