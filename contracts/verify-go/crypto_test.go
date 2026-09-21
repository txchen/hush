package verify

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hpke"
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"golang.org/x/crypto/argon2"
)

func TestCrossLanguageVectors(t *testing.T) {
	raw, err := os.ReadFile("../fixtures/crypto-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]json.RawMessage
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	text := func(name string) string {
		var value string
		if err := json.Unmarshal(v[name], &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	decode := func(value string) []byte {
		out, err := base64.RawURLEncoding.DecodeString(value)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	envelope := func(name string) map[string]string {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(v[name], &fields); err != nil {
			t.Fatal(err)
		}
		result := make(map[string]string)
		for _, key := range []string{"nonce", "ciphertext", "enc"} {
			if value, ok := fields[key]; ok {
				var s string
				if err := json.Unmarshal(value, &s); err != nil {
					t.Fatal(err)
				}
				result[key] = s
			}
		}
		return result
	}
	aad := func(fields ...string) []byte { return []byte(strings.Join(fields, "\n")) }
	masterAAD := aad("hush", "1", "master", text("vault_id"), "1")
	secretAAD := aad("hush", "1", "secret", text("vault_id"), text("secret_id"), "1", "1")
	deviceAAD := aad("hush", "1", "device", text("vault_id"), text("device_id"), "1")
	for name, value := range map[string][]byte{"master_aad": masterAAD, "secret_aad": secretAAD, "device_aad": deviceAAD} {
		if !bytes.Equal(value, decode(text(name))) {
			t.Fatalf("AAD mismatch: %s", name)
		}
	}
	var kdf struct {
		Salt        string
		Memory      uint32 `json:"memory_kib"`
		Iterations  uint32
		Parallelism uint8
	}
	if err := json.Unmarshal(v["kdf"], &kdf); err != nil {
		t.Fatal(err)
	}
	kek := argon2.IDKey([]byte(text("password")), decode(kdf.Salt), kdf.Iterations, kdf.Memory, kdf.Parallelism, 32)
	if !bytes.Equal(kek, decode(text("kek"))) {
		t.Fatal("Argon2id mismatch")
	}
	open := func(key []byte, name string, aad []byte) ([]byte, error) {
		block, err := aes.NewCipher(key)
		if err != nil {
			t.Fatal(err)
		}
		gcm, err := cipher.NewGCM(block)
		if err != nil {
			t.Fatal(err)
		}
		e := envelope(name)
		return gcm.Open(nil, decode(e["nonce"]), decode(e["ciphertext"]), aad)
	}
	vek, err := open(kek, "master_wrap", masterAAD)
	if err != nil || !bytes.Equal(vek, decode(text("vek"))) {
		t.Fatalf("Master wrap mismatch: %v", err)
	}
	secret, err := open(vek, "secret", secretAAD)
	if err != nil || string(secret) != text("plaintext") {
		t.Fatalf("Secret mismatch: %v", err)
	}
	if _, err := open(vek, "secret", []byte("wrong-version")); err == nil {
		t.Fatal("Accepted wrong AAD")
	}
	private, err := ecdh.X25519().NewPrivateKey(decode(text("device_private_key")))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(private.PublicKey().Bytes(), decode(text("device_public_key"))) {
		t.Fatal("Device public key mismatch")
	}
	kemKey, err := hpke.NewDHKEMPrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	e := envelope("device_wrap")
	info := aad("hush", "1", "device-vek")
	recipient, err := hpke.NewRecipient(decode(e["enc"]), kemKey, hpke.HKDFSHA256(), hpke.AES256GCM(), info)
	if err != nil {
		t.Fatal(err)
	}
	deviceVEK, err := recipient.Open(deviceAAD, decode(e["ciphertext"]))
	if err != nil || !bytes.Equal(deviceVEK, vek) {
		t.Fatalf("HPKE mismatch: %v", err)
	}
	wrong, err := hpke.NewRecipient(decode(e["enc"]), kemKey, hpke.HKDFSHA256(), hpke.AES256GCM(), info)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wrong.Open([]byte("wrong-device"), decode(e["ciphertext"])); err == nil {
		t.Fatal("Accepted wrong HPKE AAD")
	}
}
