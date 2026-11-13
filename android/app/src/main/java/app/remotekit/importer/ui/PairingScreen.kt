package app.remotekit.importer.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.remotekit.importer.store.Pairing

private const val CODE_WORDS = 5
private val separators = Regex("[\\s,，、.。-]+")

/** The words typed so far; the last one is still being typed unless followed by a separator. */
private class CodeInput(text: String, wordlist: Set<String>) {
    private val parts = text.lowercase().split(separators)
    val typing: String = parts.last()
    val words: List<String> = parts.filter(String::isNotEmpty)
    val complete = words.size == CODE_WORDS && words.all { it in wordlist }
    val suggestions: List<String> =
        if (typing.isEmpty() || typing in wordlist) emptyList()
        else wordlist.asSequence().filter { it.startsWith(typing) }.take(8).toList()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairingScreen(vm: AppViewModel) {
    val state by vm.snapshot.collectAsStateWithLifecycle()
    val cleaning by vm.cleaning.collectAsStateWithLifecycle()
    val wordlist = remember(vm) { vm.wordlist.toSet() }
    val focus = LocalFocusManager.current
    var code by remember { mutableStateOf(TextFieldValue()) }
    var username by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var visible by remember { mutableStateOf(false) }
    var device by rememberSaveable { mutableStateOf(state.deviceName) }
    var clearing by remember { mutableStateOf(false) }
    val revoked = state.pairing is Pairing.Revoked
    val reason = (state.pairing as? Pairing.Unpaired)?.reason
    val input = CodeInput(code.text, wordlist)
    val valid =
        input.complete &&
            username.codePointCount(0, username.length) in 1..64 &&
            password.codePointCount(0, password.length) in 1..256 &&
            device.isNotBlank() &&
            device.codePointCount(0, device.length) <= 64
    val submit = {
        if (valid && !revoked) {
            vm.pair(username.trim(), password, input.words, device.trim())
            password = ""
        }
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = {},
                actions = {
                    IconButton(onClick = { vm.navigate(Screen.Settings) }) {
                        Icon(Icons.Filled.Settings, "设置")
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(LocalSnackbar.current) },
    ) { padding ->
        Column(
            Modifier.fillMaxSize()
                .padding(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                IconBadge(
                    Icons.Filled.Lock,
                    56.dp,
                    MaterialTheme.colorScheme.primaryContainer,
                    MaterialTheme.colorScheme.onPrimaryContainer,
                )
                Text("连接到 RemoteKit", style = MaterialTheme.typography.headlineSmall)
                Surface(
                    shape = RoundedCornerShape(8.dp),
                    color = MaterialTheme.colorScheme.secondaryContainer,
                ) {
                    Text(
                        vm.deployment?.server.orEmpty(),
                        Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSecondaryContainer,
                    )
                }
                Text(
                    "配对一次后，这台手机就能直接把网站登录状态发给你的 RemoteKit，之后不用再输入密码。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (revoked)
                Notice(
                    "这台手机已被 RemoteKit 移除。清除本机数据后可以重新配对。",
                    action = "清除数据并重新配对",
                    enabled = !cleaning,
                    onAction = { clearing = true },
                )
            else if (reason != null) Notice(reason)
            StepHeader(1, "在 RemoteKit 打开配对", "设置 → 会话导入 → 设备，打开“允许配对新手机”。")
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                StepHeader(2, "输入配对码", "RemoteKit 显示的 5 个英文单词，可以整段粘贴。")
                OutlinedTextField(
                    code,
                    {
                        // Some IMEs commit Enter as text even in a single-line field.
                        if ('\n' in it.text) focus.moveFocus(FocusDirection.Down)
                        code = it.copy(text = it.text.replace('\n', ' ').lowercase())
                    },
                    Modifier.fillMaxWidth(),
                    placeholder = { Text("例如 apple river …") },
                    singleLine = true,
                    isError = input.words.size > CODE_WORDS,
                    supportingText = {
                        Text(
                            when {
                                input.words.size > CODE_WORDS -> "配对码只有 5 个单词"
                                input.complete -> "配对码完整"
                                else -> "已输入 ${input.words.count { it in wordlist }} / 5 个单词"
                            }
                        )
                    },
                    textStyle = LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace),
                    keyboardOptions =
                        KeyboardOptions(
                            capitalization = KeyboardCapitalization.None,
                            autoCorrectEnabled = false,
                            keyboardType = KeyboardType.Password,
                            imeAction = ImeAction.Next,
                        ),
                    visualTransformation = VisualTransformation.None,
                    keyboardActions =
                        KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
                )
                CodeSlots(input.words, wordlist, typing = input.typing.isNotEmpty())
                if (input.suggestions.isNotEmpty())
                    Row(
                        Modifier.horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        input.suggestions.forEach { word ->
                            SuggestionChip(
                                onClick = {
                                    val text = code.text.dropLast(input.typing.length) + word + " "
                                    code = TextFieldValue(text, TextRange(text.length))
                                },
                                label = { Text(word, fontFamily = FontFamily.Monospace) },
                            )
                        }
                    }
            }
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                StepHeader(3, "确认 RemoteKit 账户", "只在配对时验证一次，不会保存在手机上。")
                OutlinedTextField(
                    username,
                    { username = it },
                    Modifier.fillMaxWidth(),
                    label = { Text("用户名") },
                    singleLine = true,
                    keyboardOptions =
                        KeyboardOptions(
                            capitalization = KeyboardCapitalization.None,
                            autoCorrectEnabled = false,
                            keyboardType = KeyboardType.Email,
                            imeAction = ImeAction.Next,
                        ),
                    keyboardActions =
                        KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
                )
                OutlinedTextField(
                    password,
                    { password = it },
                    Modifier.fillMaxWidth(),
                    label = { Text("密码") },
                    singleLine = true,
                    visualTransformation =
                        if (visible) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions =
                        KeyboardOptions(
                            keyboardType = KeyboardType.Password,
                            imeAction = ImeAction.Next,
                        ),
                    keyboardActions =
                        KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
                    trailingIcon = {
                        TextButton(onClick = { visible = !visible }) {
                            Text(if (visible) "隐藏" else "显示")
                        }
                    },
                )
                OutlinedTextField(
                    device,
                    { device = it },
                    Modifier.fillMaxWidth(),
                    label = { Text("设备名") },
                    supportingText = { Text("显示在 RemoteKit 的设备列表里") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { submit() }),
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = submit,
                    enabled = valid && !revoked,
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                ) {
                    Text("发送配对请求")
                }
                Text(
                    "请求经邮件送达 RemoteKit。发出后就可以开始登录网站，导入请求会和配对请求一起处理。",
                    Modifier.fillMaxWidth(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
    if (clearing)
        ConfirmDialog(
            "清除数据并重新配对",
            "将删除这台手机上的所有请求记录并生成新的设备密钥。",
            confirm = "清除",
            destructive = true,
            onDismiss = { clearing = false },
            onConfirm = {
                clearing = false
                vm.clearAll()
            },
        )
}

@Composable
private fun CodeSlots(words: List<String>, wordlist: Set<String>, typing: Boolean) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        repeat(CODE_WORDS) { index ->
            val word = words.getOrNull(index)
            val known = word != null && word in wordlist
            val pending = typing && index == words.lastIndex && !known
            val colors = MaterialTheme.colorScheme
            Surface(
                Modifier.weight(1f).height(36.dp),
                shape = RoundedCornerShape(8.dp),
                color =
                    when {
                        word == null || pending -> colors.surfaceContainerHigh
                        known -> colors.primaryContainer
                        else -> colors.errorContainer
                    },
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Text(
                        word ?: "${index + 1}",
                        style = MaterialTheme.typography.labelMedium,
                        fontFamily = FontFamily.Monospace,
                        fontWeight = if (word != null) FontWeight.SemiBold else FontWeight.Normal,
                        maxLines = 1,
                        color =
                            when {
                                word == null || pending -> colors.onSurfaceVariant
                                known -> colors.onPrimaryContainer
                                else -> colors.onErrorContainer
                            },
                    )
                }
            }
        }
    }
}

@Composable
private fun Notice(
    text: String,
    action: String? = null,
    enabled: Boolean = true,
    onAction: () -> Unit = {},
) {
    Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.errorContainer) {
        Column(
            Modifier.fillMaxWidth().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(
                    Icons.Filled.Warning,
                    null,
                    Modifier.size(20.dp),
                    tint = MaterialTheme.colorScheme.onErrorContainer,
                )
                Text(
                    text,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                )
            }
            if (action != null)
                FilledTonalButton(
                    onClick = onAction,
                    enabled = enabled,
                    modifier = Modifier.align(Alignment.End),
                ) {
                    Text(action)
                }
        }
    }
}
