package app.remotekit.importer.crypto

import org.bouncycastle.crypto.hpke.HPKE

object Hpke {
    val info: ByteArray
        get() = "RemoteKit session import v2".toByteArray(Charsets.UTF_8)

    fun suite() =
        HPKE(HPKE.mode_auth, HPKE.kem_X25519_SHA256, HPKE.kdf_HKDF_SHA256, HPKE.aead_AES_GCM256)
}
