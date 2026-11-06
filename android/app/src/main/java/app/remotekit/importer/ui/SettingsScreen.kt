package app.remotekit.importer.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.remotekit.importer.store.Pairing
import app.remotekit.importer.store.SendMode

private data class ModeOption(val mode: SendMode, val title: String, val detail: String)

private val modes =
    listOf(
        ModeOption(SendMode.Window(0), "立即发送", "每次操作马上发出一封邮件"),
        ModeOption(SendMode.Window(60), "合并 1 分钟", "1 分钟内的操作合并成一封邮件"),
        ModeOption(SendMode.Window(300), "合并 5 分钟", "5 分钟内的操作合并成一封邮件"),
        ModeOption(SendMode.Series, "手动发送", "攒下一组连续操作，在时间线上点「发送」一起发出"),
    )

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(vm: AppViewModel) {
    val state by vm.snapshot.collectAsStateWithLifecycle()
    val cleaning by vm.cleaning.collectAsStateWithLifecycle()
    var name by remember { mutableStateOf(state.deviceName) }
    var mode by remember { mutableStateOf(state.sendMode) }
    var confirm by remember { mutableStateOf(false) }
    val dirty = name.trim() != state.deviceName || mode != state.sendMode
    val valid = name.isNotBlank()
    val colors = MaterialTheme.colorScheme
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("设置") },
                navigationIcon = {
                    IconButton(onClick = { vm.screen.value = Screen.Home }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回")
                    }
                },
                actions = {
                    TextButton(
                        onClick = { vm.saveSettings(name.trim(), mode) },
                        enabled = dirty && valid && !cleaning,
                    ) {
                        Text("保存")
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(LocalSnackbar.current) },
    ) { padding ->
        Column(
            Modifier.fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            SectionLabel("连接")
            Group {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Info("服务器", vm.deployment?.server.orEmpty())
                    Info(
                        "账户",
                        when (val pairing = state.pairing) {
                            is Pairing.Paired -> pairing.username
                            is Pairing.Pairing -> "等待确认"
                            is Pairing.Unpaired -> "未配对"
                            Pairing.Revoked -> "已被移除"
                        },
                    )
                    Info("设备标识", state.device.id, mono = true)
                    OutlinedTextField(
                        name,
                        { name = it },
                        Modifier.fillMaxWidth().padding(top = 4.dp),
                        label = { Text("设备名") },
                        supportingText = { Text("显示在 RemoteKit 的设备列表里") },
                        isError = !valid,
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    )
                }
            }

            SectionLabel("发送方式")
            Group {
                Column(Modifier.selectableGroup().padding(vertical = 6.dp)) {
                    modes.forEach { option ->
                        Row(
                            Modifier.fillMaxWidth()
                                .selectable(
                                    selected = mode == option.mode,
                                    onClick = { mode = option.mode },
                                    role = Role.RadioButton,
                                )
                                .padding(horizontal = 8.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = mode == option.mode, onClick = null)
                            Spacer(Modifier.width(8.dp))
                            Column(Modifier.weight(1f)) {
                                Text(option.title, style = MaterialTheme.typography.bodyLarge)
                                Text(
                                    option.detail,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = colors.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
            Text(
                "同一时间段的操作合并成一封邮件，按顺序到达。RemoteKit 的回信也会合并。",
                Modifier.padding(horizontal = 4.dp),
                style = MaterialTheme.typography.bodySmall,
                color = colors.onSurfaceVariant,
            )

            SectionLabel("数据", Modifier.padding(top = 8.dp))
            Group {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        "删除这台手机上的全部记录和未发送的登录数据，并更换设备密钥。之后需要重新配对。",
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.onSurfaceVariant,
                    )
                    OutlinedButton(
                        onClick = { confirm = true },
                        enabled = !cleaning,
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.error),
                        border = ButtonDefaults.outlinedButtonBorder(enabled = !cleaning).copy(
                            brush = androidx.compose.ui.graphics.SolidColor(colors.error.copy(alpha = 0.5f))
                        ),
                    ) {
                        Text(if (cleaning) "正在清除…" else "解除配对并清除数据")
                    }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
    if (confirm)
        ConfirmDialog(
            title = "解除配对并清除数据？",
            text = "删除本机全部请求和登录数据，更换设备密钥。继续使用需要在 RemoteKit 重新开启配对。",
            confirm = "清除",
            destructive = true,
            onDismiss = { confirm = false },
            onConfirm = {
                confirm = false
                vm.clearAll()
            },
        )
}

@Composable
private fun Group(content: @Composable () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = RoundedCornerShape(20.dp),
        modifier = Modifier.fillMaxWidth(),
        content = content,
    )
}

@Composable
private fun Info(label: String, value: String, mono: Boolean = false) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            label,
            Modifier.width(80.dp),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            fontFamily = if (mono) FontFamily.Monospace else null,
        )
    }
}
