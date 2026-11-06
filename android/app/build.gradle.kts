import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

val mailbox =
    Properties().apply {
        val source = rootProject.file("mailbox.properties")
        if (source.exists()) source.inputStream().use { load(it) }
    }

fun quoted(value: String): String =
    "\"" +
        value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r") +
        "\""

android {
    namespace = "app.remotekit.importer"
    compileSdk = 37
    buildToolsVersion = "37.0.0"
    defaultConfig {
        applicationId = "app.remotekit.importer"
        minSdk = 29
        targetSdk = 37
        versionCode = 1
        versionName = "1.0"
        for (key in listOf("host", "port", "security", "username", "password", "from")) {
            buildConfigField(
                "String",
                "SMTP_${key.uppercase()}",
                quoted(mailbox.getProperty("smtp.$key", "")),
            )
        }
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    packaging.resources.excludes +=
        setOf("META-INF/NOTICE*", "META-INF/LICENSE*", "META-INF/DEPENDENCIES")
    testOptions.unitTests.all {
        it.systemProperty(
            "fixture.path",
            rootProject.file("../protocol/session-import/envelope-fixture.json").absolutePath,
        )
    }
}

kotlin.compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.compose.ui)
    implementation(libs.compose.tooling.preview)
    implementation(libs.webkit)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.core)
    implementation(libs.camera.camera2)
    implementation(libs.camera.lifecycle)
    implementation(libs.camera.view)
    implementation(libs.zxing)
    implementation(libs.serialization)
    implementation(libs.coroutines)
    implementation(libs.bc)
    implementation(libs.mail)
    implementation(libs.activation)
    testImplementation(libs.junit)
}
