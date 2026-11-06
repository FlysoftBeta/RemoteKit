package app.remotekit.importer.ui

import android.graphics.Bitmap
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.remotekit.importer.R
import app.remotekit.importer.web.LoginChromeClient

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LoginScreen(vm: AppViewModel, id: String) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val draft = snapshot.drafts.find { it.id == id } ?: return
    val pairing = snapshot.pairing ?: return
    val context = LocalContext.current
    val exporting by vm.exporting.collectAsStateWithLifecycle()
    var title by remember(id) { mutableStateOf(draft.name) }
    var url by remember(id) { mutableStateOf(draft.url) }
    var progress by remember(id) { mutableIntStateOf(0) }
    val session = remember(id) { vm.profiles.create(context, id, pairing.browser) }
    val webView = session.first
    val unsupported = stringResource(R.string.unsupported_export)
    val ready = stringResource(R.string.ready_snackbar)
    DisposableEffect(webView) {
        webView.webViewClient =
            object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest,
                ): Boolean = request.url.scheme !in listOf("http", "https")

                override fun onPageStarted(view: WebView, newUrl: String?, favicon: Bitmap?) {
                    url = newUrl ?: url
                }

                override fun onPageFinished(view: WebView, newUrl: String?) {
                    url = newUrl ?: url
                }
            }
        webView.webChromeClient =
            object : LoginChromeClient() {
                override fun onProgressChanged(view: WebView, newProgress: Int) {
                    progress = newProgress
                }

                override fun onReceivedTitle(view: WebView, newTitle: String?) {
                    title = newTitle?.ifBlank { draft.name } ?: draft.name
                }
            }
        webView.loadUrl(draft.url)
        onDispose {
            webView.stopLoading()
            webView.webChromeClient = null
            webView.webViewClient = WebViewClient()
            webView.destroy()
        }
    }
    BackHandler {
        if (!exporting) {
            if (webView.canGoBack()) webView.goBack() else vm.screen.value = Screen.Home
        }
    }
    Scaffold(
        modifier = Modifier.imePadding(),
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            title,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Text(
                            Uri.parse(url).host.orEmpty(),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                },
                navigationIcon = {
                    TextButton(onClick = { vm.screen.value = Screen.Home }, enabled = !exporting) {
                        Text(stringResource(R.string.close))
                    }
                },
                actions = {
                    TextButton(onClick = { webView.reload() }, enabled = !exporting) {
                        Text(stringResource(R.string.reload))
                    }
                },
            )
        },
        bottomBar = {
            Surface(tonalElevation = 3.dp) {
                Button(
                    onClick = {
                        vm.completeLogin(draft, webView, session.second, unsupported, ready)
                    },
                    enabled = !exporting,
                    modifier =
                        Modifier.fillMaxWidth()
                            .navigationBarsPadding()
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                ) {
                    Text(stringResource(if (exporting) R.string.exporting else R.string.done_login))
                }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            if (progress < 100)
                LinearProgressIndicator(
                    progress = { progress / 100f },
                    modifier = Modifier.fillMaxWidth(),
                )
            AndroidView(factory = { webView }, modifier = Modifier.fillMaxSize())
        }
    }
}
