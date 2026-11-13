package app.remotekit.importer.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import app.remotekit.importer.ImporterApplication
import app.remotekit.importer.LocalDataState
import app.remotekit.importer.store.Pairing

internal val LocalSnackbar = staticCompositionLocalOf { SnackbarHostState() }

@Composable
fun ImporterApp() {
    val runtime = LocalContext.current.applicationContext as ImporterApplication
    when (val data = runtime.localData) {
        is LocalDataState.Unreadable ->
            ConfigurationScreen("本地数据无法读取\n${data.error.message}", "本地数据损坏")
        is LocalDataState.Ready -> ReadyImporterApp()
    }
}

@Composable
private fun ReadyImporterApp(vm: AppViewModel = viewModel()) {
    val screen by vm.screen.collectAsStateWithLifecycle()
    val state by vm.snapshot.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(vm) { vm.messages.collect { snackbar.showSnackbar(it) } }
    LaunchedEffect(state.pairing) {
        if (!vm.store.authorized() && screen is Screen.Login) vm.navigate(Screen.Home)
    }
    CompositionLocalProvider(LocalSnackbar provides snackbar) {
        when {
            vm.startupError != null -> ConfigurationScreen(vm.startupError)
            vm.deployment == null -> ConfigurationScreen("未内置部署配置，请下载 deployment.json 后重新构建 App。")
            screen is Screen.Settings -> SettingsScreen(vm)
            screen is Screen.Login -> LoginScreen(vm, (screen as Screen.Login).id)
            state.pairing is Pairing.Unpaired || state.pairing is Pairing.Revoked ->
                PairingScreen(vm)
            else -> TimelineScreen(vm)
        }
    }
    BackHandler(screen is Screen.Settings) { vm.navigate(Screen.Home) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ConfigurationScreen(message: String, title: String = "会话导入") {
    Scaffold(topBar = { TopAppBar(title = { Text(title) }) }) { padding ->
        Column(Modifier.padding(padding).padding(24.dp)) { Text(message) }
    }
}
