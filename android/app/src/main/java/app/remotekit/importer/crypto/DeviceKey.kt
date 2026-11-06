package app.remotekit.importer.crypto

import app.remotekit.importer.deployment.sha256Hex
import java.security.SecureRandom
import org.bouncycastle.crypto.AsymmetricCipherKeyPair
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters

class DeviceKey(val privateKey: ByteArray) {
    private val parameters = X25519PrivateKeyParameters(privateKey)
    val publicKey: ByteArray = parameters.generatePublicKey().encoded
    val id: String = keyId(publicKey)
    val pair: AsymmetricCipherKeyPair
        get() = AsymmetricCipherKeyPair(parameters.generatePublicKey(), parameters)

    companion object {
        fun generate() = DeviceKey(X25519PrivateKeyParameters(SecureRandom()).encoded)

        fun keyId(publicKey: ByteArray) = sha256Hex(publicKey).take(16)
    }
}
