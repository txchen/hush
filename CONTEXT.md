# Hush

Hush is a personal secret vault for developer and coding-agent workflows. Clients protect secret values before synchronizing them with the service.

## Language

**Owner**:
The human administrator of the vault, authorized to bootstrap and recover it and manage devices and key wrapping. Owner authority is distinct from a trusted device's routine access.

**Device Session**:
An authenticated session bound to a registered device, granting read-only access to encrypted vault content and that device's wrapped VEK. Possession of a device credential does not grant owner authority.

**Vault**:
The collection of secrets, profiles, and trusted devices belonging to the owner.

**Master Password**:
The user-held credential that enables vault recovery without an existing trusted device. It does not replace authentication to the service.

**Vault Encryption Key (VEK)**:
The random key that protects secret values in a vault. A new VEK defines a new key version.

**Key Encryption Key (KEK)**:
The key derived locally from the master password to protect the VEK.

**Master-Wrapped VEK**:
The encrypted copy of the VEK protected by the KEK for bootstrap and recovery.
_Avoid_: Stored master password

**Trusted Device**:
A registered client with its own private key and a device-wrapped VEK, allowing normal vault unlock without the master password.

**Device-Wrapped VEK**:
The encrypted copy of the VEK intended for a particular trusted device.

**Secret**:
A named confidential value whose plaintext is available only to clients.

**Profile**:
A named selection of secrets mapped to environment variable names for a command invocation.

**Soft Revoke**:
Withdrawal of a device's future service access. It cannot invalidate keys or plaintext already copied by that device.

**Hard Revoke**:
Device revocation combined with VEK rotation, excluding the revoked device from the new key version. It cannot retract previously disclosed secrets.

**VEK Rotation**:
Replacement of the VEK together with re-encryption of secrets and replacement of wrapped keys for the remaining trusted devices.

**Audit Event**:
A record of a service-observed operation. Fetching ciphertext does not establish that a secret was decrypted or viewed.
