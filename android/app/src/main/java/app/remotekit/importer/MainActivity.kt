package app.remotekit.importer

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import app.remotekit.importer.ui.ImporterApp
import app.remotekit.importer.ui.ImporterTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { ImporterTheme { ImporterApp() } }
    }
}
