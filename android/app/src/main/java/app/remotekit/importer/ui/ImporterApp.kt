package app.remotekit.importer.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import app.remotekit.importer.store.Pairing

internal val LocalSnackbar = staticCompositionLocalOf { SnackbarHostState() }

@Composable
fun ImporterApp(vm: AppViewModel = viewModel()) {
    val screen by vm.screen.collectAsStateWithLifecycle()
    val state by vm.snapshot.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(vm) { vm.messages.collect { snackbar.showSnackbar(it) } }
    LaunchedEffect(state.pairing) {
        if (!vm.store.authorized() && screen is Screen.Login) vm.screen.value = Screen.Home
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
    BackHandler(screen is Screen.Settings) { vm.screen.value = Screen.Home }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ConfigurationScreen(message: String) {
    Scaffold(topBar = { TopAppBar(title = { Text("会话导入") }) }) { padding ->
        Column(Modifier.padding(padding).padding(24.dp)) { Text(message) }
    }
}
