package app.remotekit.importer.ui

import android.graphics.Bitmap
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.remotekit.importer.R
import app.remotekit.importer.deployment.ContractJson
import app.remotekit.importer.web.LoginChromeClient
import app.remotekit.importer.web.SITE_NAME_SCRIPT
import app.remotekit.importer.web.SearchEngines
import app.remotekit.importer.web.SiteVisit
import app.remotekit.importer.web.addressOf
import app.remotekit.importer.web.siteKey

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LoginScreen(vm: AppViewModel, id: String) {
    val deployment = vm.deployment ?: return
    val context = LocalContext.current
    val exporting by vm.exporting.collectAsStateWithLifecycle()
    val history = remember(id) { vm.visits(id) }
    val visits by history.visits.collectAsStateWithLifecycle()
    var url by remember(id) { mutableStateOf<String?>(null) }
    var title by remember(id) { mutableStateOf<String?>(null) }
    var progress by remember(id) { mutableIntStateOf(100) }
    var omnibox by remember(id) { mutableStateOf(true) }
    var picking by remember(id) { mutableStateOf(false) }
    var query by remember(id) { mutableStateOf(TextFieldValue()) }
    val session = remember(id) { vm.profiles.create(context, id, deployment.browser) }
    val webView = session.first
    DisposableEffect(webView) {
        webView.webViewClient =
            object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest,
                ): Boolean = request.url.scheme !in listOf("http", "https")

                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? {
                    history.requests.record(request.url.toString())
                    return null
                }

                override fun doUpdateVisitedHistory(
                    view: WebView,
                    newUrl: String?,
                    isReload: Boolean,
                ) {
                    newUrl ?: return
                    url = newUrl
                    history.navigated(newUrl)
                }

                override fun onPageFinished(view: WebView, newUrl: String?) {
                    view.evaluateJavascript(SITE_NAME_SCRIPT) { result ->
                        val name = runCatching { ContractJson.decodeFromString<String>(result) }
                        history.siteName(newUrl, name.getOrNull())
                    }
                }
            }
        webView.webChromeClient =
            object : LoginChromeClient() {
                override fun onProgressChanged(view: WebView, newProgress: Int) {
                    progress = newProgress
                }

                override fun onReceivedTitle(view: WebView, newTitle: String?) {
                    title = newTitle
                    history.title(view.url, newTitle)
                }

                override fun onReceivedIcon(view: WebView, icon: Bitmap?) {
                    history.icon(view.url, icon)
                }
            }
        onDispose {
            webView.stopLoading()
            webView.webChromeClient = null
            webView.webViewClient = WebViewClient()
            webView.destroy()
        }
    }
    val open = { target: String ->
        webView.loadUrl(target)
        url = target
        title = null
        omnibox = false
    }
    val leave = { vm.navigate(Screen.Home) }
    BackHandler(!exporting) {
        when {
            omnibox && url != null -> omnibox = false
            !omnibox && webView.canGoBack() -> webView.goBack()
            else -> leave()
        }
    }
    Scaffold(
        snackbarHost = { SnackbarHost(LocalSnackbar.current) },
        modifier = Modifier.imePadding(),
        topBar = {
            if (omnibox)
                OmniboxBar(
                    value = query,
                    onChange = { query = it },
                    onBack = { if (url != null) omnibox = false else leave() },
                    onOpen = open,
                )
            else
                TopAppBar(
                    title = {
                        AddressPill(url, title) {
                            val current = url.orEmpty()
                            query = TextFieldValue(current, TextRange(0, current.length))
                            omnibox = true
                        }
                    },
                    navigationIcon = {
                        IconButton(onClick = leave, enabled = !exporting) {
                            Icon(Icons.Filled.Close, stringResource(R.string.close))
                        }
                    },
                    actions = {
                        IconButton(onClick = { webView.reload() }, enabled = !exporting) {
                            Icon(Icons.Filled.Refresh, stringResource(R.string.reload))
                        }
                    },
                )
        },
        bottomBar = {
            if (!omnibox)
                Surface(tonalElevation = 3.dp, shadowElevation = 3.dp) {
                    Row(
                        Modifier.fillMaxWidth()
                            .navigationBarsPadding()
                            .padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text(
                            stringResource(R.string.login_hint),
                            Modifier.weight(1f),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Button(
                            onClick = { picking = true },
                            enabled = !exporting && visits.isNotEmpty(),
                        ) {
                            Icon(Icons.Filled.Check, null, Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(stringResource(R.string.done_login))
                        }
                    }
                }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            Column(Modifier.fillMaxSize()) {
                if (progress < 100 && !omnibox)
                    LinearProgressIndicator(
                        progress = { progress / 100f },
                        modifier = Modifier.fillMaxWidth(),
                    )
                AndroidView(factory = { webView }, modifier = Modifier.fillMaxSize())
            }
            if (omnibox)
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
                    StartPanel(query.text.trim(), onOpen = open)
                }
        }
    }
    if (picking)
        SitePickerSheet(
            visits = visits,
            current = url?.let { Uri.parse(it).host }?.let(::siteKey),
            exporting = exporting,
            onDismiss = { if (!exporting) picking = false },
            onExport = { chosen ->
                vm.exportSites(id, session.second, chosen) { picking = false }
            },
        )
}

@Composable
private fun AddressPill(url: String?, title: String?, onClick: () -> Unit) {
    val host = url?.let { Uri.parse(it).host }.orEmpty()
    Surface(
        onClick = onClick,
        shape = CircleShape,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        modifier = Modifier.fillMaxWidth().padding(end = 4.dp),
    ) {
        Row(
            Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (url?.startsWith("https://") == true)
                Icon(
                    Icons.Filled.Lock,
                    null,
                    Modifier.size(14.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            Column {
                Text(
                    title?.takeIf(String::isNotBlank) ?: host,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (!title.isNullOrBlank())
                    Text(
                        host,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
            }
        }
    }
}

@Composable
private fun OmniboxBar(
    value: TextFieldValue,
    onChange: (TextFieldValue) -> Unit,
    onBack: () -> Unit,
    onOpen: (String) -> Unit,
) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    Surface(color = MaterialTheme.colorScheme.surface) {
        Row(
            Modifier.fillMaxWidth().statusBarsPadding().padding(4.dp, 8.dp, 12.dp, 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back))
            }
            TextField(
                value,
                onChange,
                Modifier.weight(1f).focusRequester(focus),
                placeholder = { Text(stringResource(R.string.omnibox_hint)) },
                singleLine = true,
                shape = CircleShape,
                colors =
                    TextFieldDefaults.colors(
                        focusedIndicatorColor = Color.Transparent,
                        unfocusedIndicatorColor = Color.Transparent,
                    ),
                leadingIcon = { Icon(Icons.Filled.Search, null) },
                trailingIcon = {
                    if (value.text.isNotEmpty())
                        IconButton(onClick = { onChange(TextFieldValue()) }) {
                            Icon(Icons.Filled.Clear, stringResource(R.string.clear))
                        }
                },
                keyboardOptions =
                    KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Uri,
                        imeAction = ImeAction.Go,
                    ),
                keyboardActions =
                    KeyboardActions(
                        onGo = {
                            val text = value.text.trim()
                            if (text.isNotEmpty())
                                onOpen(
                                    addressOf(text)
                                        ?: SearchEngines.search(SearchEngines.all.first(), text)
                                )
                        }
                    ),
            )
        }
    }
}

/** Search engines when the address field is empty, otherwise ways to use what was typed. */
@Composable
private fun StartPanel(text: String, onOpen: (String) -> Unit) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 8.dp)) {
        if (text.isEmpty()) {
            item {
                Text(
                    stringResource(R.string.start_title),
                    Modifier.padding(horizontal = 24.dp, vertical = 16.dp),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            item {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    SearchEngines.all.forEach { engine ->
                        OutlinedCard(
                            onClick = { onOpen(engine.home) },
                            modifier = Modifier.weight(1f),
                        ) {
                            Column(
                                Modifier.fillMaxWidth().padding(vertical = 18.dp),
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                SiteIcon(null, engine.name, 44.dp)
                                Text(engine.name, style = MaterialTheme.typography.labelLarge)
                            }
                        }
                    }
                }
            }
        } else {
            addressOf(text)?.let { address ->
                item {
                    ListItem(
                        leadingContent = {
                            SiteIcon(null, Uri.parse(address).host.orEmpty(), 36.dp)
                        },
                        headlineContent = {
                            Text(stringResource(R.string.open_address), maxLines = 1)
                        },
                        supportingContent = {
                            Text(address, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        },
                        modifier = Modifier.clickable { onOpen(address) },
                    )
                }
            }
            items(SearchEngines.all) { engine ->
                ListItem(
                    leadingContent = { SiteIcon(null, engine.name, 36.dp) },
                    headlineContent = {
                        Text(stringResource(R.string.search_with, engine.name), maxLines = 1)
                    },
                    supportingContent = {
                        Text(text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    },
                    modifier = Modifier.clickable { onOpen(SearchEngines.search(engine, text)) },
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SitePickerSheet(
    visits: List<SiteVisit>,
    current: String?,
    exporting: Boolean,
    onDismiss: () -> Unit,
    onExport: (List<SiteVisit>) -> Unit,
) {
    val rows = remember(visits) { visits.sortedBy { it.searchEngine } }
    var chosen by remember {
        mutableStateOf(rows.filter { it.key == current && !it.searchEngine }.map { it.key }.toSet())
    }
    val selected = rows.filter { it.key in chosen }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    ) {
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
            Column(Modifier.padding(horizontal = 24.dp)) {
                Text(
                    stringResource(R.string.pick_title),
                    style = MaterialTheme.typography.titleLarge,
                )
                Text(
                    stringResource(R.string.pick_hint),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            LazyColumn(Modifier.weight(1f, fill = false).padding(vertical = 8.dp)) {
                items(rows, key = { it.key }) { visit ->
                    val toggle = {
                        chosen = if (visit.key in chosen) chosen - visit.key else chosen + visit.key
                    }
                    ListItem(
                        leadingContent = {
                            SiteIcon(visit.icon?.asImageBitmap(), visit.name, 40.dp)
                        },
                        headlineContent = {
                            Text(visit.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        },
                        supportingContent = {
                            Text(visit.key, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        },
                        trailingContent = {
                            Checkbox(
                                checked = visit.key in chosen,
                                onCheckedChange = { toggle() },
                                enabled = !exporting,
                            )
                        },
                        modifier =
                            Modifier.padding(horizontal = 8.dp).clickable(enabled = !exporting) {
                                toggle()
                            },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    )
                }
            }
            Button(
                onClick = { onExport(selected) },
                enabled = selected.isNotEmpty() && !exporting,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp),
            ) {
                if (exporting) {
                    CircularProgressIndicator(
                        Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color = LocalContentColor.current,
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.exporting))
                } else Text(stringResource(R.string.export_count, selected.size))
            }
        }
    }
}
