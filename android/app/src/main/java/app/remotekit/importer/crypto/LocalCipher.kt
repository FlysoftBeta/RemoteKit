package app.remotekit.importer.crypto

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class LocalCipher : BlobCipher {
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun key(): SecretKey =
        (keyStore.getKey(ALIAS, null) as SecretKey?)
            ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
                .apply {
                    init(
                        KeyGenParameterSpec.Builder(
                                ALIAS,
                                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                            )
                            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                            .setKeySize(256)
                            .build()
                    )
                }
                .generateKey()

    override fun encrypt(bytes: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        return cipher.iv + cipher.doFinal(bytes)
    }

    override fun decrypt(bytes: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            keyStore.getKey(ALIAS, null) as SecretKey,
            GCMParameterSpec(128, bytes.copyOfRange(0, 12)),
        )
        return cipher.doFinal(bytes.copyOfRange(12, bytes.size))
    }

    override fun deleteKey() {
        keyStore.deleteEntry(ALIAS)
    }

    private companion object {
        const val ALIAS = "rk_device_data"
    }
}

interface BlobCipher {
    fun encrypt(bytes: ByteArray): ByteArray

    fun decrypt(bytes: ByteArray): ByteArray

    fun deleteKey()
}
