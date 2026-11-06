package app.remotekit.importer.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.SystemClock
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import app.remotekit.importer.R
import com.google.zxing.BinaryBitmap
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScanScreen(vm: AppViewModel) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    var granted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED
        )
    }
    var requested by remember { mutableStateOf(false) }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME)
                granted =
                    ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                        PackageManager.PERMISSION_GRANTED
        }
        lifecycle.lifecycle.addObserver(observer)
        onDispose { lifecycle.lifecycle.removeObserver(observer) }
    }
    val permission =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
            granted = it
            requested = true
        }
    BackHandler { vm.screen.value = Screen.Home }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.scan_pair)) },
                navigationIcon = {
                    TextButton(onClick = { vm.screen.value = Screen.Home }) {
                        Text(stringResource(R.string.back))
                    }
                },
            )
        }
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            if (granted) {
                Text(stringResource(R.string.scan_hint), Modifier.padding(16.dp))
                CameraPreview(
                    Modifier.weight(1f).fillMaxWidth(),
                    onCode = vm::pair,
                    onError = vm::notify,
                )
            } else {
                Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Text(stringResource(R.string.camera_rationale))
                    Button(onClick = { permission.launch(Manifest.permission.CAMERA) }) {
                        Text(stringResource(R.string.camera_allow))
                    }
                    if (requested)
                        TextButton(
                            onClick = {
                                context.startActivity(
                                    Intent(
                                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                        Uri.parse("package:${context.packageName}"),
                                    )
                                )
                            }
                        ) {
                            Text(stringResource(R.string.camera_settings))
                        }
                }
            }
        }
    }
}

@Composable
private fun CameraPreview(
    modifier: Modifier,
    onCode: (String) -> Boolean,
    onError: (String) -> Unit,
) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    val previewView = remember { PreviewView(context) }
    val currentOnCode by rememberUpdatedState(onCode)
    val currentOnError by rememberUpdatedState(onError)
    DisposableEffect(lifecycle) {
        val executor = Executors.newSingleThreadExecutor()
        val mainExecutor = ContextCompat.getMainExecutor(context)
        val active = AtomicBoolean(true)
        val processing = AtomicBoolean(false)
        val future = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null
        val analysis =
            ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
        val preview = Preview.Builder().build()
        var lastAttempt = 0L
        analysis.setAnalyzer(executor) { image ->
            try {
                val now = SystemClock.elapsedRealtime()
                if (active.get() && !processing.get() && now - lastAttempt >= 1500) {
                    val text = decodeQr(image)
                    if (text != null && processing.compareAndSet(false, true)) {
                        lastAttempt = now
                        mainExecutor.execute {
                            if (active.get()) {
                                if (!currentOnCode(text)) processing.set(false)
                            }
                        }
                    }
                }
            } finally {
                image.close()
            }
        }
        future.addListener(
            {
                if (active.get())
                    try {
                        provider = future.get()
                        preview.setSurfaceProvider(previewView.surfaceProvider)
                        provider!!.bindToLifecycle(
                            lifecycle,
                            CameraSelector.DEFAULT_BACK_CAMERA,
                            preview,
                            analysis,
                        )
                    } catch (error: Exception) {
                        currentOnError(error.message ?: context.getString(R.string.camera_error))
                    }
            },
            mainExecutor,
        )
        onDispose {
            active.set(false)
            analysis.clearAnalyzer()
            provider?.unbind(preview, analysis)
            executor.shutdown()
        }
    }
    AndroidView(factory = { previewView }, modifier = modifier)
}

private fun decodeQr(image: ImageProxy): String? {
    val plane = image.planes.first()
    val buffer = plane.buffer.duplicate()
    val base = buffer.position()
    val bytes = ByteArray(image.width * image.height)
    for (row in 0 until image.height) {
        for (column in 0 until image.width) {
            bytes[row * image.width + column] =
                buffer.get(base + row * plane.rowStride + column * plane.pixelStride)
        }
    }
    val source =
        PlanarYUVLuminanceSource(
            bytes,
            image.width,
            image.height,
            0,
            0,
            image.width,
            image.height,
            false,
        )
    val reader = QRCodeReader()
    return try {
        reader.decode(BinaryBitmap(HybridBinarizer(source))).text
    } catch (_: com.google.zxing.ReaderException) {
        null
    } finally {
        reader.reset()
    }
}
