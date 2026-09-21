# Separate owner and device authority

Hush distinguishes owner authentication from routine device access. All user-initiated service mutations belong to the Web admin workflow: initializing the vault, editing secrets and profiles, registering and revoking devices, replacing the master-wrapped VEK, and publishing VEK rotations. CLI device sessions are read-only: they may fetch encrypted secrets, read profiles, and retrieve their own wrapped VEK, but may not retrieve the master-wrapped VEK or mutate vault state.

Cloudflare Access Service Tokens are provisioned manually, with a separate token per CLI device and an owner-managed binding to its Hush device. The service will not hold a Cloudflare account management token to provision these credentials. This adds a manual enrollment step but prevents a compromised routine device credential from automatically gaining recovery or administrative privileges.

The owner is identified by a deployment-configured email in a verified human Access identity. Device identity is derived from the verified service-token identity, not a caller-supplied device ID. The API enforces identity and authorization; a browser user agent is not proof of owner authority.

A CLI generates its keypair locally and exports public enrollment information. The owner uses the Web admin to register the public key, bind the manually provisioned service-token Client ID, and upload a client-generated device-wrapped VEK. CLI logout clears local credentials; remote revocation remains a Web admin operation. Server-generated audit and last-seen updates do not grant devices mutation privileges.
